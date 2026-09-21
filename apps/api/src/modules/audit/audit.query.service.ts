import { Injectable } from '@nestjs/common';
import {
  BadRequestError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { Clock } from '../../shared/time/clock.js';
import { toCsv } from '../../shared/csv/csv.js';
import { AUDIT_ACTION_GROUPS, AUDIT_ACTION_SET } from './audit.actions.js';

export type AuditFilter = {
  from?: Date;
  to?: Date;
  actorId?: string;
  action?: string;
  actionGroup?: string;
  entityType?: string;
  entityId?: string;
  patientId?: string;
  branchId?: string;
};

/** AUD §12. A year is long enough to answer a question and short enough to stay fast. */
const MAX_RANGE_DAYS = 366;
/** AUD §12 again, and lower: an export leaves the building. */
const MAX_EXPORT_DAYS = 92;

const SELECT = {
  id: true,
  action: true,
  actorId: true,
  actorName: true,
  actorRole: true,
  entityType: true,
  entityId: true,
  subjectPatientId: true,
  branchId: true,
  reason: true,
  ip: true,
  userAgent: true,
  requestId: true,
  diff: true,
  occurredAt: true,
} as const;

/**
 * Reading the trail (AUD-F-10 … F-13).
 *
 * Every query here is bounded by time, and not only for speed. The log
 * is partitioned by month (AUD-F-14), so a `from` and a `to` are what
 * let Postgres skip the partitions that cannot contain an answer. An
 * unbounded query would read every month the clinic has ever operated
 * to return twenty-five rows.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  /**
   * Turns a filter into a `where`, refusing the ones that would quietly
   * mislead: an unknown action returns nothing, which reads as "it never
   * happened" rather than "you asked for something nobody emits".
   */
  buildWhere(filter: AuditFilter, maxDays = MAX_RANGE_DAYS) {
    const to = filter.to ?? this.clock.now();
    const from = filter.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (from > to) {
      throw new BadRequestError(
        'That range starts after it ends.',
        'range_backwards',
      );
    }
    if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
      throw new BadRequestError(
        `Ask for at most ${maxDays} days at a time.`,
        'range_too_wide',
      );
    }
    if (filter.action && !AUDIT_ACTION_SET.has(filter.action)) {
      throw new BadRequestError(
        `Nothing in this system records '${filter.action}'.`,
        'unknown_action',
      );
    }

    const prefixes = filter.actionGroup
      ? AUDIT_ACTION_GROUPS[filter.actionGroup]
      : undefined;
    if (filter.actionGroup && !prefixes) {
      throw new BadRequestError(
        `There is no '${filter.actionGroup}' group.`,
        'unknown_group',
      );
    }

    return {
      where: {
        occurredAt: { gte: from, lte: to },
        ...(filter.action ? { action: filter.action } : {}),
        ...(prefixes
          ? { OR: prefixes.map((p) => ({ action: { startsWith: p } })) }
          : {}),
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
        ...(filter.entityType ? { entityType: filter.entityType } : {}),
        ...(filter.entityId ? { entityId: filter.entityId } : {}),
        ...(filter.patientId ? { subjectPatientId: filter.patientId } : {}),
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
      },
      from,
      to,
    };
  }

  async search(tx: Tx, filter: AuditFilter, page: number, pageSize: number) {
    const { where, from, to } = this.buildWhere(filter);
    const [items, total] = await Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: SELECT,
      }),
      tx.auditLog.count({ where }),
    ]);
    return { items, total, from, to };
  }

  /** AUD-F-10: one entry, with both snapshots. */
  async byId(tx: Tx, id: string) {
    const entry = await tx.auditLog.findFirst({
      where: { id },
      select: { ...SELECT, before: true, after: true },
    });
    if (!entry) throw new NotFoundError('Audit entry');
    return entry;
  }

  /**
   * AUD-F-11: everyone who has touched this patient's records.
   *
   * This is the question a PDPA request actually asks, and the reason
   * `subject_patient_id` is denormalised onto every entry rather than
   * being joined out of `entity_id` — a consultation, a prescription and
   * a dispense all belong to a patient and none of them says so in a way
   * one index could cover.
   */
  async accessHistory(tx: Tx, patientId: string, days: number) {
    const to = this.clock.now();
    const from = new Date(
      to.getTime() - Math.min(days, MAX_RANGE_DAYS) * 86_400_000,
    );
    const items = await tx.auditLog.findMany({
      where: {
        subjectPatientId: patientId,
        occurredAt: { gte: from, lte: to },
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: SELECT,
    });
    return { items, from, to };
  }

  /** AUD-F-12: the six numbers an owner looks at. */
  async dashboard(tx: Tx) {
    const day = this.clock.agoDays(1);
    const week = this.clock.agoDays(7);

    const tile = async (where: object) => ({
      last24h: await tx.auditLog.count({
        where: { ...where, occurredAt: { gt: day } },
      }),
      last7d: await tx.auditLog.count({
        where: { ...where, occurredAt: { gt: week } },
      }),
    });

    const [breakGlass, failedLogins, voids, adjustments, discounts, unmasks] =
      await Promise.all([
        tile({ action: 'audit.break_glass' }),
        tile({ action: 'auth.login_failed' }),
        tile({
          action: {
            in: ['invoice.voided', 'procedure.voided', 'dispense.undone'],
          },
        }),
        tile({ action: { in: ['stock.adjusted', 'stock.count_approved'] } }),
        // Every discount is recorded; the ones worth a tile are the ones an
        // administrator had to approve (BIL-F-09).
        tile({ action: 'invoice.discounted', reason: { not: null } }),
        tile({ action: 'patient.id_unmasked' }),
      ]);

    return { breakGlass, failedLogins, voids, adjustments, discounts, unmasks };
  }

  /**
   * AUD-F-13: a filtered range as CSV.
   *
   * The export is audited by the caller, with the filter that produced
   * it — because "who took a copy of the audit trail, and of what" is
   * exactly the kind of question an audit trail exists to answer. It
   * also needs a fresh password (AUD §8): a copy of this file is a copy
   * of everybody's movements for three months.
   *
   * Snapshots are left out. A diff says what changed, which is what
   * somebody reading a spreadsheet wants; the full before-and-after of
   * ten thousand rows would be unreadable and would put clinical detail
   * into a file that leaves the building.
   */
  async exportCsv(tx: Tx, filter: AuditFilter, limit = 50_000) {
    const { where, from, to } = this.buildWhere(filter, MAX_EXPORT_DAYS);
    const rows = await tx.auditLog.findMany({
      where,
      orderBy: { occurredAt: 'asc' },
      take: limit,
      select: SELECT,
    });

    const header = [
      'occurred_at',
      'action',
      'actor_name',
      'actor_role',
      'entity_type',
      'entity_id',
      'patient_id',
      'branch_id',
      'reason',
      'ip',
      'request_id',
      'changed_fields',
    ];
    const csv = toCsv(
      header,
      rows.map((row) => [
        row.occurredAt,
        row.action,
        row.actorName,
        row.actorRole,
        row.entityType,
        row.entityId,
        row.subjectPatientId,
        row.branchId,
        row.reason,
        row.ip,
        row.requestId,
        row.diff && typeof row.diff === 'object' ? Object.keys(row.diff).join(' ') : '',
      ]),
    );

    return { csv, rows: rows.length, from, to, truncated: rows.length === limit };
  }

  static readonly MAX_EXPORT_DAYS = MAX_EXPORT_DAYS;
  static readonly MAX_RANGE_DAYS = MAX_RANGE_DAYS;
}
