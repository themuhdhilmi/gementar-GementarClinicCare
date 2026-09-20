import { Injectable, Logger } from '@nestjs/common';
import {
  BatchStatus,
  ConsultationStatus,
  Laterality,
  ProcedureCategory,
  ProcedureStatus,
  ProductStatus,
  Role,
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
import { DomainEvent } from '../events/domain-events.js';
import { fromSen } from '../catalogue/money.js';
import { LedgerService } from '../stock/ledger.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** PRC-F-10: after this long, a void is a billing correction, not a fix. */
export const VOID_WINDOW_HOURS = 24;

/** Where a needle or a dressing went. Required for the ones that have a site. */
const SITE_REQUIRED = new Set<ProcedureCategory>([
  ProcedureCategory.INJECTION,
  ProcedureCategory.VACCINATION,
  ProcedureCategory.DRESSING,
]);

export type PerformInput = {
  consumables?: Array<{ productId: string; batchId?: string | null; quantity: number }>;
  site?: string | null;
  laterality?: Laterality | null;
  consentGiven?: boolean;
  consentBy?: string | null;
  notes?: string | null;
  complications?: string | null;
  doseNumber?: number | null;
  /**
   * PRC §14: the shelf is empty and the nurse used something from a box
   * nobody had recorded. Better said out loud than silently not deducted.
   */
  allowShortfall?: boolean;
};

/**
 * Procedures (PRC, v0-10-procedures.md).
 *
 * Ordering is cheap. Performing is the interesting part, and it happens
 * in one transaction: the consumables leave stock through the ledger, the
 * row becomes PERFORMED, a vaccination writes its record, and the event
 * that BIL will price goes out. If any of it fails none of it happened,
 * because a nebuliser that deducted its mask but not its respule is a
 * stock figure nobody can reconstruct.
 */
@Injectable()
export class ProcedureService {
  private readonly logger = new Logger(ProcedureService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly ledger: LedgerService,
  ) {}

  // -------------------------------------------------------------------
  // Ordering (PRC-F-05, PRC-F-06)
  // -------------------------------------------------------------------

  async order(
    ctx: TenantContext,
    encounterId: string,
    input: { procedureId: string; consultationId?: string | null; quantity?: number },
  ) {
    const tx = this.db.tx();
    const encounter = await this.encounterOrThrow(tx, encounterId);
    const procedure = await this.catalogueOrThrow(tx, input.procedureId);

    if (procedure.status !== ProductStatus.ACTIVE) {
      throw new ConflictError(
        `${procedure.name} is no longer offered.`,
        'procedure_retired',
      );
    }

    // PRC-F-06. A doctor orders; a nurse may start one only where the
    // procedure does not need a doctor and the clinic allows it.
    const isDoctor = ctx.permissions.has('procedure.order');
    const nurseInitiated = !isDoctor;
    if (nurseInitiated) {
      if (procedure.requiresDoctor) {
        throw new ForbiddenError(`${procedure.name} has to be ordered by a doctor.`, {
          procedure: procedure.name,
        });
      }
      if (!(await this.nurseInitiatedAllowed(tx, encounter.branchId))) {
        throw new ForbiddenError(
          'This clinic does not allow a procedure to be started without a doctor’s order.',
          { setting: 'procedures.allow_nurse_initiated' },
        );
      }
    }

    const count = Math.max(1, Math.min(input.quantity ?? 1, 20));
    const created: string[] = [];
    const now = this.clock.now();

    // PRC §14: two dressings is two orders, so it is charged twice and
    // each one records its own site.
    for (let i = 0; i < count; i += 1) {
      const id = newId();
      await tx.encounterProcedure.create({
        data: {
          id,
          tenantId: requireTenantId(),
          branchId: encounter.branchId,
          encounterId,
          patientId: encounter.patientId,
          consultationId: input.consultationId ?? null,
          procedureId: procedure.id,
          // PRC-R-02: both taken now.
          nameSnapshot: procedure.name,
          priceSnapshot: procedure.price,
          status: ProcedureStatus.ORDERED,
          orderedBy: ctx.userId,
          orderedAt: now,
          nurseInitiated,
        },
      });
      created.push(id);
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureOrdered,
      entityType: 'encounter_procedure',
      entityId: created[0]!,
      subjectPatientId: encounter.patientId,
      after: { procedure: procedure.name, count, nurseInitiated },
    });

    this.events.publish({
      name: DomainEvent.ProcedureOrdered,
      tenantId: ctx.tenantId,
      branchId: encounter.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { encounterId, procedureId: procedure.id, ids: created, nurseInitiated },
    });

    return { items: await this.forEncounter(ctx, encounterId) };
  }

  async forEncounter(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const rows = await tx.encounterProcedure.findMany({
      where: { encounterId },
      include: { procedure: { include: { consumables: true } }, consumables: true },
      orderBy: { orderedAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.present(tx, ctx, row)));
  }

  /** PRC-F-12: what the nurse's board shows. */
  async queue(ctx: TenantContext, branchId: string) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const rows = await tx.encounterProcedure.findMany({
      where: { branchId, status: ProcedureStatus.ORDERED },
      include: { procedure: true },
      orderBy: { orderedAt: 'asc' },
      take: 200,
    });
    if (rows.length === 0) return { items: [] };

    const encounters = await tx.encounter.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.encounterId))] } },
      select: { id: true, queueNo: true, status: true, patientId: true },
    });
    const patients = await tx.patient.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.patientId))] } },
      select: { id: true, name: true, mrn: true, dateOfBirth: true },
    });
    const encounterById = new Map(encounters.map((e) => [e.id, e]));
    const patientById = new Map(patients.map((p) => [p.id, p]));

    // One row per patient, with what is waiting listed under it: a nurse
    // calls a person, not a procedure.
    const byEncounter = new Map<
      string,
      { encounterId: string; queueNo: string | null; patient: unknown; items: unknown[] }
    >();
    for (const row of rows) {
      const encounter = encounterById.get(row.encounterId);
      const group = byEncounter.get(row.encounterId) ?? {
        encounterId: row.encounterId,
        queueNo: encounter?.queueNo ?? null,
        patient: patientById.get(row.patientId) ?? null,
        items: [],
      };
      group.items.push({
        id: row.id,
        name: row.nameSnapshot,
        category: row.procedure.category,
        requiresConsent: row.procedure.requiresConsent,
        requiresDoctor: row.procedure.requiresDoctor,
        orderedAt: row.orderedAt,
        nurseInitiated: row.nurseInitiated,
      });
      byEncounter.set(row.encounterId, group);
    }

    return { items: [...byEncounter.values()] };
  }

  // -------------------------------------------------------------------
  // Performing (PRC-F-07, PRC-F-08)
  // -------------------------------------------------------------------

  /**
   * One transaction: stock out, row performed, vaccination recorded,
   * event emitted. PRC-T-01 is the test that it is one transaction.
   */
  async perform(ctx: TenantContext, id: string, input: PerformInput) {
    const tx = this.db.tx();
    const row = await this.rowOrThrow(tx, id);
    const procedure = await this.catalogueOrThrow(tx, row.procedureId);

    if (row.status !== ProcedureStatus.ORDERED) {
      throw new ConflictError(
        row.status === ProcedureStatus.PERFORMED
          ? 'This has already been done.'
          : `This procedure was ${row.status.toLowerCase()}.`,
        'not_ordered',
      );
    }

    // PRC-R-03. Checked against the roles held at the branch the patient
    // is at, not anywhere in the clinic.
    if (procedure.requiresDoctor && !ctx.roles.includes(Role.DOCTOR)) {
      throw new ForbiddenError(`${procedure.name} has to be performed by a doctor.`, {
        procedure: procedure.name,
      });
    }

    // PRC-R-04. A tick is not consent, but an unticked box is certainly
    // not consent, and this is the record that says somebody asked.
    if (procedure.requiresConsent && input.consentGiven !== true) {
      throw new InvariantViolationError(
        'consent_required',
        `${procedure.name} needs the patient’s consent recorded before it is done.`,
        { procedure: procedure.name },
      );
    }

    if (SITE_REQUIRED.has(procedure.category) && !(input.site ?? '').trim()) {
      throw new BadRequestError(
        'Say where on the body. For an injection or a dressing this is part of the record.',
        'site_required',
      );
    }

    const now = this.clock.now();

    // What is actually being used: the mapping, unless the nurse said
    // otherwise. An optional line left out of the request is left out.
    const planned =
      input.consumables ??
      procedure.consumables
        .filter((line) => !line.optional)
        .map((line) => ({
          productId: line.productId,
          batchId: null,
          quantity: Number(line.quantity),
        }));

    const used: Array<{
      productId: string;
      batchId: string;
      quantity: number;
      movementId: string;
      batchNo: string;
      expiry: Date | null;
    }> = [];
    const shortfalls: Array<{ productId: string; name: string; wanted: number; short: number }> = [];

    for (const line of planned) {
      if (!(line.quantity > 0)) continue;

      const product = await tx.product.findFirst({ where: { id: line.productId } });
      if (!product) throw new NotFoundError('Consumable product');

      // A batch chosen by hand is honoured; otherwise FEFO decides.
      const picks = line.batchId
        ? await this.pickNamedBatch(tx, row.branchId, line)
        : (await this.ledger.suggestFefo(tx, row.branchId, line.productId, line.quantity)).picks;

      const covered = picks.reduce((sum, pick) => sum + pick.quantity, 0);
      const short = Math.round((line.quantity - covered) * 1000) / 1000;

      if (short > 0) {
        // PRC §14: the procedure still happened. Refusing to record it
        // because the shelf disagrees loses the clinical fact as well as
        // the stock one.
        if (!input.allowShortfall) {
          throw new InvariantViolationError(
            'insufficient_stock',
            `There is not enough ${product.name} in stock: ${covered} of ${line.quantity}. ` +
              'Record it anyway if it was used from stock nobody had entered, and post an adjustment.',
            { productId: product.id, name: product.name, wanted: line.quantity, available: covered },
          );
        }
        shortfalls.push({ productId: product.id, name: product.name, wanted: line.quantity, short });
      }

      for (const pick of picks) {
        const moved = await this.ledger.move(tx, ctx, {
          batchId: pick.batchId,
          type: StockMovementType.CONSUME,
          quantity: pick.quantity,
          referenceType: 'encounter_procedure',
          referenceId: row.id,
        });
        await tx.encounterProcedureConsumable.create({
          data: {
            id: newId(),
            tenantId: requireTenantId(),
            encounterProcedureId: row.id,
            productId: line.productId,
            batchId: pick.batchId,
            quantity: pick.quantity,
            stockMovementId: moved.movement.id,
          },
        });
        used.push({
          productId: line.productId,
          batchId: pick.batchId,
          quantity: pick.quantity,
          movementId: moved.movement.id,
          batchNo: pick.batchNo,
          expiry: pick.expiryDate,
        });
      }
    }

    await tx.encounterProcedure.update({
      where: { id },
      data: {
        status: ProcedureStatus.PERFORMED,
        performedBy: ctx.userId,
        performedAt: now,
        site: input.site?.trim() || null,
        laterality: input.laterality ?? null,
        consentGiven: procedure.requiresConsent ? true : (input.consentGiven ?? null),
        consentBy: input.consentBy?.trim() || null,
        consentAt: input.consentGiven ? now : null,
        notes: input.notes?.trim() || null,
        complications: input.complications?.trim() || null,
      },
    });

    // PRC-F-11, PRC-R-06.
    let vaccination: { id: string; batchNo: string } | null = null;
    if (procedure.category === ProcedureCategory.VACCINATION) {
      vaccination = await this.recordVaccination(tx, ctx, {
        row,
        procedure,
        used,
        site: input.site ?? null,
        doseNumber: input.doseNumber ?? null,
        at: now,
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedurePerformed,
      entityType: 'encounter_procedure',
      entityId: id,
      subjectPatientId: row.patientId,
      after: {
        procedure: row.nameSnapshot,
        price: fromSen(row.priceSnapshot),
        site: input.site ?? null,
        consentGiven: input.consentGiven ?? null,
        consumables: used.map((u) => ({ productId: u.productId, batchNo: u.batchNo, quantity: u.quantity })),
        shortfalls,
        complications: input.complications ?? null,
      },
    });

    /**
     * PRC-R-07: BIL builds its line from this, never from the order.
     * Nothing consumes it yet — billing is Phase 4 — so the charge lives
     * on the row as `price_snapshot` until it does.
     */
    this.events.publish({
      name: DomainEvent.ProcedurePerformed,
      tenantId: ctx.tenantId,
      branchId: row.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        encounterProcedureId: id,
        encounterId: row.encounterId,
        patientId: row.patientId,
        procedureId: row.procedureId,
        name: row.nameSnapshot,
        priceSnapshotSen: Number(row.priceSnapshot),
        consumables: used.map((u) => ({ productId: u.productId, batchId: u.batchId, quantity: u.quantity })),
      },
    });

    return {
      ...(await this.readOne(ctx, id)),
      shortfalls,
      vaccinationRecordId: vaccination?.id ?? null,
    };
  }

  /** PRC-F-09: not done after all, before it was done. */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    if ((reason ?? '').trim().length < 3) {
      throw new BadRequestError('Say why this is not being done.', 'reason_required');
    }

    const tx = this.db.tx();
    const row = await this.rowOrThrow(tx, id);
    if (row.status !== ProcedureStatus.ORDERED) {
      throw new ConflictError(
        row.status === ProcedureStatus.PERFORMED
          ? 'This has already been done. Void it instead, which puts the stock back.'
          : `This procedure was already ${row.status.toLowerCase()}.`,
        'not_ordered',
      );
    }

    await tx.encounterProcedure.update({
      where: { id },
      data: { status: ProcedureStatus.CANCELLED, cancelReason: reason.trim() },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureCancelled,
      entityType: 'encounter_procedure',
      entityId: id,
      subjectPatientId: row.patientId,
      reason: reason.trim(),
    });

    this.events.publish({
      name: DomainEvent.ProcedureCancelled,
      tenantId: ctx.tenantId,
      branchId: row.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { encounterProcedureId: id, encounterId: row.encounterId, reason: reason.trim() },
    });

    return this.readOne(ctx, id);
  }

  /**
   * PRC-F-10, PRC-R-05: it was recorded on the wrong patient.
   *
   * Every consumable goes back with a reversal that names the movement
   * it undoes, so the ledger reads as two events rather than as one that
   * never happened. Within a day, and only an administrator, because
   * after that it is a billing correction and BIL owns it.
   */
  async void(ctx: TenantContext, id: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say what happened, in a sentence. This reverses stock and removes a charge.',
        'reason_required',
      );
    }

    const tx = this.db.tx();
    const row = await this.rowOrThrow(tx, id);

    if (row.status !== ProcedureStatus.PERFORMED) {
      throw new ConflictError(
        'Only something that was done can be voided.',
        'not_performed',
      );
    }

    const hours = (this.clock.now().getTime() - (row.performedAt?.getTime() ?? 0)) / 3_600_000;
    if (hours > VOID_WINDOW_HOURS) {
      throw new ConflictError(
        `This was done ${Math.floor(hours)} hours ago. After ${VOID_WINDOW_HOURS} hours it is a ` +
          'billing correction rather than a mistake being undone; credit the invoice instead.',
        'void_window_passed',
      );
    }

    const lines = await tx.encounterProcedureConsumable.findMany({
      where: { encounterProcedureId: id, reversalMovementId: null },
    });

    const reversed: Array<{ batchId: string; quantity: number; movementId: string }> = [];
    for (const line of lines) {
      const moved = await this.ledger.move(tx, ctx, {
        batchId: line.batchId,
        type: StockMovementType.CONSUME_REVERSAL,
        quantity: Number(line.quantity),
        referenceType: 'encounter_procedure_void',
        referenceId: id,
        reasonText: reason.trim(),
      });
      await tx.encounterProcedureConsumable.update({
        where: { id: line.id },
        data: { reversalMovementId: moved.movement.id },
      });
      reversed.push({
        batchId: line.batchId,
        quantity: Number(line.quantity),
        movementId: moved.movement.id,
      });
    }

    const now = this.clock.now();
    await tx.encounterProcedure.update({
      where: { id },
      data: {
        status: ProcedureStatus.VOIDED,
        voidedBy: ctx.userId,
        voidedAt: now,
        voidReason: reason.trim(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureVoided,
      entityType: 'encounter_procedure',
      entityId: id,
      subjectPatientId: row.patientId,
      reason: reason.trim(),
      before: { status: ProcedureStatus.PERFORMED, price: fromSen(row.priceSnapshot) },
      after: { status: ProcedureStatus.VOIDED, reversed },
    });

    this.events.publish({
      name: DomainEvent.ProcedureVoided,
      tenantId: ctx.tenantId,
      branchId: row.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        encounterProcedureId: id,
        encounterId: row.encounterId,
        patientId: row.patientId,
        // What BIL needs to take the line off.
        priceSnapshotSen: Number(row.priceSnapshot),
        reason: reason.trim(),
        reversed,
      },
    });

    return this.readOne(ctx, id);
  }

  /** PRC-F-11: the immunisation history, on the patient rather than the visit. */
  async vaccinations(ctx: TenantContext, patientId: string) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.vaccinationRecord.findMany({
      where: { patientId },
      orderBy: { givenAt: 'desc' },
    });
    if (rows.length === 0) return { items: [] };

    // A voided procedure's vaccination is kept and marked, not hidden:
    // "this was recorded and then withdrawn" is itself clinical history.
    const procedures = await tx.encounterProcedure.findMany({
      where: { id: { in: rows.map((r) => r.encounterProcedureId) } },
      select: { id: true, status: true, voidReason: true },
    });
    const byId = new Map(procedures.map((p) => [p.id, p]));
    const givers = await tx.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.givenBy))] } },
      select: { id: true, name: true },
    });
    const giverById = new Map(givers.map((g) => [g.id, g.name]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        vaccineName: row.vaccineName,
        batchNo: row.batchNo,
        expiry: row.expiry,
        doseNumber: row.doseNumber,
        site: row.site,
        givenAt: row.givenAt,
        givenByName: giverById.get(row.givenBy) ?? null,
        withdrawn: byId.get(row.encounterProcedureId)?.status === ProcedureStatus.VOIDED,
        withdrawnReason: byId.get(row.encounterProcedureId)?.voidReason ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------

  private async recordVaccination(
    tx: Tx,
    ctx: TenantContext,
    input: {
      row: { id: string; patientId: string; branchId: string };
      procedure: { vaccineProductId: string | null; name: string };
      used: Array<{ productId: string; batchNo: string; expiry: Date | null }>;
      site: string | null;
      doseNumber: number | null;
      at: Date;
    },
  ) {
    const vaccineId = input.procedure.vaccineProductId;
    if (!vaccineId) {
      // The CHECK constraint makes this unreachable; the message is for
      // whoever removes the constraint.
      throw new InvariantViolationError(
        'vaccine_not_named',
        `${input.procedure.name} is recorded as a vaccination but names no vaccine.`,
        {},
      );
    }

    const given = input.used.find((line) => line.productId === vaccineId);
    if (!given) {
      throw new InvariantViolationError(
        'vaccine_batch_required',
        'A vaccination has to say which batch went in. Choose one, or receive the vaccine into stock first.',
        { vaccineProductId: vaccineId },
      );
    }

    const vaccine = await tx.product.findFirst({ where: { id: vaccineId } });
    const id = newId();
    await tx.vaccinationRecord.create({
      data: {
        id,
        tenantId: requireTenantId(),
        patientId: input.row.patientId,
        encounterProcedureId: input.row.id,
        vaccineProductId: vaccineId,
        vaccineName: vaccine?.name ?? input.procedure.name,
        batchNo: given.batchNo,
        expiry: given.expiry,
        doseNumber: input.doseNumber,
        site: input.site,
        givenBy: ctx.userId,
        givenAt: input.at,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.VaccinationRecorded,
      entityType: 'vaccination_record',
      entityId: id,
      subjectPatientId: input.row.patientId,
      after: { vaccine: vaccine?.name, batchNo: given.batchNo, expiry: given.expiry },
    });

    this.events.publish({
      name: DomainEvent.VaccinationRecorded,
      tenantId: ctx.tenantId,
      branchId: input.row.branchId,
      actorId: ctx.userId,
      occurredAt: input.at,
      payload: { id, patientId: input.row.patientId, vaccineProductId: vaccineId, batchNo: given.batchNo },
    });

    return { id, batchNo: given.batchNo };
  }

  private async pickNamedBatch(
    tx: Tx,
    branchId: string,
    line: { productId: string; batchId?: string | null; quantity: number },
  ) {
    const batch = await tx.productBatch.findFirst({
      where: { id: line.batchId!, branchId, productId: line.productId },
    });
    if (!batch) throw new NotFoundError('Batch');
    if (batch.status === BatchStatus.BLOCKED) {
      throw new ConflictError(`Batch ${batch.batchNo} is blocked and cannot be used.`, 'batch_blocked');
    }
    if (batch.status === BatchStatus.EXPIRED) {
      throw new ConflictError(
        `Batch ${batch.batchNo} expired on ${batch.expiryDate?.toISOString().slice(0, 10)} and cannot be used.`,
        'batch_expired',
      );
    }

    const available = Number(batch.quantityOnHand);
    return [
      {
        batchId: batch.id,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        quantity: Math.min(available, line.quantity),
        available,
      },
    ].filter((pick) => pick.quantity > 0);
  }

  private async nurseInitiatedAllowed(tx: Tx, branchId: string): Promise<boolean> {
    // PRC-F-06's tenant setting. The settings group does not exist yet,
    // so the safe answer is no: a clinic that wants it says so.
    void tx;
    void branchId;
    return false;
  }

  private async encounterOrThrow(tx: Tx, id: string) {
    const encounter = await tx.encounter.findFirst({
      where: { id },
      select: { id: true, branchId: true, patientId: true, status: true },
    });
    if (!encounter) throw new NotFoundError('Encounter');
    return encounter;
  }

  private async catalogueOrThrow(tx: Tx, id: string) {
    const row = await tx.procedureCatalog.findFirst({
      where: { id },
      include: { consumables: true },
    });
    if (!row) throw new NotFoundError('Procedure');
    return row;
  }

  private async rowOrThrow(tx: Tx, id: string) {
    const row = await tx.encounterProcedure.findFirst({ where: { id } });
    if (!row) throw new NotFoundError('Procedure');
    return row;
  }

  private async readOne(ctx: TenantContext, id: string) {
    const tx = this.db.tx();
    const row = await tx.encounterProcedure.findFirst({
      where: { id },
      include: { procedure: { include: { consumables: true } }, consumables: true },
    });
    if (!row) throw new NotFoundError('Procedure');
    return this.present(tx, ctx, row);
  }

  private async present(
    tx: Tx,
    ctx: TenantContext,
    row: {
      id: string;
      encounterId: string;
      patientId: string;
      branchId: string;
      procedureId: string;
      nameSnapshot: string;
      priceSnapshot: bigint;
      status: ProcedureStatus;
      orderedAt: Date;
      nurseInitiated: boolean;
      performedBy: string | null;
      performedAt: Date | null;
      site: string | null;
      laterality: Laterality | null;
      consentGiven: boolean | null;
      consentBy: string | null;
      notes: string | null;
      complications: string | null;
      cancelReason: string | null;
      voidReason: string | null;
      voidedAt: Date | null;
      procedure: {
        category: ProcedureCategory;
        requiresConsent: boolean;
        requiresDoctor: boolean;
        vaccineProductId: string | null;
        protocol: string | null;
        consumables: Array<{ productId: string; quantity: unknown; optional: boolean }>;
      };
      consumables: Array<{
        id: string;
        productId: string;
        batchId: string;
        quantity: unknown;
        reversalMovementId: string | null;
      }>;
    },
  ) {
    void ctx;
    // The mapping, with what is on the shelf beside it, so the perform
    // form can prefill and warn in one round trip (PRC-N-02).
    const productIds = [
      ...new Set([
        ...row.procedure.consumables.map((line) => line.productId),
        ...row.consumables.map((line) => line.productId),
      ]),
    ];
    const products = productIds.length
      ? await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, dispenseUnit: true, isBatched: true, isColdChain: true },
        })
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));
    const onHand =
      row.status === ProcedureStatus.ORDERED
        ? await this.ledger.onHandFor(tx, row.branchId, productIds)
        : new Map();

    return {
      id: row.id,
      encounterId: row.encounterId,
      patientId: row.patientId,
      procedureId: row.procedureId,
      name: row.nameSnapshot,
      price: fromSen(row.priceSnapshot),
      category: row.procedure.category,
      requiresConsent: row.procedure.requiresConsent,
      requiresDoctor: row.procedure.requiresDoctor,
      vaccineProductId: row.procedure.vaccineProductId,
      protocol: row.procedure.protocol,
      status: row.status,
      orderedAt: row.orderedAt,
      nurseInitiated: row.nurseInitiated,
      performedBy: row.performedBy,
      performedAt: row.performedAt,
      site: row.site,
      laterality: row.laterality,
      consentGiven: row.consentGiven,
      consentBy: row.consentBy,
      notes: row.notes,
      complications: row.complications,
      cancelReason: row.cancelReason,
      voidReason: row.voidReason,
      voidedAt: row.voidedAt,
      /** What the mapping says to use, for the perform form. */
      planned: row.procedure.consumables.map((line) => ({
        productId: line.productId,
        quantity: Number(line.quantity),
        optional: line.optional,
        product: byId.get(line.productId) ?? null,
        onHand: onHand.get(line.productId)?.onHand ?? 0,
      })),
      /** What was actually used, once it has been done. */
      used: row.consumables.map((line) => ({
        id: line.id,
        productId: line.productId,
        batchId: line.batchId,
        quantity: Number(line.quantity),
        reversed: line.reversalMovementId !== null,
        product: byId.get(line.productId) ?? null,
      })),
    };
  }
}
