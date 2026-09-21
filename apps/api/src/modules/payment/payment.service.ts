import { Injectable } from '@nestjs/common';
import {
  CashMovementType,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
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
import { CashSessionService } from './cash-session.service.js';
import { changeFrom, planLeg, tenderSuggestions } from './rounding.js';

export type TakePaymentInput = {
  method: PaymentMethod;
  /** Ringgit as typed, in sen. Null means "the rest of it". */
  amountSen: bigint | null;
  tenderedSen?: bigint | null;
  reference?: string | null;
  cardBrand?: string | null;
  idempotencyKey: string;
  drawerCode?: string;
};

/**
 * Taking the money (PAY-F-06 … F-18).
 *
 * Three properties hold together and none of them is optional.
 *
 * **`invoice.amount_paid` is always the sum of posted payments**
 * (PAY-R-01). It is recomputed from the payments on every write rather
 * than incremented, for the same reason billing recomputes an invoice
 * from its lines: a running total adjusted in five places is a total
 * that will one day disagree with the rows it claims to summarise, and
 * the disagreement will be found by an accountant rather than a test.
 *
 * **The receipt number is allocated inside the payment transaction**,
 * under the row lock on the series. Allocating it first and writing
 * later leaves a gap when the write fails; allocating it after leaves a
 * payment with no receipt.
 *
 * **Rounding happens once, on the leg that settles the bill.** All of
 * that lives in `rounding.ts`, which is a pure function with thirty
 * tests, and nothing here re-derives it.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly sessions: CashSessionService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------- preview

  /** What the screen shows before anybody presses anything (§11). */
  async preview(
    ctx: TenantContext,
    invoiceId: string,
    method: PaymentMethod,
    amountSen: bigint | null,
  ) {
    void ctx;
    const tx = this.db.tx();
    const invoice = await this.payableInvoice(tx, invoiceId);
    const outstanding = this.outstanding(invoice);
    const leg = planLeg(
      outstanding,
      method === PaymentMethod.CASH ? 'CASH' : 'OTHER',
      amountSen,
    );

    return {
      invoiceId,
      outstandingSen: outstanding.toString(),
      outstanding: formatSen(outstanding),
      method,
      dueSen: leg.amount.toString(),
      due: formatSen(leg.amount),
      roundingSen: leg.rounding.toString(),
      rounding: formatSen(leg.rounding),
      settles: leg.settles,
      balanceAfterSen: leg.balanceAfter.toString(),
      tenderSuggestions:
        method === PaymentMethod.CASH
          ? tenderSuggestions(leg.amount).map((value) => value.toString())
          : [],
    };
  }

  // ------------------------------------------------------------- take

  async take(ctx: TenantContext, invoiceId: string, input: TakePaymentInput) {
    const key = (input.idempotencyKey ?? '').trim();
    if (key.length < 8) {
      throw new BadRequestError(
        'Every payment needs an idempotency key, so a retry cannot take the money twice.',
        'idempotency_key_required',
      );
    }

    const tx = this.db.tx();

    // PAY-F-11. Checked first, so a retry never reaches the arithmetic
    // and never allocates a second receipt number.
    const already = await tx.payment.findFirst({
      where: { idempotencyKey: key },
    });
    if (already) return this.read(tx, already.id);

    const invoice = await this.payableInvoice(tx, invoiceId);
    const session = await this.sessions.requireOpenForBranch(
      tx,
      invoice.branchId,
      input.drawerCode ?? 'MAIN',
    );

    await this.assertMethodAllowed(
      tx,
      invoice.branchId,
      input.method,
      input.reference,
    );

    const outstanding = this.outstanding(invoice);
    if (outstanding <= 0n) {
      throw new ConflictError('That invoice is settled.', 'invoice_settled');
    }
    if (input.amountSen !== null && input.amountSen <= 0n) {
      throw new BadRequestError(
        'A payment is more than nothing.',
        'amount_invalid',
      );
    }

    const isCash = input.method === PaymentMethod.CASH;
    const leg = planLeg(
      outstanding,
      isCash ? 'CASH' : 'OTHER',
      input.amountSen,
    );

    // PAY-F-12. After rounding, because RM 77.45 against a RM 77.43
    // invoice is correct and is not an overpayment.
    if (input.amountSen !== null && input.amountSen > outstanding) {
      throw new ConflictError(
        `That is more than the ${formatSen(outstanding)} outstanding.`,
        'overpayment',
        { outstandingSen: Number(outstanding) },
      );
    }

    // PAY-F-08: partial payment is a clinic decision, not a given.
    if (!leg.settles) {
      const settings = await this.settings.at(invoice.branchId);
      if (!settings.billing.allowPartialPayment) {
        throw new ConflictError(
          'This clinic does not take part payments. The bill is settled in full or not at all.',
          'partial_not_allowed',
        );
      }
    }

    let tendered: bigint | null = null;
    let change: bigint | null = null;
    if (isCash) {
      tendered = input.tenderedSen ?? leg.amount;
      if (tendered < leg.amount) {
        throw new BadRequestError(
          `${formatSen(tendered)} does not cover ${formatSen(leg.amount)}.`,
          'tendered_short',
        );
      }
      change = changeFrom(tendered, leg.amount);
    }

    const now = this.clock.now();
    const id = newId();
    const number = await this.nextReceiptNumber(
      tx,
      invoice.branchId,
      now.getUTCFullYear(),
    );

    await tx.payment.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: invoice.branchId,
        invoiceId,
        sessionId: session.id,
        receiptNo: number.receiptNo,
        seriesYear: number.year,
        seriesSeq: number.seq,
        method: input.method,
        amount: leg.amount,
        tendered,
        changeGiven: change,
        roundingApplied: leg.rounding,
        reference: input.reference?.trim() || null,
        cardBrand: input.cardBrand?.trim() || null,
        status: PaymentStatus.POSTED,
        receivedBy: ctx.userId,
        receivedName: ctx.userName,
        receivedAt: now,
        idempotencyKey: key,
      },
    });

    // Only cash goes in the drawer. A card payment belongs to the
    // session for attribution and not to the count.
    if (isCash) {
      await this.sessions.move(tx, ctx, session.id, {
        type: CashMovementType.PAYMENT_IN,
        amount: leg.amount,
        referenceType: 'payment',
        referenceId: id,
        reason: `Receipt ${number.receiptNo}`,
      });
    }

    const settled = await this.resettle(tx, ctx, invoiceId, leg.rounding);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PaymentReceived,
      entityType: 'payment',
      entityId: id,
      subjectPatientId: invoice.patientId,
      after: {
        receiptNo: number.receiptNo,
        method: input.method,
        amount: leg.amount.toString(),
        rounding: leg.rounding.toString(),
        invoiceNo: invoice.invoiceNo,
        balanceAfter: settled.balance.toString(),
      },
    });

    this.events.publish({
      name: DomainEvent.PaymentReceived,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        paymentId: id,
        invoiceId,
        amountSen: Number(leg.amount),
        method: input.method,
        balanceAfterSen: Number(settled.balance),
      },
    });
    this.events.publish({
      name: DomainEvent.ReceiptIssued,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { paymentId: id, receiptNo: number.receiptNo },
    });

    return this.read(tx, id);
  }

  // ------------------------------------------------------------- void

  /**
   * PAY-F-17. Same day, open session, reason.
   *
   * A void is for a mistake made minutes ago — the cashier pressed CASH
   * when it was a card. Anything older is a refund, because the drawer
   * it came out of has been counted and signed for.
   */
  async void(ctx: TenantContext, paymentId: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say what happened, in a sentence.',
        'reason_required',
      );
    }

    const tx = this.db.tx();
    const payment = await tx.payment.findFirst({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError('Payment');
    if (payment.status === PaymentStatus.VOIDED) {
      throw new ConflictError(
        'That payment is already voided.',
        'already_voided',
      );
    }
    if (payment.amount < 0n) {
      throw new ConflictError(
        'A refund is not voided; it is a record of money given back.',
        'cannot_void_refund',
      );
    }
    if (!this.sameDay(payment.receivedAt)) {
      throw new ConflictError(
        'A payment can only be voided on the day it was taken. Use a refund.',
        'not_same_day',
      );
    }

    // PAY-R-07. The drawer this came out of has to be open, so the cash
    // going back out lands in a session somebody will count.
    await this.sessions.getOpen(tx, payment.sessionId);

    const now = this.clock.now();
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.VOIDED,
        voidedBy: ctx.userId,
        voidedAt: now,
        voidReason: reason.trim(),
      },
    });

    if (payment.method === PaymentMethod.CASH) {
      await this.sessions.move(tx, ctx, payment.sessionId, {
        type: CashMovementType.VOID_OUT,
        amount: -payment.amount,
        referenceType: 'payment',
        referenceId: paymentId,
        reason: `Void of ${payment.receiptNo}: ${reason.trim()}`,
      });
    }

    // The rounding this leg applied goes back too, or the invoice keeps
    // an adjustment for a payment that no longer exists.
    const settled = await this.resettle(
      tx,
      ctx,
      payment.invoiceId,
      -payment.roundingApplied,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PaymentVoided,
      entityType: 'payment',
      entityId: paymentId,
      reason: reason.trim(),
      before: { amount: payment.amount.toString(), method: payment.method },
      after: { balanceAfter: settled.balance.toString() },
    });

    this.events.publish({
      name: DomainEvent.PaymentVoided,
      tenantId: ctx.tenantId,
      branchId: payment.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        paymentId,
        invoiceId: payment.invoiceId,
        amountSen: Number(payment.amount),
      },
    });

    return this.read(tx, paymentId);
  }

  /**
   * PAY-F-18: money given back, as a negative payment.
   *
   * Recorded rather than subtracted, so the trail reads as two events —
   * they paid, and then we gave it back — which is what happened and
   * what an auditor will ask about. V1 `FIN` turns this into a credit
   * note with a document of its own.
   */
  async refund(
    ctx: TenantContext,
    invoiceId: string,
    input: {
      amountSen: bigint;
      method: PaymentMethod;
      reason: string;
      refundOfId?: string | null;
      idempotencyKey: string;
      drawerCode?: string;
    },
  ) {
    if ((input.reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say why this is being refunded.',
        'reason_required',
      );
    }
    if (input.amountSen <= 0n) {
      throw new BadRequestError(
        'Say how much is going back.',
        'amount_invalid',
      );
    }

    const tx = this.db.tx();
    const key = input.idempotencyKey.trim();
    const already = await tx.payment.findFirst({
      where: { idempotencyKey: key },
    });
    if (already) return this.read(tx, already.id);

    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');

    const paid = await this.postedTotal(tx, invoiceId);
    if (input.amountSen > paid) {
      throw new ConflictError(
        `Only ${formatSen(paid)} was ever paid against this invoice.`,
        'refund_exceeds_paid',
        { paidSen: Number(paid) },
      );
    }

    const session = await this.sessions.requireOpenForBranch(
      tx,
      invoice.branchId,
      input.drawerCode ?? 'MAIN',
    );

    if (input.refundOfId) {
      const original = await tx.payment.findFirst({
        where: { id: input.refundOfId },
      });
      if (!original) throw new NotFoundError('Original payment');
      if (original.invoiceId !== invoiceId) {
        throw new BadRequestError(
          'That payment was against a different invoice.',
          'refund_of_mismatch',
        );
      }
    }

    const now = this.clock.now();
    const id = newId();
    const number = await this.nextReceiptNumber(
      tx,
      invoice.branchId,
      now.getUTCFullYear(),
    );

    await tx.payment.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: invoice.branchId,
        invoiceId,
        sessionId: session.id,
        receiptNo: number.receiptNo,
        seriesYear: number.year,
        seriesSeq: number.seq,
        method: input.method,
        amount: -input.amountSen,
        roundingApplied: 0n,
        status: PaymentStatus.POSTED,
        receivedBy: ctx.userId,
        receivedName: ctx.userName,
        receivedAt: now,
        refundOfId: input.refundOfId ?? null,
        idempotencyKey: key,
      },
    });

    if (input.method === PaymentMethod.CASH) {
      await this.sessions.move(tx, ctx, session.id, {
        type: CashMovementType.REFUND_OUT,
        amount: -input.amountSen,
        referenceType: 'payment',
        referenceId: id,
        reason: `Refund ${number.receiptNo}: ${input.reason.trim()}`,
      });
    }

    const settled = await this.resettle(tx, ctx, invoiceId, 0n);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PaymentRefunded,
      entityType: 'payment',
      entityId: id,
      subjectPatientId: invoice.patientId,
      reason: input.reason.trim(),
      after: {
        receiptNo: number.receiptNo,
        amount: (-input.amountSen).toString(),
        method: input.method,
        refundOf: input.refundOfId ?? null,
        balanceAfter: settled.balance.toString(),
      },
    });

    this.events.publish({
      name: DomainEvent.PaymentRefunded,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        paymentId: id,
        invoiceId,
        amountSen: Number(-input.amountSen),
      },
    });

    return this.read(tx, id);
  }

  // ------------------------------------------------------------ reads

  async forInvoice(ctx: TenantContext, invoiceId: string) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.payment.findMany({
      where: { invoiceId },
      orderBy: { receivedAt: 'asc' },
    });
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    return {
      items: rows.map((row) => this.present(row)),
      paidSen: invoice.amountPaid.toString(),
      balanceSen: invoice.balance.toString(),
      balance: formatSen(invoice.balance),
      status: invoice.status,
    };
  }

  async get(ctx: TenantContext, paymentId: string) {
    void ctx;
    return this.read(this.db.tx(), paymentId);
  }

  /** PAY-F-15: every print after the first is a copy, and is recorded. */
  async markPrinted(ctx: TenantContext, paymentId: string) {
    const tx = this.db.tx();
    const payment = await tx.payment.findFirst({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError('Payment');

    const now = this.clock.now();
    await tx.payment.update({
      where: { id: paymentId },
      data: { printCount: payment.printCount + 1, lastPrintedAt: now },
    });

    if (payment.printCount > 0) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.ReceiptReprinted,
        entityType: 'payment',
        entityId: paymentId,
        after: { print: payment.printCount + 1, receiptNo: payment.receiptNo },
      });
      this.events.publish({
        name: DomainEvent.ReceiptReprinted,
        tenantId: ctx.tenantId,
        branchId: payment.branchId,
        actorId: ctx.userId,
        occurredAt: now,
        payload: { paymentId, receiptNo: payment.receiptNo },
      });
    }

    return {
      printCount: payment.printCount + 1,
      isCopy: payment.printCount > 0,
    };
  }

  /** PAY §8: what is still owed at this branch. */
  async outstandingAt(ctx: TenantContext, branchId: string) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.invoice.findMany({
      where: {
        branchId,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL] },
        balance: { gt: 0 },
      },
      orderBy: { issuedAt: 'asc' },
      take: 500,
      select: {
        id: true,
        invoiceNo: true,
        patientId: true,
        patientNameSnapshot: true,
        walkupName: true,
        issuedAt: true,
        grandTotal: true,
        amountPaid: true,
        balance: true,
        status: true,
      },
    });
    const now = this.clock.now();
    return {
      items: rows.map((row) => ({
        invoiceId: row.id,
        invoiceNo: row.invoiceNo,
        patientId: row.patientId,
        patient: row.patientNameSnapshot ?? row.walkupName,
        issuedAt: row.issuedAt,
        ageDays: row.issuedAt
          ? Math.floor((now.getTime() - row.issuedAt.getTime()) / 86_400_000)
          : null,
        totalSen: row.grandTotal.toString(),
        paidSen: row.amountPaid.toString(),
        balanceSen: row.balance.toString(),
        balance: formatSen(row.balance),
        status: row.status,
      })),
      totalSen: rows.reduce((sum, row) => sum + row.balance, 0n).toString(),
    };
  }

  // -------------------------------------------------------- internals

  /**
   * PAY-R-01, recomputed rather than incremented.
   *
   * `rounding` is the change to the invoice's accumulated adjustment
   * from this operation — added on a cash leg that settles, taken back
   * when that leg is voided.
   */
  private async resettle(
    tx: Tx,
    ctx: TenantContext,
    invoiceId: string,
    rounding: bigint,
  ) {
    // Locked, so two cashiers on one invoice cannot both read a balance
    // and both decide theirs settles it.
    await tx.$executeRaw`SELECT id FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;

    const invoice = await tx.invoice.findFirstOrThrow({
      where: { id: invoiceId },
    });
    const paid = await this.postedTotal(tx, invoiceId);
    const adjustment = invoice.roundingAdjustment + rounding;
    const balance = invoice.grandTotal + adjustment - paid;

    const status =
      invoice.status === InvoiceStatus.VOID
        ? InvoiceStatus.VOID
        : balance <= 0n && paid !== 0n
          ? InvoiceStatus.PAID
          : paid > 0n
            ? InvoiceStatus.PARTIAL
            : InvoiceStatus.ISSUED;

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: paid,
        roundingAdjustment: adjustment,
        balance,
        status,
        paidAt:
          status === InvoiceStatus.PAID
            ? (invoice.paidAt ?? this.clock.now())
            : null,
      },
    });

    if (status !== invoice.status) {
      this.events.publish({
        name: DomainEvent.InvoiceStatusChanged,
        tenantId: ctx.tenantId,
        branchId: invoice.branchId,
        actorId: ctx.userId,
        occurredAt: this.clock.now(),
        payload: { invoiceId, from: invoice.status, to: status },
      });
    }

    return { paid, balance, status };
  }

  private async postedTotal(tx: Tx, invoiceId: string): Promise<bigint> {
    const total = await tx.payment.aggregate({
      where: { invoiceId, status: PaymentStatus.POSTED },
      _sum: { amount: true },
    });
    return total._sum.amount ?? 0n;
  }

  /** PAY-R-05. Locked, so thirty at once get thirty consecutive numbers. */
  private async nextReceiptNumber(tx: Tx, branchId: string, year: number) {
    await tx.$executeRaw`
      INSERT INTO receipt_series (tenant_id, branch_id, year, next_seq)
      VALUES (${requireTenantId()}::uuid, ${branchId}::uuid, ${year}, 1)
      ON CONFLICT (branch_id, year) DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ next_seq: number }>>`
      UPDATE receipt_series
         SET next_seq = next_seq + 1
       WHERE branch_id = ${branchId}::uuid AND year = ${year}
      RETURNING next_seq - 1 AS next_seq
    `;
    const seq = rows[0]?.next_seq;
    if (seq === undefined) throw new NotFoundError('Receipt series');

    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { code: true },
    });
    return {
      seq,
      year,
      receiptNo: `${branch?.code ?? 'CLN'}-RCP-${year}-${String(seq).padStart(6, '0')}`,
    };
  }

  private outstanding(invoice: {
    grandTotal: bigint;
    roundingAdjustment: bigint;
    amountPaid: bigint;
  }): bigint {
    return invoice.grandTotal + invoice.roundingAdjustment - invoice.amountPaid;
  }

  private async payableInvoice(tx: Tx, invoiceId: string) {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new ConflictError(
        'That invoice has not been issued. Issue it, then take the money.',
        'invoice_not_issued',
      );
    }
    // §14: a voided invoice takes nothing.
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictError('That invoice was voided.', 'invoice_voided');
    }
    return invoice;
  }

  /** PAY-F-06: enabled per branch, and some need a reference typed in. */
  private async assertMethodAllowed(
    tx: Tx,
    branchId: string,
    method: PaymentMethod,
    reference: string | null | undefined,
  ) {
    const config = await tx.paymentMethodConfig.findFirst({
      where: { branchId, method },
    });
    // No row means nobody has configured this branch yet, and a clinic
    // that has not been set up should still be able to take cash.
    if (config && !config.enabled) {
      throw new ConflictError(
        `${config.displayName ?? method} is not taken at this branch.`,
        'method_disabled',
      );
    }
    if (config?.requiresReference && !(reference ?? '').trim()) {
      throw new BadRequestError(
        `${config.displayName ?? method} needs a reference — the approval code or transaction id.`,
        'reference_required',
      );
    }
  }

  private sameDay(when: Date): boolean {
    const now = this.clock.now();
    return (
      when.getUTCFullYear() === now.getUTCFullYear() &&
      when.getUTCMonth() === now.getUTCMonth() &&
      when.getUTCDate() === now.getUTCDate()
    );
  }

  private async read(tx: Tx, paymentId: string) {
    return this.present(
      await tx.payment.findFirstOrThrow({ where: { id: paymentId } }),
    );
  }

  private present(row: {
    id: string;
    invoiceId: string;
    sessionId: string;
    receiptNo: string;
    method: PaymentMethod;
    amount: bigint;
    tendered: bigint | null;
    changeGiven: bigint | null;
    roundingApplied: bigint;
    reference: string | null;
    cardBrand: string | null;
    status: PaymentStatus;
    receivedName: string;
    receivedAt: Date;
    voidedAt: Date | null;
    voidReason: string | null;
    refundOfId: string | null;
    printCount: number;
  }) {
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      sessionId: row.sessionId,
      receiptNo: row.receiptNo,
      method: row.method,
      amountSen: row.amount.toString(),
      amount: formatSen(row.amount),
      tenderedSen: row.tendered?.toString() ?? null,
      changeSen: row.changeGiven?.toString() ?? null,
      change: row.changeGiven === null ? null : formatSen(row.changeGiven),
      roundingSen: row.roundingApplied.toString(),
      rounding: formatSen(row.roundingApplied),
      reference: row.reference,
      cardBrand: row.cardBrand,
      status: row.status,
      receivedBy: row.receivedName,
      receivedAt: row.receivedAt,
      voidedAt: row.voidedAt,
      voidReason: row.voidReason,
      refundOfId: row.refundOfId,
      printCount: row.printCount,
    };
  }
}
