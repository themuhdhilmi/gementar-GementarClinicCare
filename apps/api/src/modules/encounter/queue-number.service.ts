import { Injectable } from '@nestjs/common';
import { EncounterPriority } from '../../generated/prisma/enums.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';

/**
 * ENC-F-02, ENC-R-05: the two numbers a visit carries.
 *
 * The **queue number** is `A-017`: short, said out loud across a waiting
 * room, and restarted every morning because that is what a patient expects
 * of a queue number.
 *
 * The **encounter number** is `KL01-20260920-017`: unique for all time,
 * which is what a document or an invoice has to reference.
 *
 * Both come from one counter per branch per day, taken under a row lock.
 * Fifty receptionists checking in at once must get fifty different numbers,
 * and that is the whole reason this is not a read followed by a write.
 */
@Injectable()
export class QueueNumberService {
  /** The one numbering series a branch runs per day. See `allocate`. */
  static readonly SERIES = '*';

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The clinic's own day.
   *
   * Not UTC. A clinic open until 10pm in Kuala Lumpur would otherwise see
   * its queue numbers restart in the middle of the evening, which is the
   * kind of bug that is obvious on the day and invisible in a test written
   * in January.
   */
  static clinicDay(now: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /**
   * One counter per branch per day, and two numbers from it.
   *
   * The counter is shared across priorities on purpose. An earlier version
   * gave emergencies their own series, and the first emergency of the day
   * collided with the first ordinary patient: both were the 001st visit, and
   * the encounter number is unique per branch per day. One count of visits,
   * displayed with a letter, has neither problem.
   *
   * The letter is display only. An emergency is called as `E-013` so that
   * nobody at the counter mistakes it for a routine turn, and it reaches the
   * front of the queue because of its priority, not its prefix.
   *
   * `SERIES` is the sequence's key. There is one series per day today; the
   * column exists so a clinic could later run separate numbering per
   * priority, which would also mean putting the letter into the encounter
   * number to keep it unique.
   */
  async allocate(
    branchId: string,
    branchCode: string,
    timezone: string,
    priority: EncounterPriority,
    now: Date,
  ): Promise<{ queueNo: string; encounterNo: string; day: string; sequence: number }> {
    const tx = this.db.tx();
    const tenantId = requireTenantId();
    const day = QueueNumberService.clinicDay(now, timezone);

    const { numberPrefix } = await this.settings.group(branchId, 'queue');
    const letter = priority === EncounterPriority.EMERGENCY ? 'E' : numberPrefix || 'A';

    // The lock is the point. Two receptionists pressing check-in at the same
    // moment is the ordinary case in a busy clinic, not a rare race.
    const [existing] = await tx.$queryRawUnsafe<Array<{ next: number }>>(
      `SELECT next FROM queue_sequence
        WHERE tenant_id = $1::uuid AND branch_id = $2::uuid AND day = $3::date AND prefix = $4
        FOR UPDATE`,
      tenantId,
      branchId,
      day,
      QueueNumberService.SERIES,
    );

    let sequence: number;
    if (existing) {
      sequence = existing.next;
      await tx.$executeRawUnsafe(
        `UPDATE queue_sequence SET next = next + 1
          WHERE tenant_id = $1::uuid AND branch_id = $2::uuid AND day = $3::date AND prefix = $4`,
        tenantId,
        branchId,
        day,
        QueueNumberService.SERIES,
      );
    } else {
      sequence = 1;
      // A concurrent insert loses on the primary key rather than issuing the
      // same number twice; the caller's transaction retries the whole
      // check-in, which is cheap and correct.
      await tx.queueSequence.create({
        data: {
          tenantId,
          branchId,
          day: new Date(`${day}T00:00:00.000Z`),
          prefix: QueueNumberService.SERIES,
          next: 2,
        },
      });
    }

    const padded = String(sequence).padStart(3, '0');
    return {
      queueNo: `${letter}-${padded}`,
      encounterNo: `${branchCode}-${day.replaceAll('-', '')}-${padded}`,
      day,
      sequence,
    };
  }
}
