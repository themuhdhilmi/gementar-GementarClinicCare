import { Injectable } from '@nestjs/common';
import {
  AllergyStatus,
  AllergyType,
  ConditionStatus,
  type AllergySeverity,
} from '../../generated/prisma/enums.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PatientService } from './patient.service.js';
import { assertAllergySubstance } from './patient.validation.js';

export type AllergyInput = {
  type: AllergyType;
  substance: string;
  productId?: string | null;
  drugClass?: string | null;
  reaction?: string | null;
  severity?: AllergySeverity | null;
  notes?: string | null;
};

export type ConditionInput = {
  condition: string;
  icd10Code?: string | null;
  onsetDate?: string | null;
  status?: ConditionStatus;
  notes?: string | null;
};

/**
 * What the clinic knows about a patient that changes what may be prescribed.
 *
 * Two design points carry the weight here. An allergy is never deleted, only
 * refuted, because "we used to think they were allergic to penicillin" is
 * itself clinically useful. And "nobody has asked about allergies" is a state
 * of its own, separate from "no allergies", because a doctor treats those two
 * patients differently and a boolean would collapse them.
 */
@Injectable()
export class PatientClinicalService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly patients: PatientService,
  ) {}

  /**
   * PAT-F-14, PAT-N-03: everything a clinical screen header needs, in one
   * query, so the header never costs a second round trip.
   */
  async summary(tx: Tx, patientId: string) {
    const [allergies, conditions, patient] = await Promise.all([
      tx.patientAllergy.findMany({
        where: { patientId },
        orderBy: [{ status: 'asc' }, { recordedAt: 'desc' }],
      }),
      tx.patientCondition.findMany({
        where: { patientId },
        orderBy: [{ status: 'asc' }, { recordedAt: 'desc' }],
      }),
      tx.patient.findFirst({
        where: { id: patientId },
        select: { nkdaRecorded: true, nkdaRecordedAt: true },
      }),
    ]);
    if (!patient) throw new NotFoundError('Patient');

    const active = allergies.filter((a) => a.status !== AllergyStatus.REFUTED);
    const severe = active.filter(
      (a) => a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING',
    );

    return {
      allergies,
      conditions,
      nkdaRecorded: patient.nkdaRecorded,
      nkdaRecordedAt: patient.nkdaRecordedAt,
      // PAT-F-12: the three states the header shows, decided here rather than
      // in each screen, so TRI, CON, RX and DSP cannot disagree.
      allergyState:
        severe.length > 0
          ? 'SEVERE'
          : active.length > 0
            ? 'SOME'
            : patient.nkdaRecorded === true
              ? 'NKDA'
              : 'NOT_RECORDED',
      allergyCount: active.length,
    };
  }

  /**
   * PAT-F-11, PAT-T-06: who recorded it decides whether it is verified.
   *
   * A doctor writing down an allergy is a clinical judgement and stands on
   * its own. Anybody else is recording what they were told, which a
   * clinician confirms later. That distinction is the difference between a
   * warning a prescriber can rely on and one they have to check.
   */
  async addAllergy(ctx: TenantContext, patientId: string, input: AllergyInput) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);

    const substance = assertAllergySubstance(input.substance);
    if (input.type === AllergyType.DRUG && !input.severity) {
      throw new BadRequestError(
        'A drug allergy needs a severity: it decides whether a prescription is blocked or only flagged.',
        'severity_required',
      );
    }

    const clinician = ctx.permissions.has('clinical.write');
    const id = newId();
    const now = this.clock.now();

    await tx.patientAllergy.create({
      data: {
        id,
        tenantId: requireTenantId(),
        patientId,
        type: input.type,
        substance,
        productId: input.productId ?? null,
        drugClass: input.drugClass ?? null,
        reaction: input.reaction ?? null,
        severity: input.severity ?? null,
        status: clinician ? AllergyStatus.VERIFIED : AllergyStatus.UNVERIFIED,
        recordedBy: ctx.userId,
        recordedAt: now,
        verifiedBy: clinician ? ctx.userId : null,
        verifiedAt: clinician ? now : null,
        notes: input.notes ?? null,
      },
    });

    // Recording an allergy answers the "has anyone asked?" question, so the
    // amber state clears without anyone having to tick a second box.
    await tx.patient.update({
      where: { id: patientId },
      data: { nkdaRecorded: false, nkdaRecordedBy: ctx.userId, nkdaRecordedAt: now },
    });

    const created = await tx.patientAllergy.findFirst({ where: { id } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientAllergyAdded,
      entityType: 'patient_allergy',
      entityId: id,
      subjectPatientId: patientId,
      after: created,
    });
    this.events.publish({
      name: DomainEvent.PatientAllergyAdded,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      // RX listens for this and re-checks anything already prescribed.
      payload: { patientId, allergyId: id, substance, severity: input.severity ?? null },
    });

    return created;
  }

  async verifyAllergy(ctx: TenantContext, patientId: string, allergyId: string) {
    const tx = this.db.tx();
    const before = await this.allergyOrThrow(tx, patientId, allergyId);
    if (before.status === AllergyStatus.VERIFIED) return before;
    if (before.status === AllergyStatus.REFUTED) {
      throw new BadRequestError(
        'This allergy was refuted. Record it again rather than reviving the old entry.',
        'allergy_refuted',
      );
    }

    const now = this.clock.now();
    await tx.patientAllergy.update({
      where: { id: allergyId },
      data: { status: AllergyStatus.VERIFIED, verifiedBy: ctx.userId, verifiedAt: now },
    });

    const after = await this.allergyOrThrow(tx, patientId, allergyId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientAllergyVerified,
      entityType: 'patient_allergy',
      entityId: allergyId,
      subjectPatientId: patientId,
      before: { status: before.status },
      after: { status: after.status },
    });
    this.events.publish({
      name: DomainEvent.PatientAllergyVerified,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId, allergyId },
    });
    return after;
  }

  /**
   * PAT-F-15, PAT-T-07: removing an allergy keeps it.
   *
   * The record that somebody once believed this, and that a named clinician
   * later decided otherwise and why, is exactly what the next prescriber
   * needs. A delete would leave them re-asking a question that has already
   * been answered.
   */
  async refuteAllergy(ctx: TenantContext, patientId: string, allergyId: string, reason: string) {
    const tx = this.db.tx();
    const before = await this.allergyOrThrow(tx, patientId, allergyId);
    if (!reason.trim()) {
      throw new BadRequestError(
        'Say why this is not an allergy. The entry stays in the record either way.',
        'reason_required',
      );
    }

    const now = this.clock.now();
    await tx.patientAllergy.update({
      where: { id: allergyId },
      data: {
        status: AllergyStatus.REFUTED,
        refutedBy: ctx.userId,
        refutedAt: now,
        refutedReason: reason.trim(),
      },
    });

    const after = await this.allergyOrThrow(tx, patientId, allergyId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientAllergyRefuted,
      entityType: 'patient_allergy',
      entityId: allergyId,
      subjectPatientId: patientId,
      before: { status: before.status },
      after: { status: after.status },
      reason,
    });
    this.events.publish({
      name: DomainEvent.PatientAllergyRefuted,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId, allergyId },
    });
    return after;
  }

  /**
   * PAT-F-12: "no known drug allergies", recorded by a named person.
   *
   * This is what turns the amber "not recorded" header green. It is an
   * assertion somebody is accountable for, not the absence of data, which is
   * why it carries who and when.
   */
  async recordNkda(ctx: TenantContext, patientId: string, nkda: boolean) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);

    if (nkda) {
      const active = await tx.patientAllergy.count({
        where: { patientId, status: { not: AllergyStatus.REFUTED } },
      });
      if (active > 0) {
        throw new BadRequestError(
          `This patient has ${active} allergy record${active === 1 ? '' : 's'}. Refute them before ` +
            'recording no known allergies.',
          'allergies_present',
        );
      }
    }

    const now = this.clock.now();
    await tx.patient.update({
      where: { id: patientId },
      data: { nkdaRecorded: nkda, nkdaRecordedBy: ctx.userId, nkdaRecordedAt: now },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientNkdaRecorded,
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      after: { nkdaRecorded: nkda },
    });

    return this.summary(tx, patientId);
  }

  // ------------------------------------------------------------ conditions

  async addCondition(ctx: TenantContext, patientId: string, input: ConditionInput) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);

    const condition = input.condition.trim().replaceAll(/\s+/g, ' ');
    if (condition.length < 2 || condition.length > 200) {
      throw new BadRequestError('Name the condition.', 'invalid_condition');
    }

    const id = newId();
    const now = this.clock.now();
    await tx.patientCondition.create({
      data: {
        id,
        tenantId: requireTenantId(),
        patientId,
        condition,
        icd10Code: input.icd10Code ?? null,
        onsetDate: input.onsetDate ? new Date(input.onsetDate) : null,
        status: input.status ?? ConditionStatus.ACTIVE,
        recordedBy: ctx.userId,
        recordedAt: now,
        notes: input.notes ?? null,
      },
    });

    const created = await tx.patientCondition.findFirst({ where: { id } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientConditionChanged,
      entityType: 'patient_condition',
      entityId: id,
      subjectPatientId: patientId,
      after: created,
    });
    this.events.publish({
      name: DomainEvent.PatientConditionChanged,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId, conditionId: id },
    });
    return created;
  }

  async updateCondition(
    ctx: TenantContext,
    patientId: string,
    conditionId: string,
    input: Partial<ConditionInput>,
  ) {
    const tx = this.db.tx();
    const before = await tx.patientCondition.findFirst({
      where: { id: conditionId, patientId },
    });
    if (!before) throw new NotFoundError('Condition');

    const data: Record<string, unknown> = {};
    if (input.condition !== undefined) data['condition'] = input.condition.trim();
    if (input.icd10Code !== undefined) data['icd10Code'] = input.icd10Code ?? null;
    if (input.onsetDate !== undefined) {
      data['onsetDate'] = input.onsetDate ? new Date(input.onsetDate) : null;
    }
    if (input.notes !== undefined) data['notes'] = input.notes ?? null;
    if (input.status !== undefined) {
      data['status'] = input.status;
      data['resolvedAt'] = input.status === ConditionStatus.RESOLVED ? this.clock.now() : null;
    }

    await tx.patientCondition.update({ where: { id: conditionId }, data });
    const after = await tx.patientCondition.findFirst({ where: { id: conditionId } });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientConditionChanged,
      entityType: 'patient_condition',
      entityId: conditionId,
      subjectPatientId: patientId,
      before,
      after,
    });
    return after;
  }

  private async allergyOrThrow(tx: Tx, patientId: string, allergyId: string) {
    const allergy = await tx.patientAllergy.findFirst({ where: { id: allergyId, patientId } });
    if (!allergy) throw new NotFoundError('Allergy');
    return allergy;
  }
}
