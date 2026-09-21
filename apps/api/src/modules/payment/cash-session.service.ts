import { Injectable } from '@nestjs/common';
import {
  CashMovementType,
  CashSessionStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { Clock } from '../../shared/time/clock.js';
import { formatSen } from '../billing/money.js';
import { AuditAction } from '../audit/audit.actions.js';
import { AuditService } from '../audit/audit.service.js';
import { DomainEvent } from '../events/domain-events.js';
import { EventBus } from '../events/event-bus.service.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * The drawer (PAY-F-01 … F-05).
 *
 * A cash session is the unit the clinic actually reconciles: somebody
 * opens it with a float in the morning, money goes in and out all day,
 * and somebody counts it in the evening. Everything else here exists to
 * make that count meaningful.
 *
 * The expected total is **never a running counter**. It is
 * `SUM(amount)` over the movements, computed when asked. A counter kept
 * alongside the movements is a second source of truth, and the moment
 * the two disagree neither is any use — which is precisely the
 * situation a cash reconciliation exists to detect.
 */
@Injectable()
export class CashSessionService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly settings: SettingsService,
  ) {}

  // ------------------------------------------------------------- open

  async open(
    ctx: TenantContext,
    branchId: string,
    input: { floatAmount: bigint; drawerCode?: string },
  ) {
    if (input.floatAmount < 0n) {
      throw new BadRequestError(
        'A float is money put in, not taken out.',
        'float_negative',
      );
    }
    const drawerCode =
      (input.drawerCode ?? 'MAIN').trim().toUpperCase() || 'MAIN';
    const tx = this.db.tx();

    const already = await tx.cashSession.findFirst({
      where: {
        branchId,
        drawerCode,
        status: { in: [CashSessionStatus.OPEN, CashSessionStatus.SUSPENDED] },
      },
    });
    if (already) {
      throw new ConflictError(
        `Drawer ${drawerCode} is already open. Close it before opening another.`,
        'session_already_open',
        { sessionId: already.id },
      );
    }

    const id = newId();
    const now = this.clock.now();
    await tx.cashSession.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId,
        drawerCode,
        status: CashSessionStatus.OPEN,
        openedBy: ctx.userId,
        openedAt: now,
        floatAmount: input.floatAmount,
      },
    });

    // The float is a movement like any other, so the expected total is
    // one sum rather than a sum plus a special case.
    await this.move(tx, ctx, id, {
      type: CashMovementType.FLOAT_IN,
      amount: input.floatAmount,
      reason: 'Opening float',
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.CashSessionOpened,
      entityType: 'cash_session',
      entityId: id,
      after: { drawerCode, floatAmount: input.floatAmount.toString() },
    });

    this.events.publish({
      name: DomainEvent.CashSessionOpened,
      tenantId: ctx.tenantId,
      branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        sessionId: id,
        drawerCode,
        floatSen: Number(input.floatAmount),
      },
    });

    return this.read(tx, id);
  }

  /** PAY-F-02: a break, not an end. */
  async suspend(ctx: TenantContext, sessionId: string) {
    return this.transition(ctx, sessionId, CashSessionStatus.SUSPENDED, [
      CashSessionStatus.OPEN,
    ]);
  }

  async resume(ctx: TenantContext, sessionId: string) {
    return this.transition(ctx, sessionId, CashSessionStatus.OPEN, [
      CashSessionStatus.SUSPENDED,
    ]);
  }

  private async transition(
    ctx: TenantContext,
    sessionId: string,
    to: CashSessionStatus,
    from: CashSessionStatus[],
  ) {
    const tx = this.db.tx();
    const session = await this.getOrThrow(tx, sessionId);
    if (!from.includes(session.status)) {
      throw new ConflictError(
        `A ${session.status.toLowerCase()} drawer cannot be ${to === CashSessionStatus.OPEN ? 'resumed' : 'suspended'}.`,
        'bad_session_status',
      );
    }
    await tx.cashSession.update({
      where: { id: sessionId },
      data: { status: to },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.CashSessionOpened,
      entityType: 'cash_session',
      entityId: sessionId,
      before: { status: session.status },
      after: { status: to },
    });
    return this.read(tx, sessionId);
  }

  // -------------------------------------------------------- movements

  /**
   * The single write path into a drawer.
   *
   * Every caller goes through here — the float, a payment, a void, a
   * drop to the safe — which is what makes PAY-R-08 a sum rather than a
   * list of places to remember.
   *
   * `amount` is signed: money in is positive, money out is negative.
   * One column rather than two, because two means somebody eventually
   * adds a withdrawal to the total instead of subtracting it.
   */
  async move(
    tx: Tx,
    ctx: TenantContext,
    sessionId: string,
    input: {
      type: CashMovementType;
      amount: bigint;
      reason?: string | null;
      referenceType?: string;
      referenceId?: string;
    },
  ): Promise<void> {
    await tx.cashSessionMovement.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        sessionId,
        type: input.type,
        amount: input.amount,
        reason: input.reason ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        performedBy: ctx.userId,
        performedName: ctx.userName,
        occurredAt: this.clock.now(),
      },
    });
  }

  /** PAY-F-04: money to the safe, or out for milk. */
  async recordMovement(
    ctx: TenantContext,
    sessionId: string,
    input: { type: CashMovementType; amount: bigint; reason: string },
  ) {
    if (
      input.type !== CashMovementType.CASH_DROP &&
      input.type !== CashMovementType.PETTY_OUT
    ) {
      throw new BadRequestError(
        'Only a cash drop or a petty-cash withdrawal is recorded by hand; ' +
          'everything else follows from a payment.',
        'movement_not_manual',
      );
    }
    if (input.amount <= 0n) {
      throw new BadRequestError(
        'Say how much left the drawer.',
        'amount_required',
      );
    }
    if ((input.reason ?? '').trim().length < 3) {
      throw new BadRequestError('Say what it was for.', 'reason_required');
    }

    const tx = this.db.tx();
    const session = await this.getOpen(tx, sessionId);

    // Taking more out than is in it is not a drop, it is a mistake.
    const expected = await this.expectedCash(tx, sessionId);
    if (input.amount > expected) {
      throw new ConflictError(
        `There is only ${formatSen(expected)} in the drawer.`,
        'insufficient_cash',
        { expectedSen: Number(expected) },
      );
    }

    await this.move(tx, ctx, sessionId, {
      type: input.type,
      // Out, so negative.
      amount: -input.amount,
      reason: input.reason.trim(),
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.CashMovementRecorded,
      entityType: 'cash_session',
      entityId: sessionId,
      reason: input.reason.trim(),
      after: { type: input.type, amount: input.amount.toString() },
    });

    void session;
    return this.read(tx, sessionId);
  }

  // ----------------------------------------------------------- totals

  /** PAY-R-08, as one sum over the movements. */
  async expectedCash(tx: Tx, sessionId: string): Promise<bigint> {
    const total = await tx.cashSessionMovement.aggregate({
      where: { sessionId },
      _sum: { amount: true },
    });
    return total._sum.amount ?? 0n;
  }

  /** What each method took, for the Z-report and PAY-R-09. */
  async totalsByMethod(
    tx: Tx,
    sessionId: string,
  ): Promise<Record<string, string>> {
    const rows = await tx.payment.groupBy({
      by: ['method'],
      where: { sessionId, status: PaymentStatus.POSTED },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.method] = (row._sum.amount ?? 0n).toString();
    }
    return out;
  }

  /** PAY §8: what the close will say, before anybody commits to it. */
  async previewClose(ctx: TenantContext, sessionId: string) {
    void ctx;
    const tx = this.db.tx();
    const session = await this.getOrThrow(tx, sessionId);
    const [expected, byMethod, counts] = await Promise.all([
      this.expectedCash(tx, sessionId),
      this.totalsByMethod(tx, sessionId),
      tx.payment.groupBy({
        by: ['status'],
        where: { sessionId },
        _count: { _all: true },
      }),
    ]);

    const settings = await this.settings.at(session.branchId);
    return {
      sessionId,
      status: session.status,
      drawerCode: session.drawerCode,
      openedAt: session.openedAt,
      floatSen: session.floatAmount.toString(),
      expectedCashSen: expected.toString(),
      expectedCash: formatSen(expected),
      totalsByMethod: byMethod,
      payments: Object.fromEntries(
        counts.map((row) => [row.status, row._count._all]),
      ),
      varianceApprovalSen: settings.billing.varianceApprovalSen,
    };
  }

  // ------------------------------------------------------------ close

  /**
   * PAY-F-03. The variance is recorded, never corrected.
   *
   * A drawer that is two ringgit light is two ringgit light. Adjusting
   * the expected figure to match the count would make every close
   * balance and the whole exercise pointless — the number the owner
   * wants is the difference, over time, per cashier.
   */
  async close(
    ctx: TenantContext,
    sessionId: string,
    input: {
      countedCash: bigint;
      denominations?: Record<string, number> | null;
      note?: string | null;
      approve?: boolean;
    },
  ) {
    if (input.countedCash < 0n) {
      throw new BadRequestError(
        'A count cannot be negative.',
        'counted_negative',
      );
    }

    const tx = this.db.tx();
    const session = await this.getOrThrow(tx, sessionId);
    if (session.status === CashSessionStatus.CLOSED) {
      throw new ConflictError(
        'That drawer is already closed.',
        'session_closed',
      );
    }

    const expected = await this.expectedCash(tx, sessionId);
    const variance = input.countedCash - expected;
    const settings = await this.settings.at(session.branchId);
    const threshold = BigInt(settings.billing.varianceApprovalSen);
    const magnitude = variance < 0n ? -variance : variance;

    if (magnitude > threshold) {
      // Over the line in either direction. A drawer that is *over* is as
      // much a problem as one that is short: it means something was not
      // recorded.
      if (!ctx.permissions.has('admin.settings') || input.approve !== true) {
        throw new ForbiddenError(
          `The drawer is out by ${formatSen(variance)}, which is more than ` +
            `${formatSen(threshold)}. An administrator has to approve this close.`,
          { varianceSen: Number(variance), thresholdSen: Number(threshold) },
        );
      }
      if ((input.note ?? '').trim().length < 3) {
        throw new BadRequestError(
          'Say what happened. A variance nobody explained is a variance nobody can learn from.',
          'note_required',
        );
      }
    }

    const now = this.clock.now();
    const byMethod = await this.totalsByMethod(tx, sessionId);

    await tx.cashSession.update({
      where: { id: sessionId },
      data: {
        status: CashSessionStatus.CLOSED,
        closedBy: ctx.userId,
        closedAt: now,
        expectedCash: expected,
        countedCash: input.countedCash,
        variance,
        denominations: (input.denominations ?? undefined) as object | undefined,
        varianceNote: input.note?.trim() ?? null,
        // PAY-R-09: frozen, so a later void cannot rewrite a Z-report
        // somebody has already printed and signed.
        totalsByMethod: byMethod as object,
        ...(magnitude > threshold
          ? { approvedBy: ctx.userId, approvedAt: now }
          : {}),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.CashSessionClosed,
      entityType: 'cash_session',
      entityId: sessionId,
      reason: input.note?.trim() ?? null,
      after: {
        expected: expected.toString(),
        counted: input.countedCash.toString(),
        variance: variance.toString(),
        totalsByMethod: byMethod,
        approved: magnitude > threshold,
      },
    });

    this.events.publish({
      name: DomainEvent.EodClosed,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        sessionId,
        expectedSen: Number(expected),
        countedSen: Number(input.countedCash),
        varianceSen: Number(variance),
      },
    });

    return this.read(tx, sessionId);
  }

  /**
   * §6: an administrator may reopen a session the same day.
   *
   * Only the same day, and it is recorded on the session itself rather
   * than only in the audit trail, so the Z-report can say it was
   * reopened. A report that silently disagrees with the copy somebody
   * printed at six o'clock is worse than no report.
   */
  async reopen(ctx: TenantContext, sessionId: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say why this is being reopened.',
        'reason_required',
      );
    }
    const tx = this.db.tx();
    const session = await this.getOrThrow(tx, sessionId);
    if (session.status !== CashSessionStatus.CLOSED) {
      throw new ConflictError(
        'That drawer is not closed.',
        'session_not_closed',
      );
    }
    if (!this.sameDay(session.closedAt ?? session.openedAt)) {
      throw new ConflictError(
        'A drawer can only be reopened on the day it was closed. Use a refund instead.',
        'not_same_day',
      );
    }

    const clash = await tx.cashSession.findFirst({
      where: {
        branchId: session.branchId,
        drawerCode: session.drawerCode,
        status: { in: [CashSessionStatus.OPEN, CashSessionStatus.SUSPENDED] },
      },
    });
    if (clash) {
      throw new ConflictError(
        `Drawer ${session.drawerCode} has been opened again since. Close that one first.`,
        'session_already_open',
        { sessionId: clash.id },
      );
    }

    const now = this.clock.now();
    await tx.cashSession.update({
      where: { id: sessionId },
      data: {
        status: CashSessionStatus.OPEN,
        closedAt: null,
        closedBy: null,
        expectedCash: null,
        countedCash: null,
        variance: null,
        reopenedBy: ctx.userId,
        reopenedAt: now,
        reopenedReason: reason.trim(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.CashSessionReopened,
      entityType: 'cash_session',
      entityId: sessionId,
      reason: reason.trim(),
      before: {
        expected: session.expectedCash?.toString() ?? null,
        counted: session.countedCash?.toString() ?? null,
        variance: session.variance?.toString() ?? null,
      },
    });

    this.events.publish({
      name: DomainEvent.CashSessionReopened,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { sessionId, reason: reason.trim() },
    });

    return this.read(tx, sessionId);
  }

  // ------------------------------------------------------------ reads

  /** PAY §14: the session a payment will attach to, or nothing. */
  async current(ctx: TenantContext, branchId: string, drawerCode = 'MAIN') {
    void ctx;
    const tx = this.db.tx();
    const session = await tx.cashSession.findFirst({
      where: {
        branchId,
        drawerCode: drawerCode.toUpperCase(),
        status: { in: [CashSessionStatus.OPEN, CashSessionStatus.SUSPENDED] },
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) return { session: null, expectedCashSen: null };
    return {
      session: await this.read(tx, session.id),
      expectedCashSen: (await this.expectedCash(tx, session.id)).toString(),
    };
  }

  async list(ctx: TenantContext, branchId: string, days: number) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.cashSession.findMany({
      where: { branchId, openedAt: { gte: this.clock.agoDays(days) } },
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
    return { items: rows.map((row) => this.present(row)) };
  }

  /** PAY-F-05: the sheet the owner reads at the end of the day. */
  async zReport(ctx: TenantContext, sessionId: string) {
    void ctx;
    const tx = this.db.tx();
    const session = await this.getOrThrow(tx, sessionId);

    const [movements, payments, expected] = await Promise.all([
      tx.cashSessionMovement.findMany({
        where: { sessionId },
        orderBy: { occurredAt: 'asc' },
      }),
      tx.payment.findMany({
        where: { sessionId },
        orderBy: { receivedAt: 'asc' },
        select: {
          id: true,
          receiptNo: true,
          method: true,
          amount: true,
          roundingApplied: true,
          status: true,
          receivedName: true,
          receivedAt: true,
        },
      }),
      this.expectedCash(tx, sessionId),
    ]);

    const posted = payments.filter((p) => p.status === PaymentStatus.POSTED);
    const voided = payments.filter((p) => p.status === PaymentStatus.VOIDED);

    // A closed session reports what was frozen at close; an open one
    // reports what is true now. Saying which is the whole point of
    // PAY-R-09.
    const byMethod =
      session.status === CashSessionStatus.CLOSED && session.totalsByMethod
        ? (session.totalsByMethod as Record<string, string>)
        : await this.totalsByMethod(tx, sessionId);

    return {
      session: this.present(session),
      asAtClose: session.status === CashSessionStatus.CLOSED,
      reopened: session.reopenedAt !== null,
      expectedCashSen: (session.expectedCash ?? expected).toString(),
      totalsByMethod: byMethod,
      collectedSen: posted.reduce((sum, p) => sum + p.amount, 0n).toString(),
      roundingSen: posted
        .reduce((sum, p) => sum + p.roundingApplied, 0n)
        .toString(),
      payments: posted.length,
      voids: voided.length,
      voidedSen: voided.reduce((sum, p) => sum + p.amount, 0n).toString(),
      movements: movements.map((row) => ({
        type: row.type,
        amount: row.amount.toString(),
        reason: row.reason,
        by: row.performedName,
        at: row.occurredAt,
      })),
      lines: payments.map((row) => ({
        receiptNo: row.receiptNo,
        method: row.method,
        amount: row.amount.toString(),
        status: row.status,
        by: row.receivedName,
        at: row.receivedAt,
      })),
    };
  }

  // -------------------------------------------------------- internals

  /** PAY-R-04. The one place that decides a payment may be taken. */
  async getOpen(tx: Tx, sessionId: string) {
    const session = await this.getOrThrow(tx, sessionId);
    if (session.status !== CashSessionStatus.OPEN) {
      throw new ConflictError(
        session.status === CashSessionStatus.CLOSED
          ? 'That drawer is closed. Reopen it, or open a new one.'
          : 'That drawer is suspended. Resume it first.',
        'session_not_open',
      );
    }
    return session;
  }

  /** PAY-F-01, §14: no session, no payment — and say which branch. */
  async requireOpenForBranch(tx: Tx, branchId: string, drawerCode = 'MAIN') {
    const session = await tx.cashSession.findFirst({
      where: {
        branchId,
        drawerCode: drawerCode.toUpperCase(),
        status: CashSessionStatus.OPEN,
      },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) {
      throw new ConflictError(
        'No drawer is open at this branch. Open one with its float before taking money.',
        'session_required',
        { branchId, drawerCode },
      );
    }
    return session;
  }

  async getOrThrow(tx: Tx, sessionId: string) {
    const session = await tx.cashSession.findFirst({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundError('Cash session');
    return session;
  }

  private async read(tx: Tx, sessionId: string) {
    return this.present(
      await tx.cashSession.findFirstOrThrow({ where: { id: sessionId } }),
    );
  }

  private sameDay(when: Date): boolean {
    const now = this.clock.now();
    return (
      when.getUTCFullYear() === now.getUTCFullYear() &&
      when.getUTCMonth() === now.getUTCMonth() &&
      when.getUTCDate() === now.getUTCDate()
    );
  }

  private present(row: {
    id: string;
    branchId: string;
    drawerCode: string;
    status: CashSessionStatus;
    openedBy: string;
    openedAt: Date;
    floatAmount: bigint;
    closedBy: string | null;
    closedAt: Date | null;
    expectedCash: bigint | null;
    countedCash: bigint | null;
    variance: bigint | null;
    varianceNote: string | null;
    denominations: unknown;
    totalsByMethod: unknown;
    approvedBy: string | null;
    reopenedAt: Date | null;
    reopenedReason: string | null;
  }) {
    return {
      id: row.id,
      branchId: row.branchId,
      drawerCode: row.drawerCode,
      status: row.status,
      openedBy: row.openedBy,
      openedAt: row.openedAt,
      floatSen: row.floatAmount.toString(),
      float: formatSen(row.floatAmount),
      closedBy: row.closedBy,
      closedAt: row.closedAt,
      expectedCashSen: row.expectedCash?.toString() ?? null,
      countedCashSen: row.countedCash?.toString() ?? null,
      varianceSen: row.variance?.toString() ?? null,
      variance: row.variance === null ? null : formatSen(row.variance),
      varianceNote: row.varianceNote,
      denominations: row.denominations ?? null,
      totalsByMethod: row.totalsByMethod ?? null,
      approvedBy: row.approvedBy,
      reopenedAt: row.reopenedAt,
      reopenedReason: row.reopenedReason,
    };
  }
}

/** Methods that put notes and coins in the drawer. Only one, today. */
export const CASH_METHODS: ReadonlySet<PaymentMethod> = new Set([
  PaymentMethod.CASH,
]);
