import { Module, type OnModuleInit } from '@nestjs/common';
import { BranchDeactivationRegistry } from '../tenancy/branch-deactivation.registry.js';
import { SettingsChangeRegistry } from '../tenancy/settings-change.registry.js';
import {
  OPEN_STATUSES,
  STATION_STATUSES,
  stationsFor,
} from './transitions.js';
import { EncounterStatus } from '../../generated/prisma/enums.js';
import { EncountersController } from './encounters.controller.js';
import { DisplayController } from './display.controller.js';
import {
  EncounterService,
  EncounterCompletionRegistry,
} from './encounter.service.js';
import { QueueService } from './queue.service.js';
import { QueueNumberService } from './queue-number.service.js';
import { QueueStreamService } from './queue-stream.service.js';
import { DisplayService } from './display.service.js';

/**
 * Encounter & Queue (ENC, v0-04-encounter-queue.md).
 *
 * Exported whole, because every clinical module after this one hangs off an
 * encounter: triage records vitals against one, the consultation belongs to
 * one, the invoice is for one.
 */
@Module({
  controllers: [EncountersController, DisplayController],
  providers: [
    EncounterService,
    EncounterCompletionRegistry,
    QueueService,
    QueueNumberService,
    QueueStreamService,
    DisplayService,
  ],
  exports: [
    EncounterService,
    EncounterCompletionRegistry,
    QueueService,
    QueueStreamService,
    DisplayService,
  ],
})
export class EncounterModule implements OnModuleInit {
  constructor(
    private readonly deactivation: BranchDeactivationRegistry,
    private readonly settingsChanges: SettingsChangeRegistry,
  ) {}

  /**
   * TEN-F-07: a branch with patients still in its queue cannot be closed.
   *
   * Tenancy owns the rule and has had nowhere to get the number from since
   * it was written; this is the module that knows. Registering it here
   * rather than having tenancy query `encounter` keeps the dependency
   * pointing the right way: encounter knows about branches, and branches
   * know nothing about encounters.
   */
  onModuleInit(): void {
    this.deactivation.add('open encounters', async (tx, branchId) => {
      const count = await tx.encounter.count({
        where: { branchId, status: { in: [...OPEN_STATUSES] } },
      });
      return count === 0
        ? null
        : {
            reason:
              count === 1
                ? 'patient still in the queue'
                : 'patients still in the queue',
            count,
          };
    });

    /**
     * ENC-F-26: a station cannot be switched off while people are in it.
     *
     * Turning triage off at three in the afternoon is a perfectly good
     * thing to want. Doing it while two patients are sitting in the
     * triage queue takes the nurse's screen away from under her: they
     * stay on the reception board, but the station that was looking
     * after them stops existing. So the change waits until they have
     * been moved on, and the message says who is in the way.
     */
    this.settingsChanges.add(
      'stations still in use',
      async (tx, before, after, branchId) => {
        /**
         * Which statuses still have a station watching them.
         *
         * Compared as *coverage* rather than as a list of station names,
         * because the names move around without anybody being stranded:
         * switching to a combined counter removes `pharmacy` and
         * `cashier` and replaces them with `counter`, which watches
         * exactly the same two queues. Nobody is left behind, and a
         * check that counted station names would refuse it anyway.
         *
         * `reception` is left out on purpose. It sees every open visit,
         * so counting it would mean nothing is ever stranded — and the
         * patient sitting in triage with no triage screen is precisely
         * what this is here to catch.
         */
        const covered = (settings: typeof before) => {
          const statuses = new Set<EncounterStatus>();
          for (const station of stationsFor({
            triageRequired: settings.queue.triageRequired,
            combinedCounter: settings.queue.combinedCounter,
            proceduresEnabled: settings.queue.proceduresEnabled,
          })) {
            if (station === 'reception') continue;
            for (const status of STATION_STATUSES[station]) statuses.add(status);
          }
          return statuses;
        };

        const kept = covered(after);
        const orphaned = [...covered(before)].filter(
          (status) => !kept.has(status) && OPEN_STATUSES.includes(status),
        );
        if (orphaned.length === 0) return [];

        const count = await tx.encounter.count({
          // A branch changing its own flow strands only its own
          // patients. A clinic-wide change reaches all of them.
          where: {
            status: { in: orphaned },
            ...(branchId ? { branchId } : {}),
          },
        });
        if (count === 0) return [];

        const where = orphaned
          .map((status) => STATUS_TITLE[status])
          .filter((title, index, all) => all.indexOf(title) === index)
          .join(' or ');

        return [
          {
            reason: 'station_in_use',
            detail:
              `${count} ${count === 1 ? 'patient is' : 'patients are'} ${where} ` +
              `right now. Move them on first, or they will be left on a board ` +
              `nobody is watching.`,
            count,
          },
        ];
      },
    );
  }
}

/** Where a patient in this status is standing, in an owner's words. */
const STATUS_TITLE: Partial<Record<EncounterStatus, string>> = {
  TRIAGE_WAITING: 'waiting for triage',
  TRIAGE_IN_PROGRESS: 'in triage',
  DOCTOR_WAITING: 'waiting for the doctor',
  IN_CONSULTATION: 'with the doctor',
  PROCEDURE_WAITING: 'waiting for a procedure',
  PHARMACY_WAITING: 'waiting for medicine',
  DISPENSING: 'at the pharmacy',
  PAYMENT_WAITING: 'waiting to pay',
};
