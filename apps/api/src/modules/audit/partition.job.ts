import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../shared/prisma/db.service.js';

/**
 * AUD-F-14, AUD-N-04: next month's partition exists before next month.
 *
 * Partition maintenance is the failure mode of every partitioned table:
 * it works for years and then one night a row has nowhere to go. Here
 * that row is an audit entry, and an audit entry that cannot be written
 * rolls back the change it was describing (§14) — so a missed cron would
 * stop a doctor signing a note.
 *
 * Two things stop that. The job runs daily and creates three months
 * ahead, so it has to fail roughly ninety times in a row to matter. And
 * the table has a DEFAULT partition, so even then the write lands
 * somewhere and this job reports it loudly the next morning rather than
 * the clinic discovering it.
 */
@Injectable()
export class AuditPartitionJob {
  private readonly logger = new Logger(AuditPartitionJob.name);

  /** Months created ahead of the current one. */
  private static readonly AHEAD = 3;

  constructor(private readonly db: DbService) {}

  @Cron('30 19 * * *', { name: 'audit-partitions' }) // 03:30 Asia/Kuala_Lumpur
  async run(): Promise<{ ensured: string[]; unclaimed: number }> {
    const ensured: string[] = [];

    await this.db.withPlatform(
      'maintain the audit log partitions',
      async (tx) => {
        for (let month = 0; month <= AuditPartitionJob.AHEAD; month += 1) {
          const rows = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT audit_log_ensure_partition(
            (date_trunc('month', now()) + make_interval(months => ${month}))::date
          ) AS name
        `;
          if (rows[0]?.name) ensured.push(rows[0].name);
        }
      },
    );

    // Anything here arrived when its month had no home. The rows are
    // safe and queryable; what is broken is the maintenance, and moving
    // them out later needs a change window, so it wants saying early.
    //
    // Through a function rather than a `SELECT count(*)`, because each
    // partition carries its own row-level security: a platform-scope
    // query has no tenant and would count zero however many were
    // stranded. The function is SECURITY DEFINER and returns a number
    // and never a row.
    const unclaimed = await this.db.withPlatform(
      'count unclaimed audit rows',
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT audit_log_unclaimed_count() AS count
      `;
        return Number(rows[0]?.count ?? 0n);
      },
    );

    if (unclaimed > 0) {
      this.logger.error(
        `AUDIT PARTITION GAP: ${unclaimed} entr${unclaimed === 1 ? 'y is' : 'ies are'} in ` +
          'audit_log_unclaimed, which means a month went by without a partition. ' +
          'Nothing is lost. Move them in a change window.',
      );
    } else {
      this.logger.log(`audit partitions: ${ensured.join(', ')}`);
    }

    return { ensured, unclaimed };
  }
}
