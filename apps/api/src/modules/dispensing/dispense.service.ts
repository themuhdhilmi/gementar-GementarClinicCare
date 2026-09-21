import { Injectable, Logger } from '@nestjs/common';
import {
  BatchStatus,
  ControlledEntryType,
  DispenseOutcome,
  DispenseStatus,
  EncounterStatus,
  PrescriptionItemStatus,
  PrescriptionStatus,
  ProductStatus,
  ProductType,
  StockMovementType,
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
import { ChargeRegistry } from '../events/charge.registry.js';
import { DomainEvent } from '../events/domain-events.js';
import { fromSen } from '../catalogue/money.js';
import { LedgerService } from '../stock/ledger.service.js';
import { PrescriptionService } from '../prescription/prescription.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { roundToPacks } from './pack-rounding.js';
import { ControlledRegisterService } from './controlled-register.service.js';

/** DSP-F-16: after this, an undo is a return rather than a correction. */
export const UNDO_WINDOW_MINUTES = 15;

export type BatchChoice = {
  batchId: string;
  quantity: number;
  overrideReason?: string | null;
};

export type DispenseItemInput = {
  /** Omit to take the suggestion in full. */
  batches?: BatchChoice[];
  quantity?: number;
  outcome?: DispenseOutcome;
  reason?: string | null;
  counselled?: boolean;
  idempotencyKey?: string | null;
  /** DSP-F-18. Required when the product is controlled. */
  register?: {
    witnessId?: string | null;
    witnessName?: string | null;
  } | null;
};

/**
 * Dispensing (DSP, v0-08-dispensing.md).
 *
 * The transaction in `dispenseItem` is the one everything else in the
 * system relies on being right: the batch is locked, the stock leaves
 * through the ledger, the item is written, the prescription is told, and
 * a controlled drug's register entry goes in — all of it or none of it.
 *
 * A prescription is intent. This is the record of what actually happened,
 * and the two are allowed to differ: a different batch, a smaller
 * quantity, a substitute, or nothing at all because the patient said no.
 * Every one of those differences is recorded rather than smoothed over,
 * which is why the invoice is built from here and not from the
 * prescription (DSP-R-06).
 */
@Injectable()
export class DispenseService {
  private readonly logger = new Logger(DispenseService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly ledger: LedgerService,
    private readonly prescriptions: PrescriptionService,
    private readonly register: ControlledRegisterService,
    private readonly charges: ChargeRegistry,
  ) {}

  // -------------------------------------------------------------------
  // The queue (DSP-F-01)
  // -------------------------------------------------------------------

  async queue(ctx: TenantContext, branchId: string) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const encounters = await tx.encounter.findMany({
      where: {
        branchId,
        status: { in: [EncounterStatus.PHARMACY_WAITING, EncounterStatus.DISPENSING] },
      },
      select: {
        id: true,
        queueNo: true,
        status: true,
        statusSince: true,
        patientId: true,
      },
      orderBy: { statusSince: 'asc' },
      take: 100,
    });
    if (encounters.length === 0) return { items: [] };

    const [patients, prescriptions, sessions] = await Promise.all([
      tx.patient.findMany({
        where: { id: { in: encounters.map((e) => e.patientId) } },
        select: { id: true, name: true, mrn: true, dateOfBirth: true },
      }),
      tx.prescription.findMany({
        where: {
          encounterId: { in: encounters.map((e) => e.id) },
          status: PrescriptionStatus.ACTIVE,
        },
        include: { items: { where: { isCurrent: true } } },
      }),
      tx.dispense.findMany({
        where: { encounterId: { in: encounters.map((e) => e.id) }, status: DispenseStatus.OPEN },
        select: { id: true, encounterId: true, rxVersionSeen: true, openedBy: true },
      }),
    ]);

    const patientById = new Map(patients.map((p) => [p.id, p]));
    const rxByEncounter = new Map(prescriptions.map((p) => [p.encounterId, p]));
    const sessionByEncounter = new Map(sessions.map((s) => [s.encounterId, s]));
    const now = this.clock.now();

    return {
      items: encounters
        .map((encounter) => {
          const prescription = rxByEncounter.get(encounter.id);
          if (!prescription) return null;

          const pending = prescription.items.filter(
            (item) =>
              item.status === PrescriptionItemStatus.ACTIVE ||
              item.status === PrescriptionItemStatus.PARTIAL,
          );
          const session = sessionByEncounter.get(encounter.id);

          // DSP-F-01: the doctor changed something since this session
          // was opened. The badge is the whole reason `rxVersionSeen`
          // exists.
          //
          // An amendment makes a new row, so a changed item shows up as
          // an id the dispenser has not seen rather than as a version
          // that moved. Both are the same news, and both are covered by
          // asking whether every current item is one they saw.
          const seen = (session?.rxVersionSeen ?? {}) as Record<string, number>;
          const amended = session
            ? prescription.items.some((item) => seen[item.id] !== item.version)
            : false;

          return {
            encounterId: encounter.id,
            prescriptionId: prescription.id,
            dispenseId: session?.id ?? null,
            queueNo: encounter.queueNo,
            status: encounter.status,
            patient: patientById.get(encounter.patientId) ?? null,
            items: pending.length,
            hasControlled: pending.some((item) => item.isControlled),
            amended,
            waitingMinutes: Math.floor(
              (now.getTime() - encounter.statusSince.getTime()) / 60_000,
            ),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
    };
  }

  // -------------------------------------------------------------------
  // The session (DSP-F-02)
  // -------------------------------------------------------------------

  /**
   * Opening is idempotent: a dispenser who reloads the page, or a second
   * one who opens the same patient, joins the session rather than
   * starting a rival one.
   */
  async open(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId },
      select: { id: true, branchId: true, patientId: true, status: true },
    });
    if (!encounter) throw new NotFoundError('Encounter');

    const prescription = await tx.prescription.findFirst({
      where: { encounterId, status: PrescriptionStatus.ACTIVE },
      include: { items: { where: { isCurrent: true } } },
    });
    if (!prescription) {
      throw new NotFoundError(
        'Prescription',
        'There is nothing to dispense for this visit.',
      );
    }

    const existing = await tx.dispense.findFirst({
      where: { encounterId, status: DispenseStatus.OPEN },
    });
    if (existing) return this.read(ctx, existing.id);

    const id = newId();
    const now = this.clock.now();

    await tx.dispense.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: encounter.branchId,
        encounterId,
        prescriptionId: prescription.id,
        patientId: encounter.patientId,
        status: DispenseStatus.OPEN,
        openedBy: ctx.userId,
        openedAt: now,
        // DSP-F-09: what the dispenser is looking at, so a later
        // amendment is detectable rather than invisible.
        rxVersionSeen: Object.fromEntries(
          prescription.items.map((item) => [item.id, item.version]),
        ),
      },
    });

    // The board should say somebody is working on it.
    if (encounter.status === EncounterStatus.PHARMACY_WAITING) {
      await tx.encounter.update({
        where: { id: encounterId },
        data: { status: EncounterStatus.DISPENSING, statusSince: now },
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseOpened,
      entityType: 'dispense',
      entityId: id,
      subjectPatientId: encounter.patientId,
      after: { prescriptionId: prescription.id, items: prescription.items.length },
    });

    this.events.publish({
      name: DomainEvent.DispenseOpened,
      tenantId: ctx.tenantId,
      branchId: encounter.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { dispenseId: id, encounterId, prescriptionId: prescription.id },
    });

    return this.read(ctx, id);
  }

  /**
   * DSP-F-02, DSP-N-04: the session, with a batch plan for every item.
   *
   * FEFO is computed here for the whole session rather than per item on
   * demand, and the running totals are carried across items so that the
   * same product prescribed twice does not have its stock counted twice
   * (§14).
   */
  async read(ctx: TenantContext, dispenseId: string) {
    const tx = this.db.tx();
    const session = await tx.dispense.findFirst({ where: { id: dispenseId } });
    if (!session) throw new NotFoundError('Dispense');

    const [prescription, done, patient] = await Promise.all([
      tx.prescription.findFirst({
        where: { id: session.prescriptionId },
        include: { items: { where: { isCurrent: true }, orderBy: { createdAt: 'asc' } } },
      }),
      tx.dispenseItem.findMany({
        where: { dispenseId },
        include: { batches: true },
        orderBy: { dispensedAt: 'asc' },
      }),
      tx.patient.findFirst({
        where: { id: session.patientId },
        select: { id: true, name: true, mrn: true, dateOfBirth: true, nkdaRecorded: true },
      }),
    ]);
    if (!prescription) throw new NotFoundError('Prescription');

    // DSP-F-02: the allergies come from the patient's record, not from
    // whatever the prescription happened to note at the time.
    const allergies = await tx.patientAllergy.findMany({
      where: { patientId: session.patientId, status: { not: 'REFUTED' } },
      select: { id: true, substance: true, severity: true, status: true, reaction: true },
    });

    const seen = (session.rxVersionSeen ?? {}) as Record<string, number>;
    const doneByRxItem = new Map(done.filter((d) => !d.reversedAt).map((d) => [d.prescriptionItemId, d]));

    // Reserved so far in this plan, per batch, so two lines for the same
    // product do not both promise the last ten.
    const reserved = new Map<string, number>();
    const items = [];

    for (const item of prescription.items) {
      const already = doneByRxItem.get(item.id);
      const product = item.productId
        ? await tx.product.findFirst({ where: { id: item.productId } })
        : null;

      const outstanding = already
        ? Math.max(0, round3(Number(item.quantity) - Number(already.quantity)))
        : Number(item.quantity);

      const plan =
        product && outstanding > 0 && !already
          ? await this.planFor(tx, session.branchId, product.id, outstanding, reserved)
          : { picks: [], shortfall: outstanding };

      items.push({
        prescriptionItemId: item.id,
        version: item.version,
        displayName: item.displayName,
        genericName: item.genericName,
        strength: item.strength,
        productId: item.productId,
        externalName: item.externalName,
        isExternal: item.isExternal,
        isControlled: item.isControlled,
        prescribedQuantity: Number(item.quantity),
        quantityUnit: item.quantityUnit,
        labelText: item.labelText,
        status: item.status,
        /** DSP-F-09: the doctor changed this after the session opened. */
        amendedSinceOpen: seen[item.id] !== undefined && seen[item.id] !== item.version,
        newSinceOpen: seen[item.id] === undefined,
        dispensed: already
          ? {
              id: already.id,
              quantity: Number(already.quantity),
              outcome: already.outcome,
              outcomeReason: already.outcomeReason,
              packRounded: already.packRounded,
              lineTotal: fromSen(already.lineTotal),
              labelPrints: already.labelPrints,
              dispensedAt: already.dispensedAt,
              canUndo: this.withinUndoWindow(already.dispensedAt),
              batches: already.batches.map((b) => ({
                batchId: b.batchId,
                quantity: Number(b.quantity),
                wasSuggested: b.wasSuggested,
                overrideReason: b.overrideReason,
              })),
            }
          : null,
        suggestion: plan.picks,
        shortfall: plan.shortfall,
        unitPrice: product ? fromSen(product.sellingPrice) : null,
      });
    }

    return {
      id: session.id,
      status: session.status,
      encounterId: session.encounterId,
      prescriptionId: session.prescriptionId,
      branchId: session.branchId,
      openedAt: session.openedAt,
      completedAt: session.completedAt,
      counselled: session.counselled,
      notes: session.notes,
      patient,
      allergies,
      language: prescription.language,
      notesToDispenser: prescription.notesToDispenser,
      items,
    };
  }

  // -------------------------------------------------------------------
  // Dispensing (DSP-F-10, F-11)
  // -------------------------------------------------------------------

  async dispenseItem(
    ctx: TenantContext,
    dispenseId: string,
    prescriptionItemId: string,
    input: DispenseItemInput,
  ) {
    const tx = this.db.tx();

    // DSP-F-11. Checked first, so a retry never reaches the ledger.
    if (input.idempotencyKey) {
      const already = await tx.dispenseItem.findFirst({
        where: { idempotencyKey: input.idempotencyKey },
        include: { batches: true },
      });
      if (already) return this.presentItem(already, { replayed: true });
    }

    const session = await this.openSessionOrThrow(tx, dispenseId);
    const item = await tx.prescriptionItem.findFirst({ where: { id: prescriptionItemId } });
    if (!item) throw new NotFoundError('Prescription item');
    if (item.prescriptionId !== session.prescriptionId) {
      throw new NotFoundError('Prescription item');
    }
    if (!item.isCurrent) {
      throw new ConflictError(
        'This version of the item has been replaced. Reload the session.',
        'item_superseded',
      );
    }
    if (
      item.status !== PrescriptionItemStatus.ACTIVE &&
      item.status !== PrescriptionItemStatus.PARTIAL
    ) {
      throw new ConflictError(
        `This item is already ${item.status.toLowerCase()}.`,
        'item_not_pending',
      );
    }

    const outcome = input.outcome ?? DispenseOutcome.DISPENSED;

    // The three outcomes where nothing leaves the shelf.
    if (
      outcome === DispenseOutcome.EXTERNAL ||
      outcome === DispenseOutcome.DECLINED
    ) {
      return this.recordNonDispense(tx, ctx, session, item, outcome, input.reason ?? null);
    }

    if (item.isExternal || !item.productId) {
      throw new ConflictError(
        'This was written for the patient to have filled elsewhere, so there is nothing here to hand over.',
        'item_is_external',
      );
    }

    const product = await tx.product.findFirst({ where: { id: item.productId } });
    if (!product) throw new NotFoundError('Product');

    // What is being handed over, before pack rounding.
    const prescribed = Number(item.quantity);
    const asked = input.quantity ?? prescribed;
    if (!(asked > 0)) {
      throw new BadRequestError('Say how much is being handed over.', 'invalid_quantity');
    }
    // DSP-R-04: never more than prescribed, except the pack.
    if (asked > prescribed) {
      throw new InvariantViolationError(
        'over_dispense',
        `${prescribed} ${item.quantityUnit} were prescribed and this would hand over ${asked}.`,
        { prescribed, asked },
      );
    }

    const rounding = roundToPacks(asked, {
      isPackDispensed: product.isPackDispensed,
      packSize: product.packSize,
      dispenseUnit: product.dispenseUnit,
    });
    const quantity = rounding.quantity;

    const partial = quantity < prescribed;
    if (partial && !(input.reason ?? '').trim()) {
      throw new BadRequestError(
        'Say why less than the prescribed amount is being handed over.',
        'partial_reason_required',
      );
    }

    // One FEFO pass, used both to fill in a request that named no
    // batches and to judge one that did (DSP-N-04).
    const suggestion = await this.planFor(tx, session.branchId, product.id, quantity, new Map());
    const suggested = new Set(suggestion.picks.map((pick) => pick.batchId));

    const chosen: BatchChoice[] =
      input.batches && input.batches.length > 0
        ? input.batches
        : suggestion.picks.map((pick) => ({ batchId: pick.batchId, quantity: pick.quantity }));

    if (chosen.length === 0) {
      throw new InvariantViolationError(
        'no_stock',
        `There is none of ${product.name} on the shelf at this branch.`,
        { productId: product.id },
      );
    }

    const chosenTotal = round3(chosen.reduce((sum, line) => sum + line.quantity, 0));
    if (chosenTotal !== quantity) {
      throw new BadRequestError(
        `The batches add up to ${chosenTotal} but ${quantity} is being handed over.`,
        'batches_do_not_add_up',
      );
    }

    // DSP-R-07: choosing against FEFO needs a reason. Checked before
    // anything is written, so the refusal is cheap.
    for (const line of chosen) {
      if (suggested.has(line.batchId)) continue;
      if (!(line.overrideReason ?? '').trim()) {
        const batch = await tx.productBatch.findFirst({ where: { id: line.batchId } });
        throw new InvariantViolationError(
          'batch_override_needs_reason',
          `Batch ${batch?.batchNo ?? line.batchId} is not the one that expires first. ` +
            'Say why it is being used.',
          { batchId: line.batchId, suggested: [...suggested] },
        );
      }
    }

    const now = this.clock.now();
    const unitPrice = product.sellingPrice;
    const lineTotal = BigInt(Math.round(quantity * Number(unitPrice)));

    const dispenseItemId = newId();
    await tx.dispenseItem.create({
      data: {
        id: dispenseItemId,
        tenantId: requireTenantId(),
        dispenseId: session.id,
        prescriptionItemId: item.id,
        prescriptionItemVersion: item.version,
        productId: product.id,
        quantity,
        quantityUnit: product.dispenseUnit,
        packRounded: rounding.packRounded,
        unitPrice,
        lineTotal,
        outcome: partial ? DispenseOutcome.PARTIAL : DispenseOutcome.DISPENSED,
        outcomeReason: rounding.note ?? input.reason?.trim() ?? null,
        labelText: item.labelText,
        counselled: input.counselled ?? null,
        dispensedBy: ctx.userId,
        dispensedAt: now,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    // The stock, batch by batch, through the one write path.
    for (const line of chosen) {
      await this.assertUsable(tx, session.branchId, product.id, line.batchId);
      const moved = await this.ledger.move(tx, ctx, {
        batchId: line.batchId,
        type: StockMovementType.DISPENSE,
        quantity: line.quantity,
        referenceType: 'dispense_item',
        referenceId: dispenseItemId,
      });
      await tx.dispenseItemBatch.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          dispenseItemId,
          batchId: line.batchId,
          quantity: line.quantity,
          wasSuggested: suggested.has(line.batchId),
          overrideReason: line.overrideReason?.trim() || null,
          stockMovementId: moved.movement.id,
        },
      });
    }

    // DSP-F-18. Inside the same transaction, and the database checks at
    // commit that it happened.
    if (product.isControlled) {
      await this.registerControlled(tx, ctx, {
        session,
        item,
        product,
        dispenseItemId,
        quantity,
        batchIds: chosen.map((line) => line.batchId),
        witness: input.register ?? null,
      });
    }

    // BIL-R-06, BIL-R-11: the invoice line is built from what was
    // actually handed over, at the price it was handed over at, inside
    // this transaction. Billing and the shelf agree or neither happens.
    await this.charges.record(tx, ctx, {
      encounterId: session.encounterId,
      branchId: session.branchId,
      patientId: session.patientId,
      lineType: 'MEDICINE',
      sourceType: 'dispense_item',
      sourceId: dispenseItemId,
      description: [product.name, product.strengthText].filter(Boolean).join(' '),
      quantity,
      quantityUnit: product.dispenseUnit,
      unitPriceSen: unitPrice,
      occurredAt: now,
    });

    // RX owns the item's status, and settles the prescription.
    await this.prescriptions.recordDispenseOutcome(
      tx,
      ctx,
      item.id,
      partial ? PrescriptionItemStatus.PARTIAL : PrescriptionItemStatus.DISPENSED,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseItemDispensed,
      entityType: 'dispense_item',
      entityId: dispenseItemId,
      subjectPatientId: session.patientId,
      after: {
        product: product.name,
        quantity,
        prescribed,
        packRounded: rounding.packRounded,
        lineTotal: fromSen(lineTotal),
        batches: chosen.map((line) => ({
          batchId: line.batchId,
          quantity: line.quantity,
          override: line.overrideReason ?? null,
        })),
      },
    });

    /**
     * DSP-R-06: BIL builds the invoice line from this, never from the
     * prescription. Nothing consumes it yet — billing is Phase 4 — so
     * the money sits on the row until it does.
     */
    this.events.publish({
      name: partial ? DomainEvent.DispensePartial : DomainEvent.DispenseCompleted,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        dispenseId: session.id,
        encounterId: session.encounterId,
        patientId: session.patientId,
        items: [
          {
            dispenseItemId,
            rxItemId: item.id,
            productId: product.id,
            quantity,
            unitPriceSen: Number(unitPrice),
            lineTotalSen: Number(lineTotal),
          },
        ],
      },
    });

    const created = await tx.dispenseItem.findFirstOrThrow({
      where: { id: dispenseItemId },
      include: { batches: true },
    });
    return this.presentItem(created, { note: rounding.note });
  }

  /** DSP-F-08: nothing leaves the shelf, and nothing is billed. */
  private async recordNonDispense(
    tx: Tx,
    ctx: TenantContext,
    session: { id: string; branchId: string; patientId: string; encounterId: string },
    item: { id: string; version: number; productId: string | null; labelText: string; quantityUnit: string },
    outcome: DispenseOutcome,
    reason: string | null,
  ) {
    if (!(reason ?? '').trim()) {
      throw new BadRequestError(
        outcome === DispenseOutcome.DECLINED
          ? 'Say why the patient did not take it.'
          : 'Say why this is being obtained elsewhere.',
        'reason_required',
      );
    }

    const id = newId();
    const now = this.clock.now();
    await tx.dispenseItem.create({
      data: {
        id,
        tenantId: requireTenantId(),
        dispenseId: session.id,
        prescriptionItemId: item.id,
        prescriptionItemVersion: item.version,
        productId: item.productId,
        quantity: 0,
        quantityUnit: item.quantityUnit,
        unitPrice: 0n,
        lineTotal: 0n,
        outcome,
        outcomeReason: reason!.trim(),
        labelText: item.labelText,
        dispensedBy: ctx.userId,
        dispensedAt: now,
      },
    });

    await this.prescriptions.recordDispenseOutcome(
      tx,
      ctx,
      item.id,
      PrescriptionItemStatus.DECLINED,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action:
        outcome === DispenseOutcome.DECLINED
          ? AuditAction.DispenseItemDeclined
          : AuditAction.DispenseItemExternal,
      entityType: 'dispense_item',
      entityId: id,
      subjectPatientId: session.patientId,
      reason: reason!.trim(),
    });

    this.events.publish({
      name:
        outcome === DispenseOutcome.DECLINED
          ? DomainEvent.DispenseItemDeclined
          : DomainEvent.DispenseItemExternal,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { dispenseId: session.id, rxItemId: item.id, reason: reason!.trim() },
    });

    const created = await tx.dispenseItem.findFirstOrThrow({
      where: { id },
      include: { batches: true },
    });
    return this.presentItem(created);
  }

  /** DSP-F-07: a different product, with the original kept. */
  async substitute(
    ctx: TenantContext,
    dispenseId: string,
    prescriptionItemId: string,
    input: { productId: string; reason: string; quantity?: number; idempotencyKey?: string | null },
  ) {
    if ((input.reason ?? '').trim().length < 3) {
      throw new BadRequestError('Say why a different product is being used.', 'reason_required');
    }

    const tx = this.db.tx();
    const session = await this.openSessionOrThrow(tx, dispenseId);
    const item = await tx.prescriptionItem.findFirst({ where: { id: prescriptionItemId } });
    if (!item) throw new NotFoundError('Prescription item');

    const replacement = await tx.product.findFirst({ where: { id: input.productId } });
    if (!replacement) throw new NotFoundError('Product');
    if (replacement.type !== ProductType.MEDICINE || replacement.status !== ProductStatus.ACTIVE) {
      throw new BadRequestError(
        `${replacement.name} is not a medicine that can be dispensed.`,
        'not_dispensable',
      );
    }

    // DSP-T-11: swapping brands of the same generic is routine. Swapping
    // the generic is a clinical decision, and needs the permission that
    // says so.
    const sameGeneric =
      (replacement.genericName ?? '').trim().toLowerCase() ===
      item.genericName.trim().toLowerCase();
    if (!sameGeneric && !ctx.permissions.has('dispense.substitute')) {
      throw new ForbiddenError(
        `${replacement.name} is a different medicine, not another brand of the same one. ` +
          'That is a prescribing decision.',
        { prescribed: item.genericName, offered: replacement.genericName },
      );
    }

    // The original is recorded as replaced, and the replacement is a
    // normal dispense of a different product.
    const outId = newId();
    const now = this.clock.now();
    await tx.dispenseItem.create({
      data: {
        id: outId,
        tenantId: requireTenantId(),
        dispenseId: session.id,
        prescriptionItemId: item.id,
        prescriptionItemVersion: item.version,
        productId: item.productId,
        quantity: 0,
        quantityUnit: item.quantityUnit,
        unitPrice: 0n,
        lineTotal: 0n,
        outcome: DispenseOutcome.SUBSTITUTED_OUT,
        outcomeReason: input.reason.trim(),
        labelText: item.labelText,
        dispensedBy: ctx.userId,
        dispensedAt: now,
      },
    });

    const quantity = input.quantity ?? Number(item.quantity);
    const rounding = roundToPacks(quantity, {
      isPackDispensed: replacement.isPackDispensed,
      packSize: replacement.packSize,
      dispenseUnit: replacement.dispenseUnit,
    });

    const plan = await this.planFor(
      tx,
      session.branchId,
      replacement.id,
      rounding.quantity,
      new Map(),
    );
    if (plan.shortfall > 0) {
      throw new InvariantViolationError(
        'no_stock',
        `There is not enough ${replacement.name} either: ${rounding.quantity - plan.shortfall} of ${rounding.quantity}.`,
        { productId: replacement.id, shortfall: plan.shortfall },
      );
    }

    const newId_ = newId();
    await tx.dispenseItem.create({
      data: {
        id: newId_,
        tenantId: requireTenantId(),
        dispenseId: session.id,
        prescriptionItemId: item.id,
        prescriptionItemVersion: item.version,
        productId: replacement.id,
        isSubstitute: true,
        substituteReason: input.reason.trim(),
        originalProductId: item.productId,
        quantity: rounding.quantity,
        quantityUnit: replacement.dispenseUnit,
        packRounded: rounding.packRounded,
        unitPrice: replacement.sellingPrice,
        lineTotal: BigInt(Math.round(rounding.quantity * Number(replacement.sellingPrice))),
        outcome: DispenseOutcome.DISPENSED,
        outcomeReason: rounding.note,
        labelText: item.labelText,
        dispensedBy: ctx.userId,
        dispensedAt: now,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    for (const pick of plan.picks) {
      await this.assertUsable(tx, session.branchId, replacement.id, pick.batchId);
      const moved = await this.ledger.move(tx, ctx, {
        batchId: pick.batchId,
        type: StockMovementType.DISPENSE,
        quantity: pick.quantity,
        referenceType: 'dispense_item',
        referenceId: newId_,
      });
      await tx.dispenseItemBatch.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          dispenseItemId: newId_,
          batchId: pick.batchId,
          quantity: pick.quantity,
          wasSuggested: true,
          stockMovementId: moved.movement.id,
        },
      });
    }

    await this.charges.record(tx, ctx, {
      encounterId: session.encounterId,
      branchId: session.branchId,
      patientId: session.patientId,
      lineType: 'MEDICINE',
      sourceType: 'dispense_item',
      sourceId: newId_,
      description: [replacement.name, replacement.strengthText].filter(Boolean).join(' '),
      quantity: rounding.quantity,
      quantityUnit: replacement.dispenseUnit,
      unitPriceSen: replacement.sellingPrice,
      occurredAt: now,
    });

    if (replacement.isControlled) {
      await this.registerControlled(tx, ctx, {
        session,
        item,
        product: replacement,
        dispenseItemId: newId_,
        quantity: rounding.quantity,
        batchIds: plan.picks.map((pick) => pick.batchId),
        witness: null,
      });
    }

    await this.prescriptions.recordDispenseOutcome(
      tx,
      ctx,
      item.id,
      PrescriptionItemStatus.DISPENSED,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseItemSubstituted,
      entityType: 'dispense_item',
      entityId: newId_,
      subjectPatientId: session.patientId,
      reason: input.reason.trim(),
      before: { product: item.displayName, generic: item.genericName },
      after: { product: replacement.name, generic: replacement.genericName, sameGeneric },
    });

    this.events.publish({
      name: DomainEvent.DispenseItemSubstituted,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        dispenseId: session.id,
        rxItemId: item.id,
        from: item.productId,
        to: replacement.id,
        sameGeneric,
        reason: input.reason.trim(),
      },
    });

    return this.read(ctx, session.id);
  }

  // -------------------------------------------------------------------
  // Undoing and returning
  // -------------------------------------------------------------------

  /** DSP-F-16, DSP-R-05: the wrong batch was scanned a minute ago. */
  async undo(ctx: TenantContext, dispenseItemId: string, reason: string) {
    if ((reason ?? '').trim().length < 3) {
      throw new BadRequestError('Say what went wrong.', 'reason_required');
    }

    const tx = this.db.tx();
    const item = await tx.dispenseItem.findFirst({
      where: { id: dispenseItemId },
      include: { batches: true },
    });
    if (!item) throw new NotFoundError('Dispense item');
    if (item.reversedAt) {
      throw new ConflictError('This has already been undone.', 'already_reversed');
    }

    const session = await tx.dispense.findFirst({ where: { id: item.dispenseId } });
    if (!session) throw new NotFoundError('Dispense');
    if (session.status !== DispenseStatus.OPEN) {
      throw new ConflictError(
        'This session is finished. Record a return instead.',
        'session_closed',
      );
    }
    if (!this.withinUndoWindow(item.dispensedAt)) {
      const minutes = Math.floor(
        (this.clock.now().getTime() - item.dispensedAt.getTime()) / 60_000,
      );
      throw new ConflictError(
        `This was handed over ${minutes} minutes ago. After ${UNDO_WINDOW_MINUTES} minutes ` +
          'the patient has it; record a return instead.',
        'undo_window_passed',
      );
    }

    const now = this.clock.now();
    for (const line of item.batches) {
      if (line.reversalMovementId) continue;
      const moved = await this.ledger.move(tx, ctx, {
        batchId: line.batchId,
        type: StockMovementType.DISPENSE_REVERSAL,
        quantity: Number(line.quantity),
        referenceType: 'dispense_item_undo',
        referenceId: item.id,
        reasonText: reason.trim(),
      });
      await tx.dispenseItemBatch.update({
        where: { id: line.id },
        data: { reversalMovementId: moved.movement.id },
      });
    }

    await tx.dispenseItem.update({
      where: { id: dispenseItemId },
      data: { reversedAt: now, reversedBy: ctx.userId, reversalReason: reason.trim() },
    });

    // The register is append-only, so an undo is a correcting entry.
    // An item with no product dispensed nothing, so there is nothing to
    // correct.
    const product = item.productId
      ? await tx.product.findFirst({ where: { id: item.productId } })
      : null;
    if (product?.isControlled && item.productId) {
      await this.register.record(tx, ctx, {
        branchId: session.branchId,
        productId: item.productId,
        entryType: ControlledEntryType.ADJUST,
        referenceType: 'dispense_item_undo',
        referenceId: item.id,
        quantityIn: Number(item.quantity),
        prescriberName: 'Undo of a dispense',
      });
    }

    // The charge goes with it. Billing refuses if the invoice has
    // already been issued, which is the correct place for that refusal.
    await this.charges.remove(tx, ctx, {
      sourceType: 'dispense_item',
      sourceId: item.id,
    });

    // Back to waiting: the prescription item is unfinished again.
    await this.prescriptions.recordDispenseOutcome(
      tx,
      ctx,
      item.prescriptionItemId,
      PrescriptionItemStatus.ACTIVE,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseUndone,
      entityType: 'dispense_item',
      entityId: dispenseItemId,
      subjectPatientId: session.patientId,
      reason: reason.trim(),
      before: { quantity: Number(item.quantity), outcome: item.outcome },
    });

    this.events.publish({
      name: DomainEvent.DispenseUndone,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        dispenseItemId,
        dispenseId: session.id,
        // What BIL has to take off again.
        lineTotalSen: Number(item.lineTotal),
        reason: reason.trim(),
      },
    });

    return this.read(ctx, session.id);
  }

  /**
   * DSP-F-17: handed back after the fact.
   *
   * It does **not** go back into saleable stock. Nobody knows how it was
   * stored between here and the patient's kitchen, so it is counted as
   * quarantined — off the shelf, still on the premises, and visible to
   * whoever decides whether to destroy it.
   */
  async recordReturn(
    ctx: TenantContext,
    dispenseItemId: string,
    input: { quantity: number; reason: string },
  ) {
    if ((input.reason ?? '').trim().length < 3) {
      throw new BadRequestError('Say why it came back.', 'reason_required');
    }

    const tx = this.db.tx();
    const item = await tx.dispenseItem.findFirst({
      where: { id: dispenseItemId },
      include: { batches: true },
    });
    if (!item) throw new NotFoundError('Dispense item');
    if (item.reversedAt) {
      throw new ConflictError('This was undone; there is nothing to return.', 'already_reversed');
    }

    const dispensed = Number(item.quantity);
    const already = Number(item.returnedQuantity ?? 0);
    if (!(input.quantity > 0) || round3(already + input.quantity) > dispensed) {
      throw new BadRequestError(
        `${dispensed} were handed over and ${already} already came back.`,
        'invalid_quantity',
      );
    }

    const session = await tx.dispense.findFirst({ where: { id: item.dispenseId } });
    if (!session) throw new NotFoundError('Dispense');

    // Spread the return across the batches it came from, largest first,
    // so a returned pack is attributed to a real lot rather than to
    // "somewhere".
    let left = round3(input.quantity);
    for (const line of [...item.batches].sort((a, b) => Number(b.quantity) - Number(a.quantity))) {
      if (left <= 0) break;
      const take = Math.min(Number(line.quantity), left);
      // Quarantine is not part of the on-hand invariant, so this is a
      // direct write rather than a ledger movement. INV-OPEN-05 is the
      // workflow that will manage what happens to it next.
      const batch = await tx.productBatch.findFirst({ where: { id: line.batchId } });
      if (batch) {
        await tx.productBatch.update({
          where: { id: line.batchId },
          data: { quantityQuarantined: round3(Number(batch.quantityQuarantined) + take) },
        });
      }
      left = round3(left - take);
    }

    const now = this.clock.now();
    await tx.dispenseItem.update({
      where: { id: dispenseItemId },
      data: {
        returnedQuantity: round3(already + input.quantity),
        returnedAt: now,
        returnedBy: ctx.userId,
        returnReason: input.reason.trim(),
      },
    });

    const product = item.productId
      ? await tx.product.findFirst({ where: { id: item.productId } })
      : null;
    if (product?.isControlled && item.productId) {
      await this.register.record(tx, ctx, {
        branchId: session.branchId,
        productId: item.productId,
        entryType: ControlledEntryType.RETURN,
        referenceType: 'dispense_item_return',
        referenceId: item.id,
        quantityIn: input.quantity,
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseReturned,
      entityType: 'dispense_item',
      entityId: dispenseItemId,
      subjectPatientId: session.patientId,
      reason: input.reason.trim(),
      after: { returned: input.quantity, quarantined: true },
    });

    this.events.publish({
      name: DomainEvent.DispenseReturned,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { dispenseItemId, quantity: input.quantity, reason: input.reason.trim() },
    });

    return this.presentItem(
      await tx.dispenseItem.findFirstOrThrow({
        where: { id: dispenseItemId },
        include: { batches: true },
      }),
    );
  }

  // -------------------------------------------------------------------
  // Finishing (DSP-F-14)
  // -------------------------------------------------------------------

  async complete(ctx: TenantContext, dispenseId: string, input: { counselled?: boolean } = {}) {
    const tx = this.db.tx();
    const session = await this.openSessionOrThrow(tx, dispenseId);

    const prescription = await tx.prescription.findFirst({
      where: { id: session.prescriptionId },
      include: { items: { where: { isCurrent: true } } },
    });
    if (!prescription) throw new NotFoundError('Prescription');

    const pending = prescription.items.filter(
      (item) =>
        item.status === PrescriptionItemStatus.ACTIVE ||
        item.status === PrescriptionItemStatus.PARTIAL,
    );
    if (pending.length > 0) {
      throw new InvariantViolationError(
        'items_outstanding',
        pending.length === 1
          ? `${pending[0]!.displayName} has not been dealt with. Dispense it, or mark it declined or external.`
          : `${pending.length} items have not been dealt with.`,
        { pending: pending.map((item) => ({ id: item.id, name: item.displayName })) },
      );
    }

    const now = this.clock.now();
    await tx.dispense.update({
      where: { id: dispenseId },
      data: {
        status: DispenseStatus.COMPLETED,
        completedBy: ctx.userId,
        completedAt: now,
        ...(input.counselled === undefined
          ? {}
          : { counselled: input.counselled, counselledBy: ctx.userId }),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseCompleted,
      entityType: 'dispense',
      entityId: dispenseId,
      subjectPatientId: session.patientId,
      after: { counselled: input.counselled ?? null },
    });

    this.events.publish({
      name: DomainEvent.DispenseSessionCompleted,
      tenantId: ctx.tenantId,
      branchId: session.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { dispenseId, encounterId: session.encounterId },
    });

    return this.read(ctx, dispenseId);
  }

  /** Nothing was handed over; the patient goes back on the board. */
  async cancel(ctx: TenantContext, dispenseId: string, reason: string) {
    const tx = this.db.tx();
    const session = await this.openSessionOrThrow(tx, dispenseId);

    const dispensed = await tx.dispenseItem.count({
      where: { dispenseId, reversedAt: null, outcome: { not: DispenseOutcome.SUBSTITUTED_OUT } },
    });
    if (dispensed > 0) {
      throw new ConflictError(
        'Something has already been handed over in this session, so it cannot simply be abandoned. ' +
          'Undo what was dispensed, or finish it.',
        'session_has_items',
      );
    }

    const now = this.clock.now();
    await tx.dispense.update({
      where: { id: dispenseId },
      data: { status: DispenseStatus.CANCELLED, notes: reason?.trim() || null },
    });

    // Back to waiting, for whoever picks it up next.
    await tx.encounter.update({
      where: { id: session.encounterId },
      data: { status: EncounterStatus.PHARMACY_WAITING, statusSince: now },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DispenseCancelled,
      entityType: 'dispense',
      entityId: dispenseId,
      subjectPatientId: session.patientId,
      reason: reason?.trim() || null,
    });

    return { cancelled: true };
  }

  /** DSP-F-12: what goes on the bag, and how many times it has printed. */
  async label(ctx: TenantContext, dispenseItemId: string) {
    const tx = this.db.tx();
    const item = await tx.dispenseItem.findFirst({
      where: { id: dispenseItemId },
      include: { batches: true },
    });
    if (!item) throw new NotFoundError('Dispense item');

    const [session, product, tenant] = await Promise.all([
      tx.dispense.findFirst({ where: { id: item.dispenseId } }),
      item.productId
        ? tx.product.findFirst({ where: { id: item.productId } })
        : Promise.resolve(null),
      tx.tenant.findFirst({ select: { name: true } }),
    ]);
    if (!session) throw new NotFoundError('Dispense');

    const [patient, branch] = await Promise.all([
      tx.patient.findFirst({
        where: { id: session.patientId },
        select: { name: true, mrn: true },
      }),
      tx.branch.findFirst({
        where: { id: session.branchId },
        select: { name: true, phone: true },
      }),
    ]);

    const batches = await tx.productBatch.findMany({
      where: { id: { in: item.batches.map((b) => b.batchId) } },
      select: { id: true, batchNo: true, expiryDate: true },
    });

    await tx.dispenseItem.update({
      where: { id: dispenseItemId },
      data: { labelPrints: item.labelPrints + 1 },
    });

    // A reprint is worth noticing: a label printed three times is either
    // a printer problem or a bag that went to the wrong patient.
    if (item.labelPrints > 0) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.LabelReprinted,
        entityType: 'dispense_item',
        entityId: dispenseItemId,
        subjectPatientId: session.patientId,
        after: { print: item.labelPrints + 1 },
      });
    }

    return {
      clinic: tenant?.name ?? '',
      branch: branch?.name ?? '',
      phone: branch?.phone ?? null,
      patientName: patient?.name ?? '',
      patientMrn: patient?.mrn ?? '',
      dispensedAt: item.dispensedAt,
      product: product?.name ?? '',
      strength: product?.strengthText ?? null,
      quantity: Number(item.quantity),
      quantityUnit: item.quantityUnit,
      /** RX generated this, in the patient's language. */
      instructions: item.labelText,
      batches: batches.map((batch) => ({
        batchNo: batch.batchNo,
        expiry: batch.expiryDate,
      })),
      warnings: [
        'Simpan jauh dari jangkauan kanak-kanak.',
        'Keep out of reach of children.',
        ...(product?.isControlled ? ['Ubat terkawal — Controlled medicine'] : []),
        ...(product?.isColdChain ? ['Simpan dalam peti sejuk 2–8 °C'] : []),
      ],
      printCount: item.labelPrints + 1,
    };
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /**
   * FEFO across a session, carrying what earlier lines already claimed.
   *
   * §14: the same product prescribed twice must not have its stock
   * counted twice, which is what `reserved` is for.
   */
  private async planFor(
    tx: Tx,
    branchId: string,
    productId: string,
    quantity: number,
    reserved: Map<string, number>,
  ) {
    const plan = await this.ledger.suggestFefo(tx, branchId, productId, quantity);

    const picks: typeof plan.picks = [];
    let left = round3(quantity);

    for (const pick of plan.picks) {
      if (left <= 0) break;
      const taken = reserved.get(pick.batchId) ?? 0;
      const free = round3(pick.available - taken);
      if (free <= 0) continue;
      const take = Math.min(free, left);
      picks.push({ ...pick, quantity: round3(take) });
      reserved.set(pick.batchId, round3(taken + take));
      left = round3(left - take);
    }

    return { picks, shortfall: Math.max(0, left) };
  }

  /** DSP-R-02: what may not be handed over, whatever the dispenser picked. */
  private async assertUsable(tx: Tx, branchId: string, productId: string, batchId: string) {
    const batch = await tx.productBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundError('Batch');
    if (batch.branchId !== branchId || batch.productId !== productId) {
      throw new BadRequestError(
        'That batch is not this product at this branch.',
        'batch_mismatch',
      );
    }
    if (batch.status === BatchStatus.BLOCKED) {
      throw new InvariantViolationError(
        'batch_blocked',
        `Batch ${batch.batchNo} is blocked and cannot be dispensed.`,
        { batchId },
      );
    }
    if (batch.status === BatchStatus.EXPIRED || (batch.expiryDate && batch.expiryDate < this.today())) {
      throw new InvariantViolationError(
        'batch_expired',
        `Batch ${batch.batchNo} expired on ${batch.expiryDate?.toISOString().slice(0, 10)} and cannot be dispensed.`,
        { batchId },
      );
    }
  }

  private async registerControlled(
    tx: Tx,
    ctx: TenantContext,
    input: {
      session: { branchId: string; patientId: string };
      item: { id: string };
      product: { id: string; name: string };
      dispenseItemId: string;
      quantity: number;
      batchIds: string[];
      witness: { witnessId?: string | null; witnessName?: string | null } | null;
    },
  ) {
    const patient = await tx.patient.findFirst({
      where: { id: input.session.patientId },
      select: { id: true, name: true, idNumber: true },
    });
    const prescription = await tx.prescriptionItem.findFirst({
      where: { id: input.item.id },
      select: { prescription: { select: { prescribedBy: true } } },
    });
    const prescriber = prescription?.prescription.prescribedBy
      ? await tx.user.findFirst({
          where: { id: prescription.prescription.prescribedBy },
          select: { id: true, name: true },
        })
      : null;
    const batch = input.batchIds[0]
      ? await tx.productBatch.findFirst({
          where: { id: input.batchIds[0] },
          select: { id: true, batchNo: true },
        })
      : null;

    if (!patient?.idNumber) {
      throw new InvariantViolationError(
        'controlled_needs_identity',
        `The register needs ${patient?.name ?? 'the patient'}'s identity number, and none is recorded. ` +
          'Add it to their file before dispensing a controlled medicine.',
        { patientId: input.session.patientId },
      );
    }

    const entry = await this.register.record(tx, ctx, {
      branchId: input.session.branchId,
      productId: input.product.id,
      entryType: ControlledEntryType.DISPENSE,
      referenceType: 'dispense_item',
      referenceId: input.dispenseItemId,
      patientId: patient.id,
      patientName: patient.name,
      patientIc: patient.idNumber,
      prescriberId: prescriber?.id ?? null,
      prescriberName: prescriber?.name ?? null,
      batchId: batch?.id ?? null,
      batchNo: batch?.batchNo ?? null,
      quantityOut: input.quantity,
      witnessId: input.witness?.witnessId ?? null,
      witnessName: input.witness?.witnessName ?? null,
    });

    this.events.publish({
      name: DomainEvent.ControlledDispensed,
      tenantId: ctx.tenantId,
      branchId: input.session.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: {
        registerId: entry.id,
        productId: input.product.id,
        quantity: input.quantity,
        balanceAfter: entry.balanceAfter,
      },
    });
  }

  private async openSessionOrThrow(tx: Tx, dispenseId: string) {
    const session = await tx.dispense.findFirst({ where: { id: dispenseId } });
    if (!session) throw new NotFoundError('Dispense');
    if (session.status !== DispenseStatus.OPEN) {
      throw new ConflictError(
        `This dispensing session is ${session.status.toLowerCase()}.`,
        'session_not_open',
      );
    }
    return session;
  }

  private withinUndoWindow(dispensedAt: Date): boolean {
    return this.clock.now().getTime() - dispensedAt.getTime() <= UNDO_WINDOW_MINUTES * 60_000;
  }

  private today(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private presentItem(
    row: {
      id: string;
      dispenseId: string;
      prescriptionItemId: string;
      productId: string | null;
      isSubstitute: boolean;
      substituteReason: string | null;
      originalProductId: string | null;
      quantity: unknown;
      quantityUnit: string;
      packRounded: boolean;
      unitPrice: bigint;
      lineTotal: bigint;
      outcome: DispenseOutcome;
      outcomeReason: string | null;
      labelText: string;
      labelPrints: number;
      dispensedAt: Date;
      reversedAt: Date | null;
      reversalReason: string | null;
      returnedQuantity: unknown;
      batches: Array<{ batchId: string; quantity: unknown; wasSuggested: boolean; overrideReason: string | null }>;
    },
    extra: { replayed?: boolean; note?: string | null } = {},
  ) {
    return {
      id: row.id,
      dispenseId: row.dispenseId,
      prescriptionItemId: row.prescriptionItemId,
      productId: row.productId,
      isSubstitute: row.isSubstitute,
      substituteReason: row.substituteReason,
      originalProductId: row.originalProductId,
      quantity: Number(row.quantity),
      quantityUnit: row.quantityUnit,
      packRounded: row.packRounded,
      unitPrice: fromSen(row.unitPrice),
      lineTotal: fromSen(row.lineTotal),
      outcome: row.outcome,
      outcomeReason: row.outcomeReason,
      labelText: row.labelText,
      labelPrints: row.labelPrints,
      dispensedAt: row.dispensedAt,
      reversedAt: row.reversedAt,
      reversalReason: row.reversalReason,
      returnedQuantity: row.returnedQuantity === null ? null : Number(row.returnedQuantity),
      canUndo: row.reversedAt === null && this.withinUndoWindow(row.dispensedAt),
      batches: row.batches.map((batch) => ({
        batchId: batch.batchId,
        quantity: Number(batch.quantity),
        wasSuggested: batch.wasSuggested,
        overrideReason: batch.overrideReason,
      })),
      /** True when this response is a replay of an earlier request. */
      replayed: extra.replayed ?? false,
      note: extra.note ?? null,
    };
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
