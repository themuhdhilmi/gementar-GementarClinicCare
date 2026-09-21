import { Injectable, Logger } from '@nestjs/common';
import {
  InvoiceKind,
  InvoiceLineType,
  InvoiceStatus,
  ProductStatus,
  TaxMode,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InvariantViolationError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { ChargeInput } from '../events/charge.registry.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import { bandFor, FeeScheduleService } from './fee-schedule.service.js';
import {
  allocate,
  formatSen,
  gross as grossOf,
  lineTotal as lineTotalOf,
  percentOf,
  ringgitToSen,
  taxOn,
  toBasisPoints,
  toMilli,
} from './money.js';

/** Where a discount came from. Reported on, so it is a closed list. */
export const DISCOUNT_SOURCES = [
  'MANUAL',
  'STAFF',
  'SENIOR',
  'GOODWILL',
  'MEMBERSHIP',
  'PANEL',
  'PROMO',
] as const;
export type DiscountSource = (typeof DISCOUNT_SOURCES)[number];

export type ManualLineInput = {
  billableItemId?: string | null;
  description?: string;
  quantity: number;
  /** Ringgit, as typed. */
  unitPrice?: number | string;
  taxCode?: string;
};

export type DiscountInput = {
  pct?: number | null;
  /** Ringgit, as typed. */
  amount?: number | string | null;
  source: DiscountSource;
  reason?: string | null;
  /** BIL-F-09: an administrator's approval for an above-cap discount. */
  elevatedBy?: string | null;
};

const MAX_MANUAL_LINES = 20;

/**
 * Billing (BIL, v0-11-billing.md).
 *
 * The invoice is assembled from what the clinical modules did, and the
 * cashier's job is to look at it rather than to type it. Everything
 * automatic is locked: a medicine line changes by undoing the dispense,
 * not by editing a number, because the two must never disagree.
 *
 * `recompute` is the heart of this file. Rather than adjusting totals
 * as things change — which is how totals drift — every write recomputes
 * the whole invoice from its lines. It is a handful of rows and it is
 * arithmetic on integers, so correctness costs nothing here.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly fees: FeeScheduleService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------

  async forEncounter(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const invoice = await tx.invoice.findFirst({
      where: { encounterId, status: { not: InvoiceStatus.VOID } },
      orderBy: { createdAt: 'desc' },
    });
    if (!invoice) return { invoice: null, lines: [] };
    return this.present(tx, invoice.id);
  }

  /** BIL-F-01: created when the cashier opens billing, or on first charge. */
  async ensureDraft(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const existing = await tx.invoice.findFirst({
      where: { encounterId, status: InvoiceStatus.DRAFT },
    });
    if (existing) return this.present(tx, existing.id);

    const issued = await tx.invoice.findFirst({
      where: { encounterId, status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] } },
    });
    if (issued) return this.present(tx, issued.id);

    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId },
      select: { id: true, branchId: true, patientId: true },
    });
    if (!encounter) throw new NotFoundError('Encounter');

    const invoice = await this.createDraft(tx, ctx, {
      branchId: encounter.branchId,
      encounterId,
      patientId: encounter.patientId,
      kind: InvoiceKind.ENCOUNTER,
    });
    return this.present(tx, invoice.id);
  }

  async read(ctx: TenantContext, invoiceId: string) {
    void ctx;
    return this.present(this.db.tx(), invoiceId);
  }

  async list(
    ctx: TenantContext,
    branchId: string,
    options: { status?: InvoiceStatus; from?: Date; to?: Date; patientId?: string } = {},
  ) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const rows = await tx.invoice.findMany({
      where: {
        branchId,
        ...(options.status ? { status: options.status } : {}),
        ...(options.patientId ? { patientId: options.patientId } : {}),
        ...(options.from || options.to
          ? {
              issuedAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });

    const patients = await tx.patient.findMany({
      where: { id: { in: rows.map((r) => r.patientId).filter((id): id is string => id !== null) } },
      select: { id: true, name: true, mrn: true },
    });
    const byId = new Map(patients.map((p) => [p.id, p]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        invoiceNo: row.invoiceNo,
        status: row.status,
        kind: row.kind,
        patient: row.patientId ? (byId.get(row.patientId) ?? null) : null,
        walkupName: row.walkupName,
        grandTotal: formatSen(row.grandTotal),
        amountPaid: formatSen(row.amountPaid),
        balance: formatSen(row.balance),
        issuedAt: row.issuedAt,
        encounterId: row.encounterId,
      })),
    };
  }

  // -------------------------------------------------------------------
  // Automatic lines (BIL-F-02), called inside the clinical transaction
  // -------------------------------------------------------------------

  /**
   * BIL-R-11: the price comes with the charge, not from the catalogue.
   *
   * A medicine line is priced at what the dispense recorded, which may
   * differ from today's product price. The one exception is the
   * consultation fee, which billing owns and resolves from the schedule.
   */
  async recordCharge(tx: Tx, ctx: TenantContext, input: ChargeInput): Promise<void> {
    let unitPrice = input.unitPriceSen;
    let taxCode = input.taxCode ?? 'NONE';
    let feeRule: string | null = null;

    if (input.lineType === 'CONSULTATION') {
      const at = input.occurredAt ?? this.clock.now();
      const match = await this.fees.resolve(tx, {
        branchId: input.branchId,
        encounterType: input.encounterType ?? null,
        doctorId: input.doctorId ?? null,
        at,
        timeBand: bandFor(at.getUTCHours(), at.getUTCDay()),
      });
      // No rule means the clinic has not set its prices. An invoice with
      // no consultation line is noticed; one that says the visit was
      // free is not.
      if (!match) {
        this.logger.warn(
          `no fee-schedule rule matched for branch ${input.branchId}; no consultation line added`,
        );
        return;
      }
      unitPrice = match.feeSen;
      taxCode = match.taxCode;
      feeRule = match.rule;
    }

    if (unitPrice === null) return;

    // Only now: a draft with nothing on it is not an invoice, and a
    // clinic that has set no fees should see no invoice rather than an
    // empty one.
    const invoice = await this.draftForCharge(tx, ctx, input);

    await this.addLine(tx, ctx, invoice.id, {
      lineType: input.lineType as InvoiceLineType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      quantity: input.quantity,
      quantityUnit: input.quantityUnit ?? null,
      unitPriceSen: unitPrice,
      taxCode,
      feeRule,
      isAuto: true,
    });

    await this.recompute(tx, invoice.id);
  }

  /** The dispense was undone, or the procedure voided. */
  async removeCharge(
    tx: Tx,
    ctx: TenantContext,
    source: { sourceType: string; sourceId: string },
  ): Promise<void> {
    const lines = await tx.invoiceLine.findMany({
      where: { sourceType: source.sourceType, sourceId: source.sourceId },
    });
    if (lines.length === 0) return;

    for (const line of lines) {
      const invoice = await tx.invoice.findFirst({ where: { id: line.invoiceId } });
      if (!invoice) continue;

      // §14: once the invoice is out, the source cannot quietly retract
      // its line. DSP and PRC both refuse to undo past their own
      // windows, so reaching here means something slipped through.
      if (invoice.status !== InvoiceStatus.DRAFT) {
        throw new ConflictError(
          `This was billed on invoice ${invoice.invoiceNo}, which has been issued. ` +
            'Void the invoice and reissue it.',
          'already_invoiced',
        );
      }

      await tx.invoiceLine.delete({ where: { id: line.id } });
      await this.recompute(tx, invoice.id);

      this.events.publish({
        name: DomainEvent.InvoiceLineRemoved,
        tenantId: ctx.tenantId,
        branchId: invoice.branchId,
        actorId: ctx.userId,
        occurredAt: this.clock.now(),
        payload: { invoiceId: invoice.id, sourceType: source.sourceType, sourceId: source.sourceId },
      });
    }
  }

  // -------------------------------------------------------------------
  // Manual lines (BIL-F-03, BIL-F-04)
  // -------------------------------------------------------------------

  async addManualLine(ctx: TenantContext, invoiceId: string, input: ManualLineInput) {
    const tx = this.db.tx();
    const invoice = await this.draftOrThrow(tx, invoiceId);

    const manual = await tx.invoiceLine.count({ where: { invoiceId, isAuto: false } });
    if (manual >= MAX_MANUAL_LINES) {
      throw new BadRequestError(
        `An invoice takes at most ${MAX_MANUAL_LINES} items added by hand.`,
        'too_many_manual_lines',
      );
    }

    let description = input.description?.trim() ?? '';
    let unitPrice: bigint;
    let taxCode = input.taxCode ?? 'NONE';

    if (input.billableItemId) {
      const item = await tx.billableItem.findFirst({ where: { id: input.billableItemId } });
      if (!item) throw new NotFoundError('Billable item');
      if (item.status !== ProductStatus.ACTIVE) {
        throw new ConflictError(`${item.name} is no longer offered.`, 'item_retired');
      }
      description = description || item.name;
      unitPrice = input.unitPrice === undefined ? item.defaultPrice : ringgitToSen(input.unitPrice);
      taxCode = input.taxCode ?? item.taxCode;
    } else {
      if (description.length < 2) {
        throw new BadRequestError('Say what this line is for.', 'description_required');
      }
      if (input.unitPrice === undefined) {
        throw new BadRequestError('A line added by hand needs a price.', 'price_required');
      }
      unitPrice = ringgitToSen(input.unitPrice);
    }

    if (!(input.quantity > 0)) {
      throw new BadRequestError('A line needs a quantity.', 'invalid_quantity');
    }
    if (unitPrice < 0n) {
      throw new BadRequestError('A price cannot be negative.', 'invalid_price');
    }

    const line = await this.addLine(tx, ctx, invoice.id, {
      lineType: InvoiceLineType.MANUAL,
      sourceType: input.billableItemId ? 'billable_item' : null,
      sourceId: input.billableItemId ?? null,
      description,
      quantity: input.quantity,
      quantityUnit: null,
      unitPriceSen: unitPrice,
      taxCode,
      feeRule: null,
      isAuto: false,
    });
    await this.recompute(tx, invoice.id);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceLineAdded,
      entityType: 'invoice',
      entityId: invoice.id,
      subjectPatientId: invoice.patientId,
      after: { description, quantity: input.quantity, unitPrice: formatSen(unitPrice) },
    });

    void line;
    return this.present(tx, invoice.id);
  }

  async updateManualLine(
    ctx: TenantContext,
    invoiceId: string,
    lineId: string,
    input: { quantity?: number; unitPrice?: number | string; description?: string },
  ) {
    const tx = this.db.tx();
    const invoice = await this.draftOrThrow(tx, invoiceId);
    const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId } });
    if (!line) throw new NotFoundError('Invoice line');
    this.assertManual(line);

    const quantity = input.quantity ?? Number(line.quantity);
    const unitPrice = input.unitPrice === undefined ? line.unitPrice : ringgitToSen(input.unitPrice);
    if (!(quantity > 0)) throw new BadRequestError('A line needs a quantity.', 'invalid_quantity');

    await tx.invoiceLine.update({
      where: { id: lineId },
      data: {
        quantity,
        unitPrice,
        gross: grossOf(toMilli(quantity), unitPrice),
        ...(input.description ? { description: input.description.trim() } : {}),
      },
    });
    await this.recompute(tx, invoice.id);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceLineEdited,
      entityType: 'invoice',
      entityId: invoice.id,
      subjectPatientId: invoice.patientId,
      before: { quantity: Number(line.quantity), unitPrice: formatSen(line.unitPrice) },
      after: { quantity, unitPrice: formatSen(unitPrice) },
    });
    return this.present(tx, invoice.id);
  }

  async removeManualLine(ctx: TenantContext, invoiceId: string, lineId: string) {
    const tx = this.db.tx();
    const invoice = await this.draftOrThrow(tx, invoiceId);
    const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId } });
    if (!line) throw new NotFoundError('Invoice line');
    this.assertManual(line);

    await tx.invoiceLine.delete({ where: { id: lineId } });
    await this.recompute(tx, invoice.id);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceLineRemoved,
      entityType: 'invoice',
      entityId: invoice.id,
      subjectPatientId: invoice.patientId,
      before: { description: line.description, gross: formatSen(line.gross) },
    });
    return this.present(tx, invoice.id);
  }

  // -------------------------------------------------------------------
  // Discounts (BIL-F-07 … F-10)
  // -------------------------------------------------------------------

  async setLineDiscount(
    ctx: TenantContext,
    invoiceId: string,
    lineId: string,
    input: DiscountInput,
  ) {
    const tx = this.db.tx();
    const invoice = await this.draftOrThrow(tx, invoiceId);
    const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId } });
    if (!line) throw new NotFoundError('Invoice line');

    const amount = await this.resolveDiscount(tx, ctx, input, line.gross, invoice.branchId);

    await tx.invoiceLine.update({
      where: { id: lineId },
      data: {
        discountPct: input.pct ?? null,
        ownDiscountAmount: amount.own,
        discountAmount: amount.own,
        discountSource: input.source,
        discountReason: input.reason?.trim() || null,
        discountBy: amount.approvedBy,
      },
    });
    await this.recompute(tx, invoice.id);

    await this.auditDiscount(tx, ctx, invoice, {
      scope: 'line',
      lineId,
      description: line.description,
      amount: amount.own,
      source: input.source,
      reason: input.reason ?? null,
      approvedBy: amount.approvedBy,
      elevated: amount.elevated,
    });
    return this.present(tx, invoice.id);
  }

  /** BIL-F-08: allocated across the lines so they always add up. */
  async setInvoiceDiscount(ctx: TenantContext, invoiceId: string, input: DiscountInput) {
    const tx = this.db.tx();
    const invoice = await this.draftOrThrow(tx, invoiceId);

    const lines = await tx.invoiceLine.findMany({ where: { invoiceId } });
    if (lines.length === 0) {
      throw new ConflictError('There is nothing to discount yet.', 'no_lines');
    }
    const ownDiscounts = lines.reduce((sum, line) => sum + line.discountAmount, 0n);
    const base = lines.reduce((sum, line) => sum + line.gross, 0n) - ownDiscounts;

    const amount = await this.resolveDiscount(tx, ctx, input, base, invoice.branchId);

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        invoiceDiscountPct: input.pct ?? null,
        invoiceDiscountReason: input.reason?.trim() || null,
        invoiceDiscountSource: input.source,
        // Held as the amount so the allocation is reproducible even if
        // the lines change underneath it.
        notes: invoice.notes,
      },
    });
    await this.recompute(tx, invoiceId, { invoiceDiscount: amount.own, approvedBy: amount.approvedBy });

    await this.auditDiscount(tx, ctx, invoice, {
      scope: 'invoice',
      amount: amount.own,
      source: input.source,
      reason: input.reason ?? null,
      approvedBy: amount.approvedBy,
      elevated: amount.elevated,
    });
    return this.present(tx, invoiceId);
  }

  async clearInvoiceDiscount(ctx: TenantContext, invoiceId: string) {
    const tx = this.db.tx();
    await this.draftOrThrow(tx, invoiceId);
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        invoiceDiscountPct: null,
        invoiceDiscountReason: null,
        invoiceDiscountSource: null,
      },
    });
    await this.recompute(tx, invoiceId, { invoiceDiscount: 0n });
    return this.present(tx, invoiceId);
  }

  /**
   * BIL-F-09: how much the person at the counter may give away.
   *
   * A cap that can be exceeded by asking an administrator is a control;
   * a cap that cannot be exceeded at all is a queue of patients waiting
   * for somebody to log out and log back in.
   */
  private async resolveDiscount(
    tx: Tx,
    ctx: TenantContext,
    input: DiscountInput,
    base: bigint,
    branchId: string,
  ): Promise<{ own: bigint; approvedBy: string | null; elevated: boolean }> {
    if (!DISCOUNT_SOURCES.includes(input.source)) {
      throw new BadRequestError(`"${input.source}" is not a kind of discount.`, 'invalid_source');
    }
    if ((input.pct === undefined || input.pct === null) === (input.amount === undefined || input.amount === null)) {
      throw new BadRequestError(
        'Give a discount either as a percentage or as an amount.',
        'discount_needs_one_form',
      );
    }

    const amount =
      input.pct !== undefined && input.pct !== null
        ? percentOf(base, toBasisPoints(input.pct))
        : ringgitToSen(input.amount!);

    if (amount < 0n) throw new BadRequestError('A discount cannot be negative.', 'invalid_discount');
    if (amount > base) {
      throw new BadRequestError(
        `That is more than the ${formatSen(base)} being discounted.`,
        'discount_exceeds_total',
      );
    }

    const billing = await this.settings.at(branchId);
    const capPct = Number(billing.billing?.maxDiscountPctFrontdesk ?? 10);
    const reasonThreshold = Number(billing.billing?.discountReasonThresholdPct ?? 5);

    const pctOfBase = base === 0n ? 0 : Number((amount * 10_000n) / base) / 100;

    if (pctOfBase >= reasonThreshold && !(input.reason ?? '').trim()) {
      throw new BadRequestError(
        `A discount of ${pctOfBase.toFixed(2)}% needs a reason.`,
        'discount_reason_required',
      );
    }

    const overCap = pctOfBase > capPct;
    const isAdmin = ctx.permissions.has('admin.settings');

    if (overCap && !isAdmin) {
      if (!input.elevatedBy) {
        throw new ForbiddenError(
          `${pctOfBase.toFixed(2)}% is above the ${capPct}% you may give. An administrator has to approve it.`,
          { cap: capPct, requested: pctOfBase, elevationRequired: true },
        );
      }
      // The elevation token names the administrator who approved it.
      const approver = await tx.user.findFirst({
        where: { id: input.elevatedBy },
        select: { id: true },
      });
      if (!approver) throw new ForbiddenError('That approval is not valid.', {});
      return { own: amount, approvedBy: approver.id, elevated: true };
    }

    return { own: amount, approvedBy: ctx.userId, elevated: false };
  }

  // -------------------------------------------------------------------
  // The heart: recompute (BIL-R-02, R-03, R-04)
  // -------------------------------------------------------------------

  /**
   * Recalculate the whole invoice from its lines.
   *
   * Every write goes through here rather than adjusting a running
   * total, because a running total is how an invoice ends up
   * disagreeing with itself. It is a dozen rows of integer arithmetic;
   * doing it again costs nothing and removes a whole class of bug.
   */
  private async recompute(
    tx: Tx,
    invoiceId: string,
    options: { invoiceDiscount?: bigint; approvedBy?: string | null } = {},
  ) {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');

    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId },
      orderBy: { lineNo: 'asc' },
    });

    // A line's own discount, kept in its own column. Reading it off
    // `discount_amount` would count the previous invoice-level
    // allocation as the line's own and discount it a second time.
    const own = lines.map((line) => line.ownDiscountAmount);

    const invoiceDiscount =
      options.invoiceDiscount !== undefined
        ? options.invoiceDiscount
        : await this.currentInvoiceDiscount(tx, invoice, lines, own);

    // BIL-R-03: allocate across what is left after each line's own
    // discount, so no line is discounted past its gross.
    const remaining = lines.map((line, index) => line.gross - own[index]!);
    const shares = allocate(invoiceDiscount, remaining);

    const mode = invoice.taxMode as TaxMode;
    let subtotal = 0n;
    let discountTotal = 0n;
    let taxTotal = 0n;

    for (const [index, line] of lines.entries()) {
      const discount = own[index]! + shares[index]!;
      const net = line.gross - discount;
      const tax = taxOn(net, line.taxRateBp, mode);
      const total = lineTotalOf(line.gross, discount, tax, mode);

      await tx.invoiceLine.update({
        where: { id: line.id },
        data: {
          ownDiscountAmount: own[index]!,
          discountAmount: discount,
          taxAmount: tax,
          lineTotal: total,
        },
      });

      subtotal += line.gross;
      discountTotal += discount;
      taxTotal += tax;
    }

    const grandTotal =
      mode === 'EXCLUSIVE' ? subtotal - discountTotal + taxTotal : subtotal - discountTotal;

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        subtotal,
        discountTotal,
        taxTotal,
        grandTotal,
        balance: grandTotal + invoice.roundingAdjustment - invoice.amountPaid,
      },
    });
  }

  /**
   * How much invoice-level discount is currently in force.
   *
   * Recovered from the stored percentage where there is one, so that
   * adding a line after a 10% discount discounts the new line too —
   * which is what a cashier means by "10% off this bill".
   */
  private async currentInvoiceDiscount(
    tx: Tx,
    invoice: { invoiceDiscountPct: unknown },
    lines: Array<{ gross: bigint; discountAmount: bigint; ownDiscountAmount: bigint }>,
    own: bigint[],
  ): Promise<bigint> {
    void tx;
    const pct = invoice.invoiceDiscountPct === null ? null : Number(invoice.invoiceDiscountPct);
    const capacity = lines.reduce((sum, line, i) => sum + line.gross - own[i]!, 0n);

    if (pct === null) {
      // A flat amount was given once. What is still allocated is the
      // difference between each line's total and its own discount.
      const previous = lines.reduce(
        (sum, line) => sum + (line.discountAmount - line.ownDiscountAmount),
        0n,
      );
      const kept = previous < 0n ? 0n : previous;
      return kept > capacity ? capacity : kept;
    }

    // A percentage follows the bill: "10% off this" means 10% of what
    // the bill comes to, including a line added afterwards.
    return percentOf(capacity, toBasisPoints(pct));
  }

  // -------------------------------------------------------------------
  // Issue, void, reissue
  // -------------------------------------------------------------------

  /**
   * BIL-F-13, BIL-R-06: give it a number and freeze it.
   *
   * The number comes from a per-branch, per-year counter allocated
   * under a row lock inside this transaction. If anything later in the
   * transaction fails, the allocation rolls back with it — which is what
   * makes the series gapless rather than merely usually gapless.
   */
  async issue(ctx: TenantContext, invoiceId: string, options: { idempotencyKey?: string } = {}) {
    const tx = this.db.tx();
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');

    // A retried request finds it already issued and returns the same
    // answer rather than allocating a second number.
    if (invoice.status !== InvoiceStatus.DRAFT) {
      if (options.idempotencyKey) return this.present(tx, invoiceId);
      throw new ConflictError(
        `Invoice ${invoice.invoiceNo} has already been issued.`,
        'already_issued',
      );
    }

    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId },
      orderBy: { lineNo: 'asc' },
    });
    if (lines.length === 0) {
      throw new InvariantViolationError(
        'nothing_to_invoice',
        'There is nothing on this invoice yet.',
        {},
      );
    }

    await this.recompute(tx, invoiceId);
    const settled = await tx.invoice.findFirstOrThrow({ where: { id: invoiceId } });
    if (settled.grandTotal < 0n) {
      throw new InvariantViolationError(
        'negative_total',
        'An invoice cannot come to less than nothing.',
        { grandTotal: formatSen(settled.grandTotal) },
      );
    }

    // BIL-R-12: drafts can have gaps from removed lines. The issued
    // document is numbered from one.
    for (const [index, line] of lines.entries()) {
      if (line.lineNo !== index + 1) {
        await tx.invoiceLine.update({ where: { id: line.id }, data: { lineNo: index + 1 } });
      }
    }

    const now = this.clock.now();
    const year = now.getUTCFullYear();
    const seq = await this.nextSequence(tx, invoice.branchId, year);
    const branch = await tx.branch.findFirst({
      where: { id: invoice.branchId },
      select: { code: true },
    });
    const invoiceNo = `${branch?.code ?? 'INV'}-INV-${year}-${String(seq).padStart(6, '0')}`;

    const patient = invoice.patientId
      ? await tx.patient.findFirst({
          where: { id: invoice.patientId },
          select: { name: true, idNumber: true },
        })
      : null;

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.ISSUED,
        invoiceNo,
        seriesYear: year,
        seriesSeq: seq,
        issuedAt: now,
        issuedBy: ctx.userId,
        patientNameSnapshot: patient?.name ?? invoice.walkupName ?? null,
        patientIdMaskedSnapshot: maskIdentity(patient?.idNumber ?? null),
        balance: settled.grandTotal + settled.roundingAdjustment - settled.amountPaid,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceIssued,
      entityType: 'invoice',
      entityId: invoiceId,
      subjectPatientId: invoice.patientId,
      after: {
        invoiceNo,
        subtotal: formatSen(settled.subtotal),
        discountTotal: formatSen(settled.discountTotal),
        taxTotal: formatSen(settled.taxTotal),
        grandTotal: formatSen(settled.grandTotal),
        lines: lines.map((line) => ({
          description: line.description,
          quantity: Number(line.quantity),
          unitPrice: formatSen(line.unitPrice),
          lineTotal: formatSen(line.lineTotal),
        })),
      },
    });

    this.events.publish({
      name: DomainEvent.InvoiceIssued,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        invoiceId,
        invoiceNo,
        encounterId: invoice.encounterId,
        grandTotalSen: Number(settled.grandTotal),
      },
    });

    return this.present(tx, invoiceId);
  }

  /** BIL-R-06. Locked, so fifty cashiers get fifty consecutive numbers. */
  private async nextSequence(tx: Tx, branchId: string, year: number): Promise<number> {
    // The counter row may not exist for a new branch or a new year.
    // Created here, then locked, in one statement that cannot race.
    await tx.$executeRaw`
      INSERT INTO invoice_series (tenant_id, branch_id, year, next_seq)
      VALUES (${requireTenantId()}::uuid, ${branchId}::uuid, ${year}, 1)
      ON CONFLICT (branch_id, year) DO NOTHING
    `;

    const rows = await tx.$queryRaw<Array<{ next_seq: number }>>`
      UPDATE invoice_series
         SET next_seq = next_seq + 1
       WHERE branch_id = ${branchId}::uuid AND year = ${year}
      RETURNING next_seq - 1 AS next_seq
    `;
    const seq = rows[0]?.next_seq;
    if (seq === undefined) throw new NotFoundError('Invoice series');
    return seq;
  }

  /** BIL-F-15, BIL-R-07. */
  async void(ctx: TenantContext, invoiceId: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say what happened, in a sentence. A voided invoice is read later.',
        'reason_required',
      );
    }

    const tx = this.db.tx();
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === InvoiceStatus.DRAFT) {
      throw new ConflictError(
        'This has not been issued. Discard the draft instead.',
        'not_issued',
      );
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictError('This invoice is already void.', 'already_void');
    }

    // BIL-R-07. Payment does not exist yet, so this reads what has been
    // recorded on the invoice itself; PAY will make it a real check
    // against its own rows.
    if (invoice.amountPaid > 0n) {
      throw new ConflictError(
        `${formatSen(invoice.amountPaid)} has been paid against this invoice. ` +
          'Void the payment first.',
        'payments_outstanding',
      );
    }

    const now = this.clock.now();
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.VOID,
        voidedAt: now,
        voidedBy: ctx.userId,
        voidReason: reason.trim(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceVoided,
      entityType: 'invoice',
      entityId: invoiceId,
      subjectPatientId: invoice.patientId,
      reason: reason.trim(),
      before: { invoiceNo: invoice.invoiceNo, grandTotal: formatSen(invoice.grandTotal) },
    });

    this.events.publish({
      name: DomainEvent.InvoiceVoided,
      tenantId: ctx.tenantId,
      branchId: invoice.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { invoiceId, invoiceNo: invoice.invoiceNo, reason: reason.trim() },
    });

    return this.present(tx, invoiceId);
  }

  /** BIL-F-16: the same lines again, editable, with a new number to come. */
  async reissue(ctx: TenantContext, invoiceId: string) {
    const tx = this.db.tx();
    const source = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!source) throw new NotFoundError('Invoice');
    if (source.status !== InvoiceStatus.VOID) {
      throw new ConflictError('Only a voided invoice is reissued.', 'not_void');
    }
    if (source.reissuedAsId) {
      throw new ConflictError('This has already been reissued.', 'already_reissued');
    }

    const draft = await this.createDraft(tx, ctx, {
      branchId: source.branchId,
      encounterId: source.encounterId,
      patientId: source.patientId,
      walkupName: source.walkupName,
      kind: source.kind,
      reissuedFromId: source.id,
    });

    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId: source.id },
      orderBy: { lineNo: 'asc' },
    });
    for (const [index, line] of lines.entries()) {
      await tx.invoiceLine.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          invoiceId: draft.id,
          lineNo: index + 1,
          lineType: line.lineType,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          description: line.description,
          quantity: line.quantity,
          quantityUnit: line.quantityUnit,
          unitPrice: line.unitPrice,
          gross: line.gross,
          discountPct: line.discountPct,
          ownDiscountAmount: line.ownDiscountAmount,
          discountAmount: line.discountAmount,
          discountSource: line.discountSource,
          discountReason: line.discountReason,
          discountBy: line.discountBy,
          taxCode: line.taxCode,
          taxRateBp: line.taxRateBp,
          taxAmount: line.taxAmount,
          lineTotal: line.lineTotal,
          feeRule: line.feeRule,
          isAuto: line.isAuto,
        },
      });
    }

    await tx.invoice.update({ where: { id: source.id }, data: { reissuedAsId: draft.id } });
    await this.recompute(tx, draft.id);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceReissued,
      entityType: 'invoice',
      entityId: draft.id,
      subjectPatientId: source.patientId,
      after: { reissuedFrom: source.invoiceNo, lines: lines.length },
    });

    return this.present(tx, draft.id);
  }

  /** BIL-F-18: somebody buying a box of plasters at the counter. */
  async standalone(
    ctx: TenantContext,
    branchId: string,
    input: { patientId?: string | null; walkupName?: string | null },
  ) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');
    if (!input.patientId && !(input.walkupName ?? '').trim()) {
      throw new BadRequestError('Say who this is for, even if only a name.', 'payer_required');
    }

    const invoice = await this.createDraft(tx, ctx, {
      branchId,
      encounterId: null,
      patientId: input.patientId ?? null,
      walkupName: input.walkupName?.trim() || null,
      kind: InvoiceKind.STANDALONE,
    });
    return this.present(tx, invoice.id);
  }

  /** A draft with nothing on it is not worth keeping. */
  async discardDraft(tx: Tx, ctx: TenantContext, encounterId: string, reason: string) {
    const draft = await tx.invoice.findFirst({
      where: { encounterId, status: InvoiceStatus.DRAFT },
    });
    if (!draft) return;
    await tx.invoiceLine.deleteMany({ where: { invoiceId: draft.id } });
    await tx.invoice.delete({ where: { id: draft.id } });
    void ctx;
    void reason;
  }

  // -------------------------------------------------------------------

  private async createDraft(
    tx: Tx,
    ctx: TenantContext,
    input: {
      branchId: string;
      encounterId?: string | null;
      patientId?: string | null;
      walkupName?: string | null;
      kind: InvoiceKind;
      reissuedFromId?: string | null;
    },
  ) {
    const billing = await this.settings.at(input.branchId);
    const taxMode = (billing.billing?.taxMode ?? 'EXCLUSIVE') as TaxMode;

    const id = newId();
    const invoice = await tx.invoice.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: input.branchId,
        encounterId: input.encounterId ?? null,
        patientId: input.patientId ?? null,
        walkupName: input.walkupName ?? null,
        kind: input.kind,
        status: InvoiceStatus.DRAFT,
        taxMode,
        reissuedFromId: input.reissuedFromId ?? null,
      },
    });

    this.events.publish({
      name: DomainEvent.InvoiceDraftCreated,
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { invoiceId: id, encounterId: input.encounterId ?? null },
    });

    return invoice;
  }

  /** The draft a charge belongs on, created if this is the first one. */
  private async draftForCharge(tx: Tx, ctx: TenantContext, input: ChargeInput) {
    const existing = await tx.invoice.findFirst({
      where: { encounterId: input.encounterId, status: InvoiceStatus.DRAFT },
    });
    if (existing) return existing;

    // If the visit has already been invoiced, a late charge cannot
    // quietly join it. DSP and PRC both refuse to act past their own
    // windows, so this is a guard rather than an expected path.
    const issued = await tx.invoice.findFirst({
      where: {
        encounterId: input.encounterId,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.PAID] },
      },
    });
    if (issued) {
      throw new ConflictError(
        `This visit was already invoiced as ${issued.invoiceNo}. Void it and reissue to add this.`,
        'already_invoiced',
      );
    }

    return this.createDraft(tx, ctx, {
      branchId: input.branchId,
      encounterId: input.encounterId,
      patientId: input.patientId,
      kind: InvoiceKind.ENCOUNTER,
    });
  }

  private async addLine(
    tx: Tx,
    ctx: TenantContext,
    invoiceId: string,
    input: {
      lineType: InvoiceLineType;
      sourceType: string | null;
      sourceId: string | null;
      description: string;
      quantity: number;
      quantityUnit: string | null;
      unitPriceSen: bigint;
      taxCode: string;
      feeRule: string | null;
      isAuto: boolean;
    },
  ) {
    void ctx;
    const last = await tx.invoiceLine.findFirst({
      where: { invoiceId },
      orderBy: { lineNo: 'desc' },
      select: { lineNo: true },
    });
    const lineNo = (last?.lineNo ?? 0) + 1;
    const grossSen = grossOf(toMilli(input.quantity), input.unitPriceSen);
    const rateBp = TAX_RATES[input.taxCode] ?? 0;

    return tx.invoiceLine.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        invoiceId,
        lineNo,
        lineType: input.lineType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        description: input.description.slice(0, 300),
        quantity: input.quantity,
        quantityUnit: input.quantityUnit,
        unitPrice: input.unitPriceSen,
        gross: grossSen,
        taxCode: input.taxCode,
        taxRateBp: rateBp,
        taxAmount: 0n,
        lineTotal: grossSen,
        feeRule: input.feeRule,
        isAuto: input.isAuto,
      },
    });
  }

  private async draftOrThrow(tx: Tx, invoiceId: string) {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictError(
        `Invoice ${invoice.invoiceNo} has been issued and cannot be changed. Void it and reissue.`,
        'invoice_issued',
      );
    }
    return invoice;
  }

  /** BIL-R-08. */
  private assertManual(line: { isAuto: boolean; description: string }) {
    if (line.isAuto) {
      throw new ConflictError(
        `"${line.description}" was added by the system from what was done. ` +
          'Change it by changing that — undo the dispense, or void the procedure.',
        'line_is_automatic',
      );
    }
  }

  private async auditDiscount(
    tx: Tx,
    ctx: TenantContext,
    invoice: { id: string; patientId: string | null },
    detail: Record<string, unknown> & { amount: bigint },
  ) {
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.InvoiceDiscounted,
      entityType: 'invoice',
      entityId: invoice.id,
      subjectPatientId: invoice.patientId,
      reason: (detail['reason'] as string | null) ?? null,
      after: { ...detail, amount: formatSen(detail.amount) },
    });
  }

  private async present(tx: Tx, invoiceId: string) {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError('Invoice');
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId },
      orderBy: { lineNo: 'asc' },
    });

    return {
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        status: invoice.status,
        kind: invoice.kind,
        branchId: invoice.branchId,
        encounterId: invoice.encounterId,
        patientId: invoice.patientId,
        walkupName: invoice.walkupName,
        taxMode: invoice.taxMode,
        subtotal: formatSen(invoice.subtotal),
        discountTotal: formatSen(invoice.discountTotal),
        taxTotal: formatSen(invoice.taxTotal),
        roundingAdjustment: formatSen(invoice.roundingAdjustment),
        grandTotal: formatSen(invoice.grandTotal),
        amountPaid: formatSen(invoice.amountPaid),
        balance: formatSen(invoice.balance),
        subtotalSen: Number(invoice.subtotal),
        grandTotalSen: Number(invoice.grandTotal),
        invoiceDiscountPct:
          invoice.invoiceDiscountPct === null ? null : Number(invoice.invoiceDiscountPct),
        invoiceDiscountReason: invoice.invoiceDiscountReason,
        invoiceDiscountSource: invoice.invoiceDiscountSource,
        issuedAt: invoice.issuedAt,
        voidedAt: invoice.voidedAt,
        voidReason: invoice.voidReason,
        reissuedFromId: invoice.reissuedFromId,
        reissuedAsId: invoice.reissuedAsId,
        patientNameSnapshot: invoice.patientNameSnapshot,
      },
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        lineType: line.lineType,
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        description: line.description,
        quantity: Number(line.quantity),
        quantityUnit: line.quantityUnit,
        unitPrice: formatSen(line.unitPrice),
        gross: formatSen(line.gross),
        grossSen: Number(line.gross),
        discountPct: line.discountPct === null ? null : Number(line.discountPct),
        discountAmount: formatSen(line.discountAmount),
        discountAmountSen: Number(line.discountAmount),
        discountSource: line.discountSource,
        discountReason: line.discountReason,
        taxCode: line.taxCode,
        taxAmount: formatSen(line.taxAmount),
        lineTotal: formatSen(line.lineTotal),
        lineTotalSen: Number(line.lineTotal),
        feeRule: line.feeRule,
        isAuto: line.isAuto,
      })),
    };
  }
}

/**
 * BIL-F-11. Most GP services and medicines are not SST-taxable, so the
 * default is nothing at all and the clinic's accountant confirms the
 * rest (BIL-Q-02).
 */
const TAX_RATES: Record<string, number> = {
  NONE: 0,
  SST_6: 600,
  SST_8: 800,
};

/** What goes on a printed invoice: enough to recognise, not enough to copy. */
function maskIdentity(idNumber: string | null): string | null {
  if (!idNumber) return null;
  const digits = idNumber.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••••-••-${digits.slice(-4)}`;
}
