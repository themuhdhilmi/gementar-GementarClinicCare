import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';

/**
 * PAT-F-03: the number a patient is known by.
 *
 * Human-readable, because it is read aloud across a counter and written on a
 * specimen bottle. Per clinic company rather than per branch, because the
 * patient belongs to the company (PAT-R-08). Immutable and never reused, even
 * after a merge or a deletion, because it will have been written on paper
 * that outlives the record (PAT-R-02).
 *
 * Gaps are fine. A number burned by an abandoned registration is cheaper than
 * the contention of guaranteeing a dense sequence, and nobody audits patient
 * numbers for completeness.
 */
@Injectable()
export class MrnService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Takes the next number, holding a row lock for the rest of the transaction.
   *
   * Two receptionists registering at the same moment is the ordinary case, not
   * the exotic one, so this is a lock rather than a read-then-write. A
   * PostgreSQL sequence cannot be used: the counter is per tenant, and a
   * sequence is per database.
   */
  async next(): Promise<string> {
    const tx = this.db.tx();
    const tenantId = requireTenantId();
    const { mrnPrefix, mrnDigits } = await this.settings.group('', 'patient');

    const [row] = await tx.$queryRawUnsafe<Array<{ next: number }>>(
      'SELECT next FROM mrn_sequence WHERE tenant_id = $1::uuid FOR UPDATE',
      tenantId,
    );

    let value: number;
    if (row) {
      value = row.next;
      await tx.mrnSequence.update({ where: { tenantId }, data: { next: value + 1 } });
    } else {
      // First patient for this clinic. A concurrent insert loses the race on
      // the primary key rather than issuing the same number twice.
      value = 1;
      await tx.mrnSequence.create({ data: { tenantId, next: 2 } });
    }

    const prefix = mrnPrefix ? `${mrnPrefix}-` : '';
    return `${prefix}${String(value).padStart(mrnDigits, '0')}`;
  }

  /**
   * Moves the counter past a number that already exists, for an import that
   * brings the clinic's old numbering with it (PAT-Q-05).
   */
  async reserveAtLeast(nextValue: number): Promise<void> {
    const tx = this.db.tx();
    const tenantId = requireTenantId();
    const existing = await tx.mrnSequence.findFirst({ where: { tenantId } });
    if (!existing) {
      await tx.mrnSequence.create({ data: { tenantId, next: nextValue } });
      return;
    }
    if (existing.next < nextValue) {
      await tx.mrnSequence.update({ where: { tenantId }, data: { next: nextValue } });
    }
  }
}
