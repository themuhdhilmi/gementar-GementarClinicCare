import { Injectable, Logger } from '@nestjs/common';
import {
  AllergyStatus,
  ConsultationStatus,
  PrescriptionItemStatus,
  PrescriptionStatus,
  ProductStatus,
  ProductType,
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
import type { TenantContext } from '../tenancy/tenant-context.js';
import { isFrequencyCode, perDay, type FrequencyCode } from './frequency.js';
import { buildLabel, type Language } from './label.js';
import { calculateQuantity, unitsPerDose } from './quantity.js';
import {
  matchAllergies,
  maxDoseWarning,
  needsOverride,
  needsSignConfirmation,
  NO_ALLERGY_RECORD,
  type AllergyRecord,
  type ItemSubstance,
  type Warning,
} from './warnings.js';

/** RX-F-02. Closed lists, so a label can be generated from them. */
export const DOSE_UNITS = [
  'tab', 'cap', 'ml', 'mg', 'mcg', 'g', 'puff', 'drop', 'unit', 'sachet',
  'application', 'patch', 'vial', 'ampoule',
] as const;

export const ROUTES = [
  'PO', 'TOP', 'SC', 'IM', 'IV', 'INH', 'PR', 'PV', 'SL', 'OPH', 'OTIC', 'NASAL',
] as const;

export type ItemInput = {
  productId?: string | null;
  externalName?: string | null;
  doseValue: number;
  doseUnit: string;
  route: string;
  frequencyCode: string;
  frequencyPerDay?: number | null;
  isPrn?: boolean;
  prnIndication?: string | null;
  durationDays?: number | null;
  untilFinished?: boolean;
  /** Omit to take the calculated quantity; supply one to override it. */
  quantity?: number | null;
  instructions?: string | null;
};

/** How long a past prescription counts as still running (RX-F-13). */
const DUPLICATE_WINDOW_DAYS = 30;

const ITEM_SELECT = {
  id: true,
  prescriptionId: true,
  version: true,
  supersedesId: true,
  isCurrent: true,
  productId: true,
  externalName: true,
  genericName: true,
  drugClass: true,
  strength: true,
  displayName: true,
  doseValue: true,
  doseUnit: true,
  route: true,
  frequencyCode: true,
  frequencyPerDay: true,
  isPrn: true,
  prnIndication: true,
  durationDays: true,
  untilFinished: true,
  quantity: true,
  quantityUnit: true,
  quantityAuto: true,
  instructions: true,
  labelText: true,
  isExternal: true,
  isControlled: true,
  status: true,
  warnings: true,
  overrideReason: true,
  overriddenBy: true,
  overriddenAt: true,
  overrideConfirmedAt: true,
  cancelledReason: true,
  createdBy: true,
  createdAt: true,
} as const;

type ItemRow = {
  [K in keyof typeof ITEM_SELECT]: unknown;
};

/** What the safety checks need to know about the patient, loaded once. */
type SafetyContext = {
  patientId: string;
  nkdaRecorded: boolean | null;
  allergies: AllergyRecord[];
};

/**
 * Prescription (RX, v0-07-prescription.md).
 *
 * A prescription is what the doctor decided. It is not stock moving and
 * it is not a sale: nothing in this file writes to either, and RX-T-09
 * checks that it stays that way.
 *
 * Two things here deserve the care they get. The first is the snapshot:
 * an item copies the generic name, class and strength off the product,
 * so that renaming a product next year does not rewrite what was
 * prescribed today. The second is the warnings, which are computed on
 * the server on every write and again at signing, because a warning the
 * client can decide not to ask for is not a safety check.
 */
@Injectable()
export class PrescriptionService {
  private readonly logger = new Logger(PrescriptionService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  // -------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------

  async read(ctx: TenantContext, consultationId: string) {
    const tx = this.db.tx();
    const consultation = await this.consultationOrThrow(tx, consultationId);
    this.assertMayRead(ctx, consultation);

    const prescription = await tx.prescription.findFirst({
      where: { consultationId },
    });
    if (!prescription) {
      return {
        prescription: null,
        items: [],
        patient: await this.safetySummary(tx, consultation.patientId),
      };
    }

    const items = await tx.prescriptionItem.findMany({
      where: { prescriptionId: prescription.id },
      select: ITEM_SELECT,
      orderBy: [{ createdAt: 'asc' }, { version: 'asc' }],
    });

    return {
      prescription: this.presentPrescription(prescription),
      items: items.map((item) => this.presentItem(item)),
      patient: await this.safetySummary(tx, consultation.patientId),
    };
  }

  /**
   * RX-R-10: what the pharmacy sees.
   *
   * Deliberately thin. The dispenser needs the drug, the dose and the
   * patient's name; they do not need the diagnosis, and a system that
   * shows it to them anyway has decided on the patient's behalf who
   * knows what they came in for.
   */
  async dispenseView(ctx: TenantContext, prescriptionId: string) {
    const tx = this.db.tx();
    const prescription = await tx.prescription.findFirst({
      where: { id: prescriptionId },
      include: {
        patient: { select: { id: true, mrn: true, name: true, dateOfBirth: true } },
      },
    });
    if (!prescription) throw new NotFoundError('Prescription');
    if (prescription.status === PrescriptionStatus.DRAFT) {
      throw new NotFoundError('Prescription');
    }

    const items = await tx.prescriptionItem.findMany({
      where: { prescriptionId, isCurrent: true },
      select: ITEM_SELECT,
      orderBy: { createdAt: 'asc' },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionDispenseViewed,
      entityType: 'prescription',
      entityId: prescriptionId,
      subjectPatientId: prescription.patientId,
    });

    return {
      id: prescription.id,
      status: prescription.status,
      signedAt: prescription.signedAt,
      language: prescription.language,
      notesToDispenser: prescription.notesToDispenser,
      patient: prescription.patient,
      items: items.map((item) => {
        const presented = this.presentItem(item);
        return {
          id: presented.id,
          version: presented.version,
          /** RX-F-06: DSP needs to see that this replaced something. */
          supersedesId: presented.supersedesId,
          updated: presented.version > 1,
          displayName: presented.displayName,
          genericName: presented.genericName,
          strength: presented.strength,
          productId: presented.productId,
          externalName: presented.externalName,
          isExternal: presented.isExternal,
          isControlled: presented.isControlled,
          quantity: presented.quantity,
          quantityUnit: presented.quantityUnit,
          labelText: presented.labelText,
          instructions: presented.instructions,
          status: presented.status,
          /** Allergy overrides matter at the counter too. */
          hasOverride: presented.overrideReason !== null,
        };
      }),
    };
  }

  // -------------------------------------------------------------------
  // Writing, while the consultation is a draft
  // -------------------------------------------------------------------

  /** RX-F-01. The prescription appears when the first item is written. */
  async addItem(ctx: TenantContext, consultationId: string, input: ItemInput) {
    const tx = this.db.tx();
    const consultation = await this.consultationOrThrow(tx, consultationId);
    this.assertPrescriber(ctx, consultation);

    const prescription = await this.openPrescription(tx, ctx, consultation);
    const safety = await this.loadSafety(tx, consultation.patientId);
    const resolved = await this.resolve(tx, input, prescription.language as Language);
    const warnings = await this.evaluate(tx, safety, resolved, {
      prescriptionId: prescription.id,
    });

    const now = this.clock.now();
    const item = await tx.prescriptionItem.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        prescriptionId: prescription.id,
        ...resolved.data,
        status: PrescriptionItemStatus.DRAFT,
        warnings: warnings as unknown as object,
        createdBy: ctx.userId,
        createdAt: now,
      },
      select: ITEM_SELECT,
    });

    // RX-F-10: counted as it happens, so the list is what this doctor
    // actually prescribes rather than what they once said they would.
    if (resolved.data.productId) {
      await this.noteFavourite(tx, ctx, resolved.data.productId, {
        doseValue: resolved.data.doseValue,
        doseUnit: resolved.data.doseUnit,
        route: resolved.data.route,
        frequencyCode: resolved.data.frequencyCode,
        durationDays: resolved.data.durationDays,
        instructions: resolved.data.instructions,
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemAdded,
      entityType: 'prescription_item',
      entityId: item.id as string,
      subjectPatientId: consultation.patientId,
      after: { displayName: resolved.data.displayName, warnings },
    });

    if (warnings.length > 0) {
      this.events.publish({
        name: DomainEvent.PrescriptionWarningRaised,
        tenantId: ctx.tenantId,
        branchId: consultation.branchId,
        actorId: ctx.userId,
        occurredAt: now,
        payload: { itemId: item.id, prescriptionId: prescription.id, warnings },
      });
    }

    return this.presentItem(item);
  }

  /** RX-F-05: editable only while it is still a draft. */
  async updateItem(ctx: TenantContext, itemId: string, input: ItemInput) {
    const tx = this.db.tx();
    const { item, prescription, consultation } = await this.itemContext(tx, itemId);
    this.assertPrescriber(ctx, consultation);
    this.assertItemDraft(item);

    const safety = await this.loadSafety(tx, consultation.patientId);
    const resolved = await this.resolve(tx, input, prescription.language as Language);
    const warnings = await this.evaluate(tx, safety, resolved, {
      prescriptionId: prescription.id,
      excludeItemId: itemId,
    });

    // RX-F-15: a reason given for one drug is not a reason for another.
    // Changing what is prescribed clears the override with the warning it
    // was given for.
    const keepOverride = resolved.data.genericName === item.genericName;

    const updated = await tx.prescriptionItem.update({
      where: { id: itemId },
      data: {
        ...resolved.data,
        warnings: warnings as unknown as object,
        ...(keepOverride
          ? {}
          : { overrideReason: null, overriddenBy: null, overriddenAt: null }),
      },
      select: ITEM_SELECT,
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemUpdated,
      entityType: 'prescription_item',
      entityId: itemId,
      subjectPatientId: consultation.patientId,
      before: { displayName: item.displayName, quantity: item.quantity.toString() },
      after: { displayName: resolved.data.displayName, quantity: resolved.data.quantity, warnings },
    });

    return this.presentItem(updated);
  }

  async removeItem(ctx: TenantContext, itemId: string) {
    const tx = this.db.tx();
    const { item, prescription, consultation } = await this.itemContext(tx, itemId);
    this.assertPrescriber(ctx, consultation);
    this.assertItemDraft(item);

    await tx.prescriptionItem.delete({ where: { id: itemId } });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemRemoved,
      entityType: 'prescription_item',
      entityId: itemId,
      subjectPatientId: consultation.patientId,
      before: { displayName: item.displayName },
    });

    // An empty draft prescription is not a prescription. Tidying it away
    // keeps "does this visit have a prescription?" answerable by looking.
    const left = await tx.prescriptionItem.count({ where: { prescriptionId: prescription.id } });
    if (left === 0 && prescription.status === PrescriptionStatus.DRAFT) {
      await tx.prescription.delete({ where: { id: prescription.id } });
    }

    return { removed: true };
  }

  /** RX-F-15 / RX-R-05. */
  async override(
    ctx: TenantContext,
    itemId: string,
    input: { reason: string; refuteAllergyId?: string | null },
  ) {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5) {
      throw new BadRequestError(
        'Say why this is being prescribed anyway, in a few words at least.',
        'override_reason_required',
      );
    }

    const tx = this.db.tx();
    const { item, consultation } = await this.itemContext(tx, itemId);
    this.assertPrescriber(ctx, consultation);
    this.assertItemDraft(item);

    const warnings = (item.warnings ?? []) as Warning[];
    if (warnings.length === 0) {
      throw new ConflictError('There is nothing to override on this item.', 'no_warning');
    }

    const now = this.clock.now();

    // "The allergy record is wrong" is a claim about the record, and the
    // right thing to do with it is fix the record — otherwise the warning
    // fires again on the next visit and gets overridden again.
    if (input.refuteAllergyId) {
      const allergy = await tx.patientAllergy.findFirst({
        where: { id: input.refuteAllergyId, patientId: consultation.patientId },
      });
      if (!allergy) throw new NotFoundError('Allergy');
      await tx.patientAllergy.update({
        where: { id: input.refuteAllergyId },
        data: {
          status: AllergyStatus.REFUTED,
          refutedBy: ctx.userId,
          refutedAt: now,
          refutedReason: reason,
        },
      });
    }

    const updated = await tx.prescriptionItem.update({
      where: { id: itemId },
      data: { overrideReason: reason, overriddenBy: ctx.userId, overriddenAt: now },
      select: ITEM_SELECT,
    });

    // RX-R-05: the whole warning payload, so governance can read later
    // what the doctor was actually looking at when they decided.
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionWarningOverridden,
      entityType: 'prescription_item',
      entityId: itemId,
      subjectPatientId: consultation.patientId,
      after: {
        reason,
        warnings,
        displayName: item.displayName,
        refutedAllergyId: input.refuteAllergyId ?? null,
      },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionWarningOverridden,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { itemId, reason, warnings },
    });

    return this.presentItem(updated);
  }

  /**
   * Notes for the pharmacy, and the language the labels are printed in.
   *
   * The language can be changed while the prescription is a draft, and
   * every label is rebuilt when it is — a stored label in the wrong
   * language would otherwise survive the change, because DSP prints what
   * is stored rather than regenerating it.
   */
  async setNotes(
    ctx: TenantContext,
    consultationId: string,
    input: { notesToDispenser?: string | null; language?: string | null },
  ) {
    const tx = this.db.tx();
    const consultation = await this.consultationOrThrow(tx, consultationId);
    this.assertPrescriber(ctx, consultation);

    const prescription = await tx.prescription.findFirst({ where: { consultationId } });
    if (!prescription) throw new NotFoundError('Prescription');

    const language =
      input.language === undefined || input.language === null
        ? (prescription.language as Language)
        : this.labelLanguage(input.language);

    if (prescription.status !== PrescriptionStatus.DRAFT && language !== prescription.language) {
      throw new ConflictError(
        'The labels have been printed from this language. Amend the items to change it.',
        'prescription_signed',
      );
    }

    await tx.prescription.update({
      where: { id: prescription.id },
      data: {
        language,
        ...(input.notesToDispenser === undefined
          ? {}
          : { notesToDispenser: input.notesToDispenser?.trim() || null }),
      },
    });

    if (language !== prescription.language) {
      const items = await tx.prescriptionItem.findMany({
        where: { prescriptionId: prescription.id, status: PrescriptionItemStatus.DRAFT },
        select: ITEM_SELECT,
      });
      for (const item of items) {
        // Rebuilt through resolve() rather than by calling buildLabel
        // here, so there is exactly one place that knows how a dose
        // becomes a sentence. Nothing but the language changes, and the
        // quantity is carried across as it stands.
        const rebuilt = await this.resolve(
          tx,
          {
            productId: (item.productId as string | null) ?? undefined,
            externalName: (item.externalName as string | null) ?? undefined,
            doseValue: Number(item.doseValue),
            doseUnit: item.doseUnit as string,
            route: item.route as string,
            frequencyCode: item.frequencyCode as string,
            frequencyPerDay: item.frequencyPerDay === null ? null : Number(item.frequencyPerDay),
            isPrn: item.isPrn as boolean,
            prnIndication: (item.prnIndication as string | null) ?? undefined,
            durationDays: item.durationDays as number | null,
            untilFinished: item.untilFinished as boolean,
            quantity: Number(item.quantity),
            instructions: (item.instructions as string | null) ?? undefined,
          },
          language,
        );
        await tx.prescriptionItem.update({
          where: { id: item.id as string },
          data: { labelText: rebuilt.data.labelText },
        });
      }
    }

    return this.read(ctx, consultationId);
  }

  /** RX-F-09: the same medicines as last time, each one re-checked. */
  async repeatLast(ctx: TenantContext, consultationId: string) {
    const tx = this.db.tx();
    const consultation = await this.consultationOrThrow(tx, consultationId);
    this.assertPrescriber(ctx, consultation);

    const previous = await tx.prescription.findFirst({
      where: {
        patientId: consultation.patientId,
        status: { in: [PrescriptionStatus.ACTIVE, PrescriptionStatus.COMPLETED] },
      },
      orderBy: { signedAt: 'desc' },
      select: { id: true, signedAt: true },
    });
    if (!previous) {
      throw new NotFoundError('A previous prescription for this patient');
    }

    const source = await tx.prescriptionItem.findMany({
      where: {
        prescriptionId: previous.id,
        isCurrent: true,
        status: { notIn: [PrescriptionItemStatus.CANCELLED, PrescriptionItemStatus.SUPERSEDED] },
      },
      select: ITEM_SELECT,
      orderBy: { createdAt: 'asc' },
    });

    const added: unknown[] = [];
    for (const old of source) {
      // Each one goes through addItem, so it is re-priced, re-labelled
      // and above all re-checked against today's allergy list. Copying
      // the old row would copy an override given for a warning that may
      // no longer be the warning.
      added.push(
        await this.addItem(ctx, consultationId, {
          productId: (old.productId as string | null) ?? undefined,
          externalName: (old.externalName as string | null) ?? undefined,
          doseValue: Number(old.doseValue),
          doseUnit: old.doseUnit as string,
          route: old.route as string,
          frequencyCode: old.frequencyCode as string,
          frequencyPerDay: old.frequencyPerDay === null ? null : Number(old.frequencyPerDay),
          isPrn: old.isPrn as boolean,
          prnIndication: (old.prnIndication as string | null) ?? undefined,
          durationDays: old.durationDays as number | null,
          untilFinished: old.untilFinished as boolean,
          instructions: (old.instructions as string | null) ?? undefined,
        }),
      );
    }

    return { copied: added.length, from: previous.signedAt, items: added };
  }

  /**
   * RX: the dry run behind "check these before I commit to them".
   *
   * Used by templates and by the repeat-last preview, so a set of items
   * can be shown with its warnings before any of it is saved.
   */
  async check(ctx: TenantContext, consultationId: string, inputs: ItemInput[]) {
    const tx = this.db.tx();
    const consultation = await this.consultationOrThrow(tx, consultationId);
    this.assertMayRead(ctx, consultation);

    const safety = await this.loadSafety(tx, consultation.patientId);
    const prescription = await tx.prescription.findFirst({
      where: { consultationId },
      select: { id: true, language: true },
    });

    const results = [];
    for (const input of inputs) {
      const resolved = await this.resolve(tx, input, (prescription?.language ?? 'MS') as Language);
      results.push({
        displayName: resolved.data.displayName,
        quantity: resolved.data.quantity,
        quantityUnit: resolved.data.quantityUnit,
        labelText: resolved.data.labelText,
        formula: resolved.formula,
        warnings: await this.evaluate(tx, safety, resolved, {
          prescriptionId: prescription?.id ?? null,
        }),
      });
    }
    return { items: results };
  }

  // -------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------

  /**
   * RX-F-05, RX-F-17, RX-R-04: called by CON inside the signing
   * transaction.
   *
   * Every warning is computed again from scratch here, not read back from
   * the row. The draft may have been open for twenty minutes, and in
   * those twenty minutes the nurse may have recorded the allergy that
   * makes this a different decision (RX-T-08).
   */
  async activateForConsultation(
    tx: Tx,
    ctx: TenantContext,
    consultation: { id: string; patientId: string; branchId: string },
    options: { confirmedItemIds?: readonly string[] } = {},
  ): Promise<{ hasRx: boolean }> {
    const prescription = await tx.prescription.findFirst({
      where: { consultationId: consultation.id },
    });
    if (!prescription) return { hasRx: false };

    const items = await tx.prescriptionItem.findMany({
      where: { prescriptionId: prescription.id, status: PrescriptionItemStatus.DRAFT },
      select: ITEM_SELECT,
    });
    if (items.length === 0) return { hasRx: false };

    const safety = await this.loadSafety(tx, consultation.patientId);
    const confirmed = new Set(options.confirmedItemIds ?? []);
    const blocked: { itemId: string; displayName: string; reason: string; warnings: Warning[] }[] = [];
    const now = this.clock.now();

    for (const item of items) {
      const substance: ItemSubstance = {
        productId: (item.productId as string | null) ?? null,
        genericName: item.genericName as string,
        drugClass: (item.drugClass as string | null) ?? null,
        displayName: item.displayName as string,
      };

      // The maximum comes from the catalogue rather than the item,
      // because it is a property of the drug and may have been corrected
      // since the draft was opened.
      const product = substance.productId
        ? await tx.product.findFirst({
            where: { id: substance.productId },
            select: { maxDailyDose: true, maxDailyDoseUnit: true },
          })
        : null;

      const warnings = await this.evaluate(
        tx,
        safety,
        {
          substance,
          dailyDose: this.dailyDose(
            Number(item.doseValue),
            item.frequencyCode as FrequencyCode,
            item.frequencyPerDay === null ? null : Number(item.frequencyPerDay),
          ),
          doseUnit: item.doseUnit as string,
          maxDailyDose: product?.maxDailyDose == null ? null : Number(product.maxDailyDose),
          maxDailyDoseUnit: product?.maxDailyDoseUnit ?? null,
        },
        { prescriptionId: prescription.id, excludeItemId: item.id as string },
      );

      const fresh = JSON.stringify(warnings) !== JSON.stringify(item.warnings);
      const overrideReason = item.overrideReason as string | null;

      if (needsOverride(warnings) && !overrideReason) {
        blocked.push({
          itemId: item.id as string,
          displayName: substance.displayName,
          reason: fresh
            ? 'a new warning was raised while this draft was open'
            : 'the warning on it has not been overridden',
          warnings,
        });
        continue;
      }

      // RX-R-04: the one case that needs a second, explicit yes.
      if (needsSignConfirmation(warnings) && !confirmed.has(item.id as string)) {
        blocked.push({
          itemId: item.id as string,
          displayName: substance.displayName,
          reason: 'a severe allergy to this exact substance has to be confirmed at signing',
          warnings,
        });
        continue;
      }

      await tx.prescriptionItem.update({
        where: { id: item.id as string },
        data: {
          warnings: warnings as unknown as object,
          ...(needsSignConfirmation(warnings) ? { overrideConfirmedAt: now } : {}),
        },
      });
    }

    if (blocked.length > 0) {
      throw new InvariantViolationError(
        'prescription_not_confirmed',
        blocked.length === 1
          ? `${blocked[0]!.displayName} cannot be prescribed yet: ${blocked[0]!.reason}.`
          : `${blocked.length} prescribed items cannot be signed yet.`,
        { blocked },
      );
    }

    // Everything checked out. The items become real all at once.
    await tx.prescriptionItem.updateMany({
      where: { prescriptionId: prescription.id, status: PrescriptionItemStatus.DRAFT },
      data: { status: PrescriptionItemStatus.ACTIVE },
    });
    await tx.prescription.update({
      where: { id: prescription.id },
      data: { status: PrescriptionStatus.ACTIVE, signedAt: now },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionActivated,
      entityType: 'prescription',
      entityId: prescription.id,
      subjectPatientId: consultation.patientId,
      after: { items: items.length },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionActivated,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        prescriptionId: prescription.id,
        consultationId: consultation.id,
        patientId: consultation.patientId,
        items: items.length,
      },
    });

    return { hasRx: true };
  }

  // -------------------------------------------------------------------
  // After signing
  // -------------------------------------------------------------------

  /**
   * RX-F-06, RX-R-06: a correction to something already prescribed.
   *
   * The old row stays exactly as it was, because the pharmacy may
   * already have dispensed against it and a record that changes
   * underneath a dispensing is a record nobody can reconstruct. The new
   * row points back at it.
   */
  async amendItem(ctx: TenantContext, itemId: string, input: ItemInput, reason: string) {
    if ((reason ?? '').trim().length < 5) {
      throw new BadRequestError('Say why this is being changed.', 'reason_required');
    }

    const tx = this.db.tx();
    const { item, prescription, consultation } = await this.itemContext(tx, itemId);
    this.assertPrescriber(ctx, consultation);
    this.assertAmendable(item, prescription);

    const safety = await this.loadSafety(tx, consultation.patientId);
    const resolved = await this.resolve(tx, input, prescription.language as Language);
    const warnings = await this.evaluate(tx, safety, resolved, {
      prescriptionId: prescription.id,
      excludeItemId: itemId,
    });

    if (needsSignConfirmation(warnings)) {
      throw new InvariantViolationError(
        'amendment_would_breach_allergy',
        `${resolved.data.displayName} matches a severe allergy for this patient. It cannot be added by amendment.`,
        { warnings },
      );
    }

    const now = this.clock.now();

    const replacement = await tx.prescriptionItem.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        prescriptionId: prescription.id,
        version: (item.version as number) + 1,
        supersedesId: itemId,
        isCurrent: true,
        ...resolved.data,
        status: PrescriptionItemStatus.ACTIVE,
        warnings: warnings as unknown as object,
        createdBy: ctx.userId,
        createdAt: now,
      },
      select: ITEM_SELECT,
    });

    await tx.prescriptionItem.update({
      where: { id: itemId },
      data: { status: PrescriptionItemStatus.SUPERSEDED, isCurrent: false },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemAmended,
      entityType: 'prescription_item',
      entityId: replacement.id as string,
      subjectPatientId: consultation.patientId,
      before: {
        itemId,
        displayName: item.displayName,
        doseValue: item.doseValue.toString(),
        quantity: item.quantity.toString(),
        status: item.status,
      },
      after: {
        displayName: resolved.data.displayName,
        doseValue: resolved.data.doseValue,
        quantity: resolved.data.quantity,
        reason,
        warnings,
      },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionItemAmended,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        prescriptionId: prescription.id,
        supersededItemId: itemId,
        itemId: replacement.id,
        // The pharmacy needs to know whether they already handed over the
        // old version, because that is a return and a re-dispense rather
        // than simply a different label.
        alreadyDispensed:
          item.status === PrescriptionItemStatus.DISPENSED ||
          item.status === PrescriptionItemStatus.PARTIAL,
        reason,
      },
    });

    return this.presentItem(replacement);
  }

  /** RX-F-06: withdrawn after the fact, with the row left behind. */
  async cancelItem(ctx: TenantContext, itemId: string, reason: string) {
    if ((reason ?? '').trim().length < 5) {
      throw new BadRequestError('Say why this is being cancelled.', 'reason_required');
    }

    const tx = this.db.tx();
    const { item, prescription, consultation } = await this.itemContext(tx, itemId);
    this.assertPrescriber(ctx, consultation);
    this.assertAmendable(item, prescription);

    const updated = await tx.prescriptionItem.update({
      where: { id: itemId },
      data: { status: PrescriptionItemStatus.CANCELLED, cancelledReason: reason.trim() },
      select: ITEM_SELECT,
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemCancelled,
      entityType: 'prescription_item',
      entityId: itemId,
      subjectPatientId: consultation.patientId,
      before: { status: item.status, displayName: item.displayName },
      after: { status: PrescriptionItemStatus.CANCELLED, reason },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionItemCancelled,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { prescriptionId: prescription.id, itemId, reason },
    });

    await this.settleIfFinished(tx, ctx, prescription.id, consultation);
    return this.presentItem(updated);
  }

  /** The patient said no at the counter. Recorded, not deleted. */
  async declineItem(ctx: TenantContext, itemId: string, reason: string) {
    const tx = this.db.tx();
    const { item, prescription, consultation } = await this.itemContext(tx, itemId);

    if (
      item.status !== PrescriptionItemStatus.ACTIVE &&
      item.status !== PrescriptionItemStatus.PARTIAL
    ) {
      throw new ConflictError(
        'Only an item still waiting to be dispensed can be declined.',
        'item_not_pending',
      );
    }

    const updated = await tx.prescriptionItem.update({
      where: { id: itemId },
      data: {
        status: PrescriptionItemStatus.DECLINED,
        cancelledReason: (reason ?? '').trim() || 'Declined by patient',
      },
      select: ITEM_SELECT,
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionItemDeclined,
      entityType: 'prescription_item',
      entityId: itemId,
      subjectPatientId: consultation.patientId,
      after: { reason: reason ?? null },
    });

    await this.settleIfFinished(tx, ctx, prescription.id, consultation);
    return this.presentItem(updated);
  }

  /**
   * The consultation was abandoned, so the prescription goes with it.
   * Called by CON, inside its transaction.
   */
  async cancelForConsultation(tx: Tx, ctx: TenantContext, consultationId: string, reason: string) {
    const prescription = await tx.prescription.findFirst({ where: { consultationId } });
    if (!prescription) return { cancelled: 0 };
    if (prescription.status === PrescriptionStatus.CANCELLED) return { cancelled: 0 };

    // A draft item can simply go; a prescribed one is cancelled with the
    // reason, because the pharmacy has seen it.
    await tx.prescriptionItem.deleteMany({
      where: { prescriptionId: prescription.id, status: PrescriptionItemStatus.DRAFT },
    });
    const { count } = await tx.prescriptionItem.updateMany({
      where: {
        prescriptionId: prescription.id,
        status: { in: [PrescriptionItemStatus.ACTIVE, PrescriptionItemStatus.PARTIAL] },
      },
      data: { status: PrescriptionItemStatus.CANCELLED, cancelledReason: reason },
    });

    await tx.prescription.update({
      where: { id: prescription.id },
      data: { status: PrescriptionStatus.CANCELLED },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PrescriptionCancelled,
      entityType: 'prescription',
      entityId: prescription.id,
      subjectPatientId: prescription.patientId,
      after: { reason, items: count },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionCancelled,
      tenantId: ctx.tenantId,
      branchId: prescription.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { prescriptionId: prescription.id, consultationId, reason },
    });

    return { cancelled: count };
  }

  /** Once no item is still waiting, the prescription is done with. */
  private async settleIfFinished(
    tx: Tx,
    ctx: TenantContext,
    prescriptionId: string,
    consultation: { patientId: string; branchId: string },
  ) {
    const pending = await tx.prescriptionItem.count({
      where: {
        prescriptionId,
        isCurrent: true,
        status: { in: [PrescriptionItemStatus.ACTIVE, PrescriptionItemStatus.PARTIAL] },
      },
    });
    if (pending > 0) return;

    const prescription = await tx.prescription.findFirst({ where: { id: prescriptionId } });
    if (!prescription || prescription.status !== PrescriptionStatus.ACTIVE) return;

    const now = this.clock.now();
    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { status: PrescriptionStatus.COMPLETED, completedAt: now },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionCompleted,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { prescriptionId, patientId: consultation.patientId },
    });
  }

  // -------------------------------------------------------------------
  // Favourites (RX-F-10)
  // -------------------------------------------------------------------

  async favourites(ctx: TenantContext) {
    const tx = this.db.tx();
    const rows = await tx.rxFavourite.findMany({
      where: { userId: ctx.userId },
      orderBy: [{ uses: 'desc' }, { lastUsedAt: 'desc' }],
      take: 30,
    });
    if (rows.length === 0) return { items: [] };

    const products = await tx.product.findMany({
      where: { id: { in: rows.map((r) => r.productId) }, status: ProductStatus.ACTIVE },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return {
      items: rows
        .filter((row) => byId.has(row.productId))
        .map((row) => ({
          id: row.id,
          productId: row.productId,
          uses: row.uses,
          lastUsedAt: row.lastUsedAt,
          defaults: row.defaults,
          product: this.presentProduct(byId.get(row.productId)!),
        })),
    };
  }

  async removeFavourite(ctx: TenantContext, productId: string) {
    const tx = this.db.tx();
    await tx.rxFavourite.deleteMany({ where: { userId: ctx.userId, productId } });
    return { removed: true };
  }

  /**
   * Counted rather than declared: what a doctor prescribes is a better
   * guide to what they will prescribe than a list they once curated and
   * then forgot about.
   */
  private async noteFavourite(tx: Tx, ctx: TenantContext, productId: string, defaults: object) {
    const existing = await tx.rxFavourite.findFirst({
      where: { userId: ctx.userId, productId },
      select: { id: true, uses: true },
    });
    if (existing) {
      await tx.rxFavourite.update({
        where: { id: existing.id },
        data: { uses: existing.uses + 1, lastUsedAt: this.clock.now(), defaults },
      });
      return;
    }
    await tx.rxFavourite.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        userId: ctx.userId,
        productId,
        defaults,
        uses: 1,
        lastUsedAt: this.clock.now(),
      },
    });
  }

  // -------------------------------------------------------------------
  // Building an item
  // -------------------------------------------------------------------

  private async resolve(tx: Tx, input: ItemInput, language: Language) {
    const productId = input.productId?.trim() || null;
    const externalName = input.externalName?.trim() || null;

    if (!productId && !externalName) {
      throw new BadRequestError(
        'Say what is being prescribed: pick it from the catalogue, or write the name for the patient to have it filled elsewhere.',
        'item_names_nothing',
      );
    }
    if (productId && externalName) {
      throw new BadRequestError(
        'An item is either from the catalogue or written out by hand, not both.',
        'item_names_two_things',
      );
    }

    if (!isFrequencyCode(input.frequencyCode)) {
      throw new BadRequestError(`"${input.frequencyCode}" is not a frequency.`, 'invalid_frequency');
    }
    const frequencyCode = input.frequencyCode;

    if (!DOSE_UNITS.includes(input.doseUnit as (typeof DOSE_UNITS)[number])) {
      throw new BadRequestError(`"${input.doseUnit}" is not a dose unit.`, 'invalid_dose_unit');
    }
    if (!ROUTES.includes(input.route as (typeof ROUTES)[number])) {
      throw new BadRequestError(`"${input.route}" is not a route.`, 'invalid_route');
    }
    if (!(input.doseValue > 0)) {
      throw new BadRequestError('The dose has to be more than nothing.', 'invalid_dose');
    }

    const isPrn = input.isPrn ?? false;
    if (isPrn && !(input.prnIndication ?? '').trim()) {
      throw new BadRequestError(
        'Say what this is to be taken for, or the label will read "take when required" and leave the patient to decide.',
        'prn_indication_required',
      );
    }

    const untilFinished = input.untilFinished ?? false;
    const durationDays = untilFinished ? null : (input.durationDays ?? null);
    if (!untilFinished && (!durationDays || durationDays < 1 || durationDays > 365)) {
      throw new BadRequestError(
        'Say how many days this runs for (1 to 365), or mark it "until finished".',
        'invalid_duration',
      );
    }

    if (frequencyCode === 'CUSTOM' && !(input.frequencyPerDay && input.frequencyPerDay > 0)) {
      throw new BadRequestError(
        'A custom frequency needs a number of doses a day.',
        'custom_frequency_needs_rate',
      );
    }

    const product = productId ? await this.medicineOrThrow(tx, productId) : null;

    // RX-R-02: copied now, so the record says what was prescribed rather
    // than what the product happens to be called when it is read back.
    const genericName = product
      ? (product.genericName ?? product.name)
      : externalName!;
    const drugClass = product?.drugClass ?? null;
    const strength = product?.strengthText ?? null;
    const displayName = product
      ? [product.name, product.strengthText].filter(Boolean).join(' ')
      : externalName!;

    const calculated = calculateQuantity({
      doseValue: input.doseValue,
      doseUnit: input.doseUnit,
      frequencyCode,
      frequencyPerDay: input.frequencyPerDay ?? null,
      durationDays,
      untilFinished,
      dispenseUnit: product?.dispenseUnit ?? null,
      strengthValue: product?.strengthValue === null || product?.strengthValue === undefined
        ? null
        : Number(product.strengthValue),
      strengthUnit: product?.strengthUnit ?? null,
    });

    const given = input.quantity ?? null;
    if (given !== null && !(given > 0)) {
      throw new BadRequestError('The quantity has to be more than nothing.', 'invalid_quantity');
    }
    if (given === null && !calculated) {
      throw new BadRequestError(
        'The quantity cannot be worked out from this dose and frequency. Say how much to dispense.',
        'quantity_required',
      );
    }

    const quantity = given ?? calculated!.quantity;
    const quantityUnit = product?.dispenseUnit ?? calculated?.unit ?? input.doseUnit;
    // RX-T-05: the badge only stays on a number nobody has typed over.
    const quantityAuto = given === null;

    // What the patient counts out. A doctor writes 500 mg; the person
    // reading the bag is holding capsules, and asking them to divide is
    // asking for the mistake.
    const dispenseUnit = product?.dispenseUnit ?? null;
    const perDose = dispenseUnit
      ? unitsPerDose(
          {
            doseValue: input.doseValue,
            doseUnit: input.doseUnit,
            frequencyCode,
            untilFinished,
            strengthValue:
              product?.strengthValue == null ? null : Number(product.strengthValue),
            strengthUnit: product?.strengthUnit ?? null,
          },
          dispenseUnit,
        )
      : null;

    const labelText = buildLabel(
      {
        displayName: product?.name ?? externalName!,
        strength,
        doseValue: perDose ?? input.doseValue,
        doseUnit: perDose === null ? input.doseUnit : dispenseUnit!,
        route: input.route,
        frequencyCode,
        frequencyPerDay: input.frequencyPerDay ?? null,
        isPrn,
        prnIndication: input.prnIndication ?? null,
        durationDays,
        untilFinished,
        instructions: input.instructions ?? null,
      },
      language,
    );

    return {
      substance: { productId, genericName, drugClass, displayName } satisfies ItemSubstance,
      dailyDose: this.dailyDose(input.doseValue, frequencyCode, input.frequencyPerDay ?? null),
      doseUnit: input.doseUnit,
      maxDailyDose:
        product?.maxDailyDose === null || product?.maxDailyDose === undefined
          ? null
          : Number(product.maxDailyDose),
      maxDailyDoseUnit: product?.maxDailyDoseUnit ?? null,
      formula: calculated?.formula ?? null,
      data: {
        productId,
        externalName,
        genericName,
        drugClass,
        strength,
        displayName,
        doseValue: input.doseValue,
        doseUnit: input.doseUnit,
        route: input.route,
        frequencyCode,
        frequencyPerDay: input.frequencyPerDay ?? perDay(frequencyCode, null),
        isPrn,
        prnIndication: isPrn ? input.prnIndication!.trim() : null,
        durationDays,
        untilFinished,
        quantity,
        quantityUnit,
        quantityAuto,
        instructions: input.instructions?.trim() || null,
        labelText,
        isExternal: product === null,
        // RX-R-09: snapshotted, because whether it was a controlled drug
        // when it was prescribed is what the register asks.
        isControlled: product?.isControlled ?? false,
      },
    };
  }

  private dailyDose(
    doseValue: number,
    frequencyCode: FrequencyCode,
    custom: number | null,
  ): number | null {
    const rate = perDay(frequencyCode, custom);
    if (rate === null) return null;
    return doseValue * rate;
  }

  // -------------------------------------------------------------------
  // The safety checks
  // -------------------------------------------------------------------

  private async loadSafety(tx: Tx, patientId: string): Promise<SafetyContext> {
    const patient = await tx.patient.findFirst({
      where: { id: patientId },
      select: { id: true, nkdaRecorded: true },
    });
    if (!patient) throw new NotFoundError('Patient');

    const allergies = await tx.patientAllergy.findMany({
      where: { patientId, status: { not: AllergyStatus.REFUTED } },
      select: {
        id: true,
        productId: true,
        substance: true,
        drugClass: true,
        reaction: true,
        severity: true,
        status: true,
      },
    });

    return { patientId, nkdaRecorded: patient.nkdaRecorded, allergies };
  }

  private async safetySummary(tx: Tx, patientId: string) {
    const safety = await this.loadSafety(tx, patientId);
    return {
      id: patientId,
      nkdaRecorded: safety.nkdaRecorded,
      allergies: safety.allergies,
      allergiesUnknown: safety.nkdaRecorded === null && safety.allergies.length === 0,
    };
  }

  /**
   * RX-R-03: every warning, computed here and nowhere else.
   *
   * Order matters for how it reads on screen: the allergy first because
   * it is the one that could hurt somebody, then the duplicate, then the
   * dose, then the administrative one about the allergy list itself.
   */
  private async evaluate(
    tx: Tx,
    safety: SafetyContext,
    resolved: {
      substance: ItemSubstance;
      dailyDose: number | null;
      doseUnit: string;
      maxDailyDose: number | null;
      maxDailyDoseUnit: string | null;
    },
    scope: { prescriptionId: string | null; excludeItemId?: string },
  ): Promise<Warning[]> {
    const warnings: Warning[] = [...matchAllergies(resolved.substance, safety.allergies)];

    warnings.push(...(await this.duplicates(tx, safety.patientId, resolved.substance, scope)));

    if (
      resolved.dailyDose !== null &&
      resolved.maxDailyDose !== null &&
      resolved.maxDailyDoseUnit === resolved.doseUnit
    ) {
      const warning = maxDoseWarning(
        resolved.dailyDose,
        resolved.maxDailyDose,
        resolved.maxDailyDoseUnit,
      );
      if (warning) warnings.push(warning);
    }

    // RX-F-14: last, because it is about the record rather than about
    // this drug — but present, because "no allergies listed" and "nobody
    // asked" look identical on a screen and are not the same thing.
    if (safety.nkdaRecorded === null && safety.allergies.length === 0) {
      warnings.push(NO_ALLERGY_RECORD);
    }

    return warnings;
  }

  /** RX-F-13, RX-T-04: the same substance, here or anywhere, recently. */
  private async duplicates(
    tx: Tx,
    patientId: string,
    substance: ItemSubstance,
    scope: { prescriptionId: string | null; excludeItemId?: string },
  ): Promise<Warning[]> {
    const since = new Date(this.clock.now().getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000);

    const rows = await tx.prescriptionItem.findMany({
      where: {
        genericName: { equals: substance.genericName, mode: 'insensitive' },
        isCurrent: true,
        // A prescribed item anywhere counts. A draft one counts only on
        // this prescription — an abandoned draft in somebody else's
        // unfinished consultation is not a fact about the patient, and
        // warning about it would train doctors to ignore the banner.
        OR: [
          {
            status: {
              in: [
                PrescriptionItemStatus.ACTIVE,
                PrescriptionItemStatus.PARTIAL,
                PrescriptionItemStatus.DISPENSED,
              ],
            },
          },
          ...(scope.prescriptionId
            ? [{ status: PrescriptionItemStatus.DRAFT, prescriptionId: scope.prescriptionId }]
            : []),
        ],
        createdAt: { gte: since },
        ...(scope.excludeItemId ? { id: { not: scope.excludeItemId } } : {}),
        prescription: { patientId },
      },
      select: {
        id: true,
        genericName: true,
        createdAt: true,
        prescriptionId: true,
        prescription: {
          select: { branchId: true, prescribedBy: true, signedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (rows.length === 0) return [];

    // A draft item that has not been saved yet has no prescription to be
    // "on", so a null scope means everything found is from elsewhere.
    const doctorIds = [...new Set(rows.map((r) => r.prescription.prescribedBy))];
    const branchIds = [...new Set(rows.map((r) => r.prescription.branchId))];
    const [doctors, branches] = await Promise.all([
      tx.user.findMany({ where: { id: { in: doctorIds } }, select: { id: true, name: true } }),
      tx.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }),
    ]);
    const doctorName = new Map(doctors.map((d) => [d.id, d.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    return rows.map((row): Warning => {
      const sameVisit = scope.prescriptionId !== null && row.prescriptionId === scope.prescriptionId;
      const when = (row.prescription.signedAt ?? row.createdAt).toISOString().slice(0, 10);
      const where = branchName.get(row.prescription.branchId) ?? 'another branch';
      const who = doctorName.get(row.prescription.prescribedBy) ?? 'another doctor';
      return {
        type: 'DUPLICATE',
        itemId: row.id,
        genericName: row.genericName,
        prescribedAt: when,
        doctorName: who,
        branchName: where,
        sameVisit,
        message: sameVisit
          ? `${substance.genericName} is already on this prescription.`
          : `${substance.genericName} was prescribed on ${when} at ${where} by ${who}, within the last ${DUPLICATE_WINDOW_DAYS} days.`,
      };
    });
  }

  // -------------------------------------------------------------------
  // Guards and lookups
  // -------------------------------------------------------------------

  private async consultationOrThrow(tx: Tx, id: string) {
    const consultation = await tx.consultation.findFirst({
      where: { id },
      select: {
        id: true,
        encounterId: true,
        patientId: true,
        branchId: true,
        doctorId: true,
        status: true,
      },
    });
    if (!consultation) throw new NotFoundError('Consultation');
    return consultation;
  }

  private assertMayRead(
    ctx: TenantContext,
    consultation: { doctorId: string; status: ConsultationStatus },
  ) {
    if (consultation.status !== ConsultationStatus.DRAFT) return;
    if (consultation.doctorId === ctx.userId) return;
    if (ctx.permissions.has('admin.settings')) return;
    throw new NotFoundError('Consultation');
  }

  /**
   * RX-R-07: the doctor writing the note is the one prescribing.
   *
   * Another doctor gets "not found" on a draft rather than "forbidden",
   * matching CON: half-written clinical thinking is not a record yet, and
   * that one exists is not something a colleague needs to learn from an
   * error message. Once it is signed there is no secret left to keep, so
   * the honest "this is not yours" is better.
   */
  private assertPrescriber(
    ctx: TenantContext,
    consultation: { doctorId: string; status: ConsultationStatus },
  ) {
    if (consultation.doctorId === ctx.userId) return;
    if (consultation.status === ConsultationStatus.DRAFT) throw new NotFoundError('Consultation');
    throw new ForbiddenError('This consultation belongs to another doctor.');
  }

  private assertItemDraft(item: { status: PrescriptionItemStatus }) {
    if (item.status !== PrescriptionItemStatus.DRAFT) {
      throw new ConflictError(
        'This has been prescribed and is part of the record. Amend it instead.',
        'item_prescribed',
      );
    }
  }

  private assertAmendable(
    item: { status: PrescriptionItemStatus },
    prescription: { status: PrescriptionStatus },
  ) {
    if (prescription.status === PrescriptionStatus.DRAFT) {
      throw new ConflictError(
        'This has not been prescribed yet. Change it directly rather than amending it.',
        'not_yet_prescribed',
      );
    }
    if (prescription.status === PrescriptionStatus.CANCELLED) {
      throw new ConflictError('This prescription was cancelled.', 'prescription_cancelled');
    }
    if (
      item.status === PrescriptionItemStatus.SUPERSEDED ||
      item.status === PrescriptionItemStatus.CANCELLED
    ) {
      throw new ConflictError(
        'This version of the item has already been replaced or cancelled.',
        'item_not_current',
      );
    }
  }

  private async itemContext(tx: Tx, itemId: string) {
    const item = await tx.prescriptionItem.findFirst({ where: { id: itemId } });
    if (!item) throw new NotFoundError('Prescription item');

    const prescription = await tx.prescription.findFirst({
      where: { id: item.prescriptionId },
    });
    if (!prescription) throw new NotFoundError('Prescription');

    const consultation = await this.consultationOrThrow(tx, prescription.consultationId);
    return { item, prescription, consultation };
  }

  private async medicineOrThrow(tx: Tx, productId: string) {
    const product = await tx.product.findFirst({ where: { id: productId } });
    if (!product) throw new NotFoundError('Product');
    if (product.type !== ProductType.MEDICINE) {
      throw new BadRequestError(
        `${product.name} is not a medicine, so it cannot be prescribed.`,
        'not_a_medicine',
      );
    }
    if (product.status !== ProductStatus.ACTIVE) {
      throw new ConflictError(
        `${product.name} has been withdrawn from the catalogue.`,
        'product_retired',
      );
    }
    // RX-N-02 depends on this: without a generic name an allergy check
    // has nothing to match on, and would quietly find nothing.
    if (!product.genericName) {
      throw new InvariantViolationError(
        'product_has_no_generic',
        `${product.name} has no generic name recorded, so it cannot be checked against the patient's allergies. Add one to the catalogue first.`,
        { productId },
      );
    }
    return product;
  }

  private async openPrescription(
    tx: Tx,
    ctx: TenantContext,
    consultation: {
      id: string;
      encounterId: string;
      patientId: string;
      branchId: string;
      status: ConsultationStatus;
    },
  ) {
    if (consultation.status !== ConsultationStatus.DRAFT) {
      throw new ConflictError(
        'This consultation has been signed. Amend the prescription instead of adding to it.',
        'consultation_signed',
      );
    }

    const existing = await tx.prescription.findFirst({
      where: { consultationId: consultation.id },
    });
    if (existing) return existing;

    const patient = await tx.patient.findFirst({
      where: { id: consultation.patientId },
      select: { preferredLanguage: true },
    });

    const created = await tx.prescription.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        encounterId: consultation.encounterId,
        consultationId: consultation.id,
        patientId: consultation.patientId,
        branchId: consultation.branchId,
        prescribedBy: ctx.userId,
        status: PrescriptionStatus.DRAFT,
        // RX-F-07: the label is for the patient, so it is in their
        // language, not the clinic's.
        language: this.labelLanguage(patient?.preferredLanguage),
      },
    });

    this.events.publish({
      name: DomainEvent.PrescriptionCreated,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { prescriptionId: created.id, consultationId: consultation.id },
    });

    return created;
  }

  /**
   * RX-Q-02 is open on whether Chinese and Tamil labels are needed. Until
   * it is answered, anything that is not English gets Malay, which every
   * patient at the pilot clinic reads.
   */
  private labelLanguage(preferred: string | null | undefined): Language {
    return (preferred ?? '').toUpperCase().startsWith('EN') ? 'EN' : 'MS';
  }

  // -------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------

  private presentPrescription(row: {
    id: string;
    status: PrescriptionStatus;
    language: string;
    notesToDispenser: string | null;
    signedAt: Date | null;
    completedAt: Date | null;
    consultationId: string;
    encounterId: string;
    patientId: string;
  }) {
    return {
      id: row.id,
      status: row.status,
      language: row.language,
      notesToDispenser: row.notesToDispenser,
      signedAt: row.signedAt,
      completedAt: row.completedAt,
      consultationId: row.consultationId,
      encounterId: row.encounterId,
      patientId: row.patientId,
    };
  }

  private presentItem(row: ItemRow) {
    return {
      id: row.id as string,
      version: row.version as number,
      supersedesId: (row.supersedesId as string | null) ?? null,
      isCurrent: row.isCurrent as boolean,
      productId: (row.productId as string | null) ?? null,
      externalName: (row.externalName as string | null) ?? null,
      genericName: row.genericName as string,
      drugClass: (row.drugClass as string | null) ?? null,
      strength: (row.strength as string | null) ?? null,
      displayName: row.displayName as string,
      doseValue: Number(row.doseValue),
      doseUnit: row.doseUnit as string,
      route: row.route as string,
      frequencyCode: row.frequencyCode as string,
      frequencyPerDay: row.frequencyPerDay === null ? null : Number(row.frequencyPerDay),
      isPrn: row.isPrn as boolean,
      prnIndication: (row.prnIndication as string | null) ?? null,
      durationDays: (row.durationDays as number | null) ?? null,
      untilFinished: row.untilFinished as boolean,
      quantity: Number(row.quantity),
      quantityUnit: row.quantityUnit as string,
      quantityAuto: row.quantityAuto as boolean,
      instructions: (row.instructions as string | null) ?? null,
      labelText: row.labelText as string,
      isExternal: row.isExternal as boolean,
      isControlled: row.isControlled as boolean,
      status: row.status as PrescriptionItemStatus,
      warnings: (row.warnings ?? []) as Warning[],
      overrideReason: (row.overrideReason as string | null) ?? null,
      overriddenBy: (row.overriddenBy as string | null) ?? null,
      overriddenAt: (row.overriddenAt as Date | null) ?? null,
      overrideConfirmedAt: (row.overrideConfirmedAt as Date | null) ?? null,
      cancelledReason: (row.cancelledReason as string | null) ?? null,
      createdBy: (row.createdBy as string | null) ?? null,
      createdAt: row.createdAt as Date,
    };
  }

  private presentProduct(product: {
    id: string;
    name: string;
    genericName: string | null;
    strengthText: string | null;
    dispenseUnit: string;
    defaultDose: unknown;
    defaultDoseUnit: string | null;
    defaultRoute: string | null;
    defaultFrequency: string | null;
    isControlled: boolean;
  }) {
    return {
      id: product.id,
      name: product.name,
      genericName: product.genericName,
      strengthText: product.strengthText,
      dispenseUnit: product.dispenseUnit,
      defaultDose: product.defaultDose === null ? null : Number(product.defaultDose),
      defaultDoseUnit: product.defaultDoseUnit,
      defaultRoute: product.defaultRoute,
      defaultFrequency: product.defaultFrequency,
      isControlled: product.isControlled,
    };
  }
}
