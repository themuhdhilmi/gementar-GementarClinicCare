import { Injectable } from '@nestjs/common';
import { FeeTimeBand } from '../../generated/prisma/enums.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { formatSen, ringgitToSen } from './money.js';

export type FeeMatch = {
  feeSen: bigint;
  taxCode: string;
  /** Which rule decided it, recorded on the line so it can be explained. */
  rule: string;
};

export type FeeScheduleInput = {
  branchId?: string | null;
  encounterType?: string | null;
  doctorId?: string | null;
  timeBand?: FeeTimeBand;
  /** Ringgit, as typed. */
  fee: number | string;
  taxCode?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  priority?: number;
};

/**
 * BIL-F-05: what a consultation costs.
 *
 * A clinic charges differently for a walk-in and a follow-up, after
 * hours, and sometimes for one particular doctor. Rather than a
 * decision tree somebody has to edit, the schedule is a list of rules
 * and the most specific match wins — the same shape a firewall or a
 * routing table uses, because it is the shape that stays
 * understandable when the tenth exception arrives.
 *
 * Specificity is counted, not ordered: a rule naming the doctor beats
 * one naming only the branch, whatever order they were entered in. The
 * `priority` column exists only to break a genuine tie.
 */
@Injectable()
export class FeeScheduleService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.feeSchedule.findMany({ orderBy: { createdAt: 'asc' } });
    return {
      items: rows.map((row) => ({
        id: row.id,
        branchId: row.branchId,
        encounterType: row.encounterType,
        doctorId: row.doctorId,
        timeBand: row.timeBand,
        fee: formatSen(row.fee),
        taxCode: row.taxCode,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        priority: row.priority,
        specificity: specificityOf(row),
      })),
    };
  }

  async create(ctx: TenantContext, input: FeeScheduleInput) {
    const tx = this.db.tx();
    const id = newId();
    await tx.feeSchedule.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: input.branchId ?? null,
        encounterType: input.encounterType ?? null,
        doctorId: input.doctorId ?? null,
        timeBand: input.timeBand ?? FeeTimeBand.ANY,
        fee: ringgitToSen(input.fee),
        taxCode: input.taxCode ?? 'NONE',
        effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : this.clock.now(),
        effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
        priority: input.priority ?? 0,
        createdBy: ctx.userId,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.FeeScheduleChanged,
      entityType: 'fee_schedule',
      entityId: id,
      after: { ...input, fee: String(input.fee) },
    });
    return this.list(ctx);
  }

  async remove(ctx: TenantContext, id: string) {
    const tx = this.db.tx();
    const row = await tx.feeSchedule.findFirst({ where: { id } });
    if (!row) throw new NotFoundError('Fee rule');
    await tx.feeSchedule.delete({ where: { id } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.FeeScheduleChanged,
      entityType: 'fee_schedule',
      entityId: id,
      before: { fee: formatSen(row.fee), encounterType: row.encounterType },
    });
    return this.list(ctx);
  }

  /**
   * The fee for one consultation.
   *
   * Returns null when the clinic has written no rule that matches,
   * which is different from a fee of zero: a clinic that has not set
   * its prices should see an invoice with no consultation line and
   * notice, rather than one that says the visit was free.
   */
  async resolve(
    tx: Tx,
    input: {
      branchId: string;
      encounterType: string | null;
      doctorId: string | null;
      at: Date;
      /** The branch's own clock, for deciding what counts as after hours. */
      timeBand?: FeeTimeBand;
    },
  ): Promise<FeeMatch | null> {
    const today = new Date(
      Date.UTC(input.at.getUTCFullYear(), input.at.getUTCMonth(), input.at.getUTCDate()),
    );

    const candidates = await tx.feeSchedule.findMany({
      where: {
        OR: [{ branchId: null }, { branchId: input.branchId }],
        effectiveFrom: { lte: today },
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] }],
      },
    });

    const band = input.timeBand ?? FeeTimeBand.ANY;
    const matching = candidates.filter(
      (rule) =>
        (rule.branchId === null || rule.branchId === input.branchId) &&
        (rule.encounterType === null || rule.encounterType === input.encounterType) &&
        (rule.doctorId === null || rule.doctorId === input.doctorId) &&
        (rule.timeBand === FeeTimeBand.ANY || rule.timeBand === band),
    );
    if (matching.length === 0) return null;

    matching.sort((a, b) => {
      const bySpecificity = specificityOf(b) - specificityOf(a);
      if (bySpecificity !== 0) return bySpecificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      // A rule written later is the more recent decision.
      return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    });

    const best = matching[0]!;
    return {
      feeSen: best.fee,
      taxCode: best.taxCode,
      rule: describe(best),
    };
  }
}

/**
 * How many things a rule pins down. A rule naming the doctor and the
 * time band beats one naming only the branch.
 *
 * The doctor is weighted above the encounter type because "Dr Farid
 * charges differently" is a stronger statement about this visit than
 * "follow-ups cost less" — and when a clinic writes both, they mean the
 * doctor's.
 */
function specificityOf(rule: {
  branchId: string | null;
  encounterType: string | null;
  doctorId: string | null;
  timeBand: FeeTimeBand;
}): number {
  return (
    (rule.doctorId ? 8 : 0) +
    (rule.encounterType ? 4 : 0) +
    (rule.timeBand !== FeeTimeBand.ANY ? 2 : 0) +
    (rule.branchId ? 1 : 0)
  );
}

/** `CONSULT:FOLLOW_UP:AFTER_HOURS:DOCTOR` — printed on the line. */
function describe(rule: {
  encounterType: string | null;
  doctorId: string | null;
  timeBand: FeeTimeBand;
}): string {
  return [
    'CONSULT',
    rule.encounterType ?? 'ANY',
    rule.timeBand,
    rule.doctorId ? 'DOCTOR' : 'ANYDOCTOR',
  ].join(':');
}

/** Which band a moment falls in, in the branch's own time. */
export function bandFor(localHour: number, localDay: number): FeeTimeBand {
  // Sunday is 0. A Malaysian GP clinic's weekend is Sunday; Saturday is
  // a working day, usually a short one. `WEEKEND` therefore means Sunday
  // unless the clinic says otherwise, which is BIL-OPEN territory.
  if (localDay === 0) return FeeTimeBand.WEEKEND;
  if (localHour >= 18 || localHour < 8) return FeeTimeBand.AFTER_HOURS;
  return FeeTimeBand.ANY;
}

export function assertTaxCode(code: string): void {
  if (!/^[A-Z0-9_]{1,20}$/.test(code)) {
    throw new BadRequestError(`"${code}" is not a tax code.`, 'invalid_tax_code');
  }
}
