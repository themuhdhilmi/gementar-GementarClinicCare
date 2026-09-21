import { Module, type OnModuleInit } from '@nestjs/common';
import { BranchDeactivationRegistry } from '../tenancy/branch-deactivation.registry.js';
import { OPEN_STATUSES } from './transitions.js';
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
  constructor(private readonly deactivation: BranchDeactivationRegistry) {}

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
  }
}
