import { Injectable, Logger } from '@nestjs/common';
import {
  AmendmentType,
  ConsultationStatus,
  DiagnosisCertainty,
  DiagnosisRank,
  EncounterStatus,
  Role,
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
import type { TenantContext } from '../tenancy/tenant-context.js';
import { EncounterService } from '../encounter/encounter.service.js';
import { ConsultationSignRegistry } from './consultation-sign.registry.js';
import { TriageService } from '../triage/triage.service.js';
import { hashContent, type SignableContent } from './content-hash.js';

/** The sections a doctor writes. Also the fields an amendment may correct. */
export const CLINICAL_FIELDS = [
  'chiefComplaint',
  'hpi',
  'history',
  'examination',
  'planText',
] as const;

export type ClinicalField = (typeof CLINICAL_FIELDS)[number];

export type ConsultationDraft = Partial<Record<ClinicalField, string | null>> & {
  followUpDue?: string | null;
  followUpNote?: string | null;
};

export type DiagnosisInput = {
  rank?: DiagnosisRank;
  description: string;
  icd10Code?: string | null;
  icd10Label?: string | null;
  certainty?: DiagnosisCertainty;
  isChronic?: boolean;
};

const SELECT = {
  id: true,
  encounterId: true,
  patientId: true,
  branchId: true,
  doctorId: true,
  sequence: true,
  status: true,
  chiefComplaint: true,
  hpi: true,
  history: true,
  examination: true,
  planText: true,
  templateId: true,
  copiedFromId: true,
  followUpDue: true,
  followUpNote: true,
  startedAt: true,
  lastAutosaveAt: true,
  signedAt: true,
  signedBy: true,
  cancelledAt: true,
  cancelReason: true,
  contentHash: true,
} as const;

/** How long a draft may sit unsigned before it is somebody's problem. */
export const STALE_DRAFT_HOURS = 24;

/**
 * The clinical record of a visit.
 *
 * Three things this module has to get right, in order of how badly they go
 * wrong: a signed record cannot be silently altered, a draft cannot be lost,
 * and writing one has to be quick enough that a doctor does not go back to
 * paper.
 */
@Injectable()
export class ConsultationService {
  private readonly logger = new Logger(ConsultationService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly encounters: EncounterService,
    private readonly triage: TriageService,
    private readonly signHooks: ConsultationSignRegistry,
    private readonly charges: ChargeRegistry,
  ) {}

  // ------------------------------------------------------------- reading

  async getOrThrow(tx: Tx, id: string) {
    const consultation = await tx.consultation.findFirst({ where: { id }, select: SELECT });
    if (!consultation) throw new NotFoundError('Consultation');
    return consultation;
  }

  /**
   * CON-F-13, CON-T-06: a draft belongs to the doctor writing it.
   *
   * Another doctor gets "not found" rather than "forbidden": half-written
   * clinical thinking is not a record yet, and the existence of one is not
   * something a colleague needs to know about. An administrator may see it,
   * because somebody has to be able to reassign it when a locum leaves, and
   * that is recorded as break-glass.
   */
  private assertMayRead(ctx: TenantContext, consultation: { doctorId: string; status: ConsultationStatus }) {
    if (consultation.status !== ConsultationStatus.DRAFT) return;
    if (consultation.doctorId === ctx.userId) return;
    if (ctx.permissions.has('admin.settings')) return;
    throw new NotFoundError('Consultation');
  }

  private assertOwner(ctx: TenantContext, consultation: { doctorId: string }) {
    if (consultation.doctorId !== ctx.userId) {
      throw new ForbiddenError('This consultation belongs to another doctor.');
    }
  }

  private assertDraft(consultation: { status: ConsultationStatus; signedAt: Date | null }) {
    if (consultation.status === ConsultationStatus.SIGNED) {
      throw new ConflictError(
        `This consultation was signed on ${consultation.signedAt?.toISOString().slice(0, 10)} ` +
          'and is part of the record. Record an amendment instead.',
        'consultation_signed',
      );
    }
    if (consultation.status === ConsultationStatus.CANCELLED) {
      throw new ConflictError('This draft was cancelled.', 'consultation_cancelled');
    }
  }

  async read(ctx: TenantContext, id: string) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);
    this.assertMayRead(ctx, consultation);

    const [diagnoses, amendments] = await Promise.all([
      tx.diagnosis.findMany({ where: { consultationId: id }, orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }] }),
      tx.consultationAmendment.findMany({
        where: { consultationId: id },
        orderBy: { amendedAt: 'asc' },
      }),
    ]);

    // CON-R-05: every read of a clinical record is recorded, and an
    // administrator reading one is break-glass.
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ClinicalViewed,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: consultation.patientId,
    });

    return { consultation: this.present(consultation), diagnoses, amendments };
  }

  /** CON-F-06: what this patient was seen for before. */
  async history(tx: Tx, patientId: string, limit = 10) {
    const rows = await tx.consultation.findMany({
      where: { patientId, status: ConsultationStatus.SIGNED },
      orderBy: { signedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
      select: {
        id: true,
        signedAt: true,
        doctorId: true,
        chiefComplaint: true,
        planText: true,
        diagnoses: {
          where: { rank: DiagnosisRank.PRIMARY },
          select: { description: true, icd10Code: true },
          take: 1,
        },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      signedAt: row.signedAt?.toISOString() ?? null,
      doctorId: row.doctorId,
      chiefComplaint: row.chiefComplaint,
      // One line of the plan, which is what a side panel has room for.
      planSummary: row.planText ? row.planText.split('\n')[0]!.slice(0, 120) : null,
      primaryDiagnosis: row.diagnoses[0]?.description ?? null,
      icd10Code: row.diagnoses[0]?.icd10Code ?? null,
    }));
  }

  /** CON-F-17: what this doctor has left unsigned. */
  async myDrafts(tx: Tx, doctorId: string) {
    const rows = await tx.consultation.findMany({
      where: { doctorId, status: ConsultationStatus.DRAFT },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        encounterId: true,
        patientId: true,
        startedAt: true,
        lastAutosaveAt: true,
        chiefComplaint: true,
        patient: { select: { name: true, mrn: true } },
      },
    });
    const now = this.clock.now();
    return rows.map((row) => ({
      ...row,
      startedAt: row.startedAt.toISOString(),
      lastAutosaveAt: row.lastAutosaveAt?.toISOString() ?? null,
      hoursOpen: Math.floor((now.getTime() - row.startedAt.getTime()) / 3_600_000),
      stale: now.getTime() - row.startedAt.getTime() > STALE_DRAFT_HOURS * 3_600_000,
    }));
  }

  /** CON-F-17, CON-T-09: everybody's, for the administrator's dashboard. */
  async staleDrafts(tx: Tx) {
    const cutoff = new Date(this.clock.now().getTime() - STALE_DRAFT_HOURS * 3_600_000);
    return tx.consultation.findMany({
      where: { status: ConsultationStatus.DRAFT, startedAt: { lt: cutoff } },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        doctorId: true,
        startedAt: true,
        patient: { select: { name: true, mrn: true } },
        encounter: { select: { queueNo: true, status: true } },
      },
    });
  }

  // ------------------------------------------------------------- writing

  /** CON-F-01: the doctor starts writing. */
  async start(ctx: TenantContext, encounterId: string, options: { copyFromId?: string } = {}) {
    const tx = this.db.tx();
    const encounter = await this.encounters.getOrThrow(tx, encounterId);

    // CON-R-06: the patient has to actually be with the doctor.
    if (encounter.status !== EncounterStatus.IN_CONSULTATION) {
      throw new BadRequestError(
        `This visit is ${encounter.status.toLowerCase().replaceAll('_', ' ')}. ` +
          'Call the patient in before writing a consultation.',
        'not_in_consultation',
      );
    }

    const mine = await tx.consultation.findFirst({
      where: { encounterId, doctorId: ctx.userId, status: ConsultationStatus.DRAFT },
      select: { id: true },
    });
    if (mine) {
      throw new ConflictError(
        'You already have a draft open for this visit.',
        'draft_exists',
        { consultationId: mine.id },
      );
    }

    // The encounter row is locked while the sequence is worked out. Two
    // doctors opening the same visit at the same moment would otherwise
    // both read the same last sequence, both write the next one, and one
    // of them would meet a unique violation instead of a consultation.
    // The same reasoning as the queue number, and the same fix.
    await tx.$executeRawUnsafe(
      'SELECT id FROM encounter WHERE id = $1::uuid FOR UPDATE',
      encounterId,
    );

    const last = await tx.consultation.findFirst({
      where: { encounterId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    const id = newId();
    const now = this.clock.now();
    const copied = options.copyFromId
      ? await this.copyForward(tx, options.copyFromId, encounter.patientId)
      : null;

    await tx.consultation.create({
      data: {
        id,
        tenantId: requireTenantId(),
        encounterId,
        patientId: encounter.patientId,
        branchId: encounter.branchId,
        doctorId: ctx.userId,
        sequence: (last?.sequence ?? 0) + 1,
        status: ConsultationStatus.DRAFT,
        startedAt: now,
        ...copied,
        copiedFromId: copied ? options.copyFromId : null,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ConsultationCreated,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: encounter.patientId,
      after: { encounterId, copiedFrom: options.copyFromId ?? null },
    });
    this.events.publish({
      name: DomainEvent.ConsultationCreated,
      tenantId: ctx.tenantId,
      branchId: encounter.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { consultationId: id, encounterId, patientId: encounter.patientId },
    });

    return this.present(await this.getOrThrow(tx, id));
  }

  /**
   * CON-R-08: bringing forward the history sections of an earlier visit.
   *
   * Only the sections that describe the patient rather than today: the
   * history and the examination pattern. Never the complaint, the
   * assessment or the plan, because those are about a visit that is over,
   * and a stale plan copied forward is how the wrong treatment continues.
   */
  private async copyForward(tx: Tx, sourceId: string, patientId: string) {
    const source = await tx.consultation.findFirst({
      where: { id: sourceId, patientId, status: ConsultationStatus.SIGNED },
      select: { history: true, examination: true },
    });
    if (!source) {
      throw new NotFoundError('The consultation to copy from');
    }
    return {
      history: source.history,
      examination: source.examination,
    };
  }

  /** CON-F-12: autosave. Partial, frequent, and the last write wins. */
  async save(ctx: TenantContext, id: string, draft: ConsultationDraft) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, id);
    this.assertMayRead(ctx, before);
    this.assertOwner(ctx, before);
    this.assertDraft(before);

    const data: Record<string, unknown> = { lastAutosaveAt: this.clock.now() };
    for (const field of CLINICAL_FIELDS) {
      if (draft[field] !== undefined) data[field] = draft[field];
    }
    if (draft.followUpDue !== undefined) {
      data['followUpDue'] = draft.followUpDue ? new Date(draft.followUpDue) : null;
    }
    if (draft.followUpNote !== undefined) data['followUpNote'] = draft.followUpNote;

    await tx.consultation.update({ where: { id }, data });
    // Deliberately not audited. An autosave every five seconds for an hour
    // would bury the entries that matter under seven hundred that do not;
    // what is audited is the signing, which is the act with meaning.
    return this.present(await this.getOrThrow(tx, id));
  }

  /** CON-F-03: the whole set, replaced. */
  async setDiagnoses(ctx: TenantContext, id: string, inputs: DiagnosisInput[]) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);
    this.assertOwner(ctx, consultation);
    this.assertDraft(consultation);

    const primaries = inputs.filter((d) => (d.rank ?? DiagnosisRank.PRIMARY) === DiagnosisRank.PRIMARY);
    if (inputs.length > 0 && primaries.length !== 1) {
      throw new BadRequestError(
        primaries.length === 0
          ? 'One diagnosis has to be the main one.'
          : 'Only one diagnosis can be the main one; the rest are secondary.',
        'one_primary_required',
      );
    }

    for (const input of inputs) {
      const description = input.description.trim();
      if (description.length < 2 || description.length > 200) {
        throw new BadRequestError(
          'A diagnosis needs a description of between two and two hundred characters.',
          'invalid_diagnosis',
        );
      }
    }

    await tx.diagnosis.deleteMany({ where: { consultationId: id } });
    for (const input of inputs) {
      await tx.diagnosis.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          consultationId: id,
          patientId: consultation.patientId,
          rank: input.rank ?? DiagnosisRank.PRIMARY,
          description: input.description.trim(),
          icd10Code: input.icd10Code ?? null,
          icd10Label: input.icd10Label ?? null,
          certainty: input.certainty ?? DiagnosisCertainty.PROVISIONAL,
          isChronic: input.isChronic ?? false,
        },
      });
    }

    await tx.consultation.update({
      where: { id },
      data: { lastAutosaveAt: this.clock.now() },
    });
    return tx.diagnosis.findMany({
      where: { consultationId: id },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // ------------------------------------------------------------- signing

  /**
   * CON-F-14: the doctor's deliberate act.
   *
   * Everything about this step is designed to be defensible later: only the
   * owner may do it, the minimum content is checked, the time and the
   * address are recorded, the content is fingerprinted, and the triage it
   * was based on is locked at the same moment.
   */
  async sign(ctx: TenantContext, id: string, options: { confirm?: readonly string[] } = {}) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);

    // CON-R-03. An administrator may reassign a draft; nobody may sign
    // somebody else's clinical judgement.
    this.assertOwner(ctx, consultation);
    this.assertDraft(consultation);

    const diagnoses = await tx.diagnosis.findMany({ where: { consultationId: id } });
    const missing: string[] = [];
    if (!(consultation.chiefComplaint ?? '').trim()) missing.push('what brought the patient in');
    if (diagnoses.length === 0) missing.push('at least one diagnosis');
    if (missing.length > 0) {
      throw new InvariantViolationError(
        'sign_minimum_not_met',
        `This cannot be signed yet. It needs ${missing.join(' and ')}.`,
        { missing },
      );
    }

    const now = this.clock.now();
    const contentHash = hashContent(this.signable(consultation, diagnoses));

    await tx.consultation.update({
      where: { id },
      data: {
        status: ConsultationStatus.SIGNED,
        signedAt: now,
        signedBy: ctx.userId,
        signedIp: ctx.ip ?? null,
        contentHash,
      },
    });

    // TRI-F-10: the vitals this was based on stop being editable at the
    // same moment, because they are part of what was signed.
    const lockedTriage = await this.triage.lockForEncounter(tx, consultation.encounterId);

    // What else this signature makes real. RX activates the prescription
    // here, inside the same transaction, and may refuse the signature
    // outright if a severe allergy warning has not been confirmed.
    const contributed = await this.signHooks.run(tx, ctx, {
      id,
      encounterId: consultation.encounterId,
      patientId: consultation.patientId,
      branchId: consultation.branchId,
      doctorId: consultation.doctorId,
    }, { confirm: options.confirm ?? [] });

    // A diagnosis marked chronic offers itself to the patient's condition
    // list, which is what makes "active conditions" in the header true over
    // time rather than only for today.
    for (const diagnosis of diagnoses.filter((d) => d.isChronic)) {
      const already = await tx.patientCondition.findFirst({
        where: { patientId: consultation.patientId, condition: diagnosis.description },
        select: { id: true },
      });
      if (already) continue;
      await tx.patientCondition.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          patientId: consultation.patientId,
          condition: diagnosis.description,
          icd10Code: diagnosis.icd10Code,
          recordedBy: ctx.userId,
          recordedAt: now,
          notes: `Recorded at a consultation on ${now.toISOString().slice(0, 10)}`,
        },
      });
    }

    // BIL-F-02: the consultation fee. This module does not know what a
    // visit costs — the fee schedule does — so it says what happened
    // and billing prices it, inside this transaction.
    const encounterForFee = await tx.encounter.findFirst({
      where: { id: consultation.encounterId },
      select: { type: true },
    });
    await this.charges.record(tx, ctx, {
      encounterId: consultation.encounterId,
      branchId: consultation.branchId,
      patientId: consultation.patientId,
      lineType: 'CONSULTATION',
      sourceType: 'consultation',
      sourceId: id,
      description: 'Consultation',
      quantity: 1,
      unitPriceSen: null,
      encounterType: encounterForFee?.type ?? null,
      doctorId: consultation.doctorId,
      occurredAt: now,
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ConsultationSigned,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: consultation.patientId,
      after: {
        diagnoses: diagnoses.map((d) => d.description),
        contentHash,
        lockedTriageRecords: lockedTriage,
      },
    });

    // CON-R-07: the encounter decides where the patient goes next. This
    // module never writes an encounter status; it says what was ordered
    // and asks. Synchronous and in the same transaction, so the doctor's
    // screen can say where the patient has gone.
    const routed = await this.encounters.routeAfterConsultation(
      ctx,
      consultation.encounterId,
      contributed,
    );

    this.events.publish({
      name: DomainEvent.ConsultationSigned,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        consultationId: id,
        encounterId: consultation.encounterId,
        patientId: consultation.patientId,
        hasRx: contributed.hasRx,
        hasProcedures: contributed.hasProcedures,
        routedTo: routed.status,
        followUpDue: consultation.followUpDue?.toISOString().slice(0, 10) ?? null,
      },
    });

    return { ...this.present(await this.getOrThrow(tx, id)), routedTo: routed.status };
  }

  /** CON-F-18: abandoned, not deleted. */
  async cancel(ctx: TenantContext, id: string, reason: string) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);
    this.assertOwner(ctx, consultation);
    this.assertDraft(consultation);
    if (reason.trim().length < 3) {
      throw new BadRequestError('Say why this draft is being abandoned.', 'reason_required');
    }

    await tx.consultation.update({
      where: { id },
      data: {
        status: ConsultationStatus.CANCELLED,
        cancelledAt: this.clock.now(),
        cancelReason: reason.trim(),
      },
    });

    // Whatever this consultation ordered is abandoned with it. The
    // pharmacy must not be left holding an order for a visit that did
    // not happen.
    await this.charges.remove(tx, ctx, { sourceType: 'consultation', sourceId: id });

    await this.signHooks.runCancel(
      tx,
      ctx,
      {
        id,
        encounterId: consultation.encounterId,
        patientId: consultation.patientId,
        branchId: consultation.branchId,
        doctorId: consultation.doctorId,
      },
      reason.trim(),
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ConsultationCancelled,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: consultation.patientId,
      reason,
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  /**
   * CON-F-15, CON-F-16: the only way a signed record changes.
   *
   * An addendum adds something that was left out. A correction supersedes
   * one field, and the original stays exactly where it was — struck through
   * on screen, not overwritten. Both carry a reason, because the reason is
   * what makes the trail worth reading.
   */
  async amend(
    ctx: TenantContext,
    id: string,
    input: { type: AmendmentType; field?: ClinicalField; current: string; reason: string },
  ) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);
    if (consultation.status !== ConsultationStatus.SIGNED) {
      throw new BadRequestError(
        'This consultation has not been signed, so it can simply be edited.',
        'not_signed',
      );
    }
    // CON-R-04: ten characters, because "typo" explains nothing to whoever
    // reads this in two years.
    if (input.reason.trim().length < 10) {
      throw new BadRequestError(
        'Say what is being changed and why, in a sentence. This is read by somebody else later.',
        'reason_too_short',
      );
    }
    if (input.type === AmendmentType.CORRECTION && !input.field) {
      throw new BadRequestError(
        'A correction has to say which section it replaces.',
        'field_required',
      );
    }
    if (input.field && !CLINICAL_FIELDS.includes(input.field)) {
      throw new BadRequestError(
        `"${input.field}" is not a section of a consultation.`,
        'unknown_field',
      );
    }

    const amendmentId = newId();
    const now = this.clock.now();
    await tx.consultationAmendment.create({
      data: {
        id: amendmentId,
        tenantId: requireTenantId(),
        consultationId: id,
        type: input.type,
        field: input.field ?? null,
        previous:
          input.field === undefined
            ? undefined
            : ({ [input.field]: consultation[input.field] } as unknown as object),
        current: { text: input.current.trim() } as unknown as object,
        reason: input.reason.trim(),
        amendedBy: ctx.userId,
        amendedAt: now,
        amendedIp: ctx.ip ?? null,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ConsultationAmended,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: consultation.patientId,
      before: input.field ? { [input.field]: consultation[input.field] } : null,
      after: { type: input.type, field: input.field ?? null, current: input.current },
      reason: input.reason,
    });
    this.events.publish({
      name: DomainEvent.ConsultationAmended,
      tenantId: ctx.tenantId,
      branchId: consultation.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { consultationId: id, amendmentId, type: input.type },
    });

    return this.read(ctx, id);
  }

  /**
   * §14: a locum leaves with unsigned drafts.
   *
   * An administrator hands the draft to a doctor who can review and sign
   * it. Both names stay on the record, because the person who wrote it and
   * the person who signed it are different facts.
   */
  async reassign(ctx: TenantContext, id: string, toDoctorId: string, reason: string) {
    const tx = this.db.tx();
    const consultation = await this.getOrThrow(tx, id);
    this.assertDraft(consultation);
    if (reason.trim().length < 3) {
      throw new BadRequestError('Say why this draft is changing hands.', 'reason_required');
    }

    const doctor = await tx.userBranchRole.findFirst({
      where: { userId: toDoctorId, branchId: consultation.branchId, role: Role.DOCTOR },
      select: { id: true },
    });
    if (!doctor) {
      throw new BadRequestError(
        'That person is not a doctor at this branch.',
        'not_a_doctor_here',
      );
    }

    await tx.consultation.update({ where: { id }, data: { doctorId: toDoctorId } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ConsultationReassigned,
      entityType: 'consultation',
      entityId: id,
      subjectPatientId: consultation.patientId,
      before: { doctorId: consultation.doctorId },
      after: { doctorId: toDoctorId },
      reason,
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  // ----------------------------------------------------------- integrity

  private signable(
    consultation: Awaited<ReturnType<ConsultationService['getOrThrow']>>,
    diagnoses: Array<{ rank: string; description: string; icd10Code: string | null; certainty: string }>,
  ): SignableContent {
    return {
      chiefComplaint: consultation.chiefComplaint,
      hpi: consultation.hpi,
      history: consultation.history,
      examination: consultation.examination,
      planText: consultation.planText,
      followUpDue: consultation.followUpDue?.toISOString().slice(0, 10) ?? null,
      followUpNote: consultation.followUpNote,
      diagnoses: diagnoses.map((d) => ({
        rank: d.rank,
        description: d.description,
        icd10Code: d.icd10Code,
        certainty: d.certainty,
      })),
    };
  }

  /**
   * CON-N-04: recompute every signed record's fingerprint and report any
   * that no longer matches.
   *
   * The trigger stops a change through the ordinary path. This is what
   * notices one that got around it: a superuser, a restore from a doctored
   * backup, a migration that meant well, a failing disk.
   */
  async verifyIntegrity(tx: Tx, limit = 5000) {
    const rows = await tx.consultation.findMany({
      where: { status: ConsultationStatus.SIGNED, contentHash: { not: null } },
      orderBy: { signedAt: 'desc' },
      take: limit,
      select: { ...SELECT, diagnoses: true },
    });

    const mismatched: Array<{ id: string; signedAt: string | null; expected: string; found: string }> = [];
    for (const row of rows) {
      const expected = hashContent(this.signable(row, row.diagnoses));
      if (expected !== row.contentHash) {
        mismatched.push({
          id: row.id,
          signedAt: row.signedAt?.toISOString() ?? null,
          expected,
          found: row.contentHash!,
        });
      }
    }

    if (mismatched.length > 0) {
      // Loud, and not swallowed. A signed clinical record that no longer
      // matches what was signed is the most serious thing this system can
      // discover about itself.
      this.logger.error(
        `INTEGRITY: ${mismatched.length} signed consultation(s) no longer match what was signed: ` +
          mismatched.map((m) => m.id).join(', '),
      );
    }

    return { checked: rows.length, mismatched };
  }

  present(row: Awaited<ReturnType<ConsultationService['getOrThrow']>>) {
    return {
      ...row,
      followUpDue: row.followUpDue?.toISOString().slice(0, 10) ?? null,
      startedAt: row.startedAt.toISOString(),
      lastAutosaveAt: row.lastAutosaveAt?.toISOString() ?? null,
      signedAt: row.signedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      editable: row.status === ConsultationStatus.DRAFT,
    };
  }
}
