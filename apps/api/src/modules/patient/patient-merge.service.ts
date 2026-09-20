import { Injectable } from '@nestjs/common';
import { PatientStatus } from '../../generated/prisma/enums.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PatientService } from './patient.service.js';

/**
 * Every table that points at a patient, and therefore everything a merge has
 * to move. A module that adds one and forgets to add it here leaves rows
 * pointing at a record the clinic believes no longer exists, so the list is
 * checked against the live schema by a test rather than trusted.
 */
export const PATIENT_REFERENCING_TABLES = [
  'patient_contact',
  'patient_consent',
  'patient_allergy',
  'patient_condition',
  'patient_document',
] as const;

export type MergeManifest = {
  loserId: string;
  loserMrn: string;
  mergedAt: string;
  mergedBy: string;
  /** How many rows each table gave up, so an unmerge can check its work. */
  moved: Record<string, number>;
  /** The loser's own fields, so unmerging restores the record as it was. */
  loser: Record<string, unknown>;
  /**
   * Consent rows the survivor already had an answer for, so the loser's were
   * dropped rather than moved. Kept whole so an unmerge can recreate them.
   */
  droppedConsents: Array<Record<string, unknown>>;
  /** Which record survived, so an unmerge knows where to take things from. */
  survivorId: string;
  /**
   * Fields the merge copied into the survivor because the survivor had
   * nothing there, with the empty values they had before. An unmerge has to
   * put these back, or the survivor keeps an identity number that belongs to
   * the record being separated out, and the unique index refuses it.
   */
  filledOnSurvivor: Record<string, unknown>;
};

/** PAT-F-26: how long a merge can be taken back through the application. */
export const UNMERGE_WINDOW_DAYS = 30;

/**
 * Merging two records of the same person.
 *
 * The clinic will need this in the first month, because reception registers
 * a patient who is already on file roughly as often as the duplicate check
 * fails to notice, and the duplicate check cannot notice a misspelled name
 * with no identity document.
 *
 * It is written to be reversible. Not because reversal is common, but
 * because the alternative is a receptionist who is afraid of the button, and
 * duplicate records that nobody ever cleans up.
 */
@Injectable()
export class PatientMergeService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly patients: PatientService,
  ) {}

  /**
   * Everything the loser holds moves to the survivor, in one transaction.
   *
   * The survivor's own demographics win, because whoever is merging picked
   * it as the better record. Fields the survivor has left empty are filled
   * from the loser rather than thrown away.
   */
  async merge(ctx: TenantContext, survivorId: string, loserId: string) {
    if (survivorId === loserId) {
      throw new BadRequestError('A record cannot be merged into itself.', 'same_patient');
    }

    const tx = this.db.tx();
    const survivor = await this.patients.getOrThrow(tx, survivorId);
    const loser = await this.patients.getOrThrow(tx, loserId);

    for (const [record, label] of [
      [survivor, 'survivor'],
      [loser, 'record being merged'],
    ] as const) {
      if (record.status === PatientStatus.MERGED) {
        throw new BadRequestError(
          `The ${label} has already been merged into another record.`,
          'already_merged',
        );
      }
      if (record.status === PatientStatus.DELETED) {
        throw new BadRequestError(`The ${label} has been deleted.`, 'patient_deleted');
      }
    }

    const now = this.clock.now();

    // Consent is unique per (patient, channel, purpose), so the loser's
    // answers cannot simply be moved: where both records answered the same
    // question, the move would violate the constraint. The survivor's answer
    // wins, because whoever is merging chose that record. The loser's
    // colliding rows are kept in the manifest and deleted, so an unmerge can
    // put them back exactly.
    const collidingConsents = await tx.patientConsent.findMany({
      where: {
        patientId: loserId,
        OR: (
          await tx.patientConsent.findMany({
            where: { patientId: survivorId },
            select: { channel: true, purpose: true },
          })
        ).map((c) => ({ channel: c.channel, purpose: c.purpose })),
      },
    });
    if (collidingConsents.length > 0) {
      await tx.patientConsent.deleteMany({
        where: { id: { in: collidingConsents.map((c) => c.id) } },
      });
    }

    const moved: Record<string, number> = {};
    for (const table of PATIENT_REFERENCING_TABLES) {
      const result = await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET patient_id = $1::uuid
          WHERE patient_id = $2::uuid AND tenant_id = $3::uuid`,
        survivorId,
        loserId,
        ctx.tenantId,
      );
      moved[table] = Number(result);
    }

    // Fill the survivor's empty fields from the loser: a record with a
    // telephone number and one with an address should merge into a record
    // with both.
    const fillable = [
      'phone', 'phoneAlt', 'email', 'addressLine1', 'addressLine2', 'postcode',
      'city', 'state', 'occupation', 'race', 'religion', 'maritalStatus',
      'bloodGroup', 'preferredLanguage', 'dateOfBirth', 'notes',
    ] as const;
    const filled: Record<string, unknown> = {};
    const filledOnSurvivor: Record<string, unknown> = {};
    for (const key of fillable) {
      const mine = (survivor as Record<string, unknown>)[key];
      const theirs = (loser as Record<string, unknown>)[key];
      if ((mine === null || mine === undefined || mine === '') && theirs) {
        filled[key] = theirs;
        filledOnSurvivor[key] = mine ?? null;
      }
    }

    // If the survivor has no identity document and the loser does, take it.
    if (!survivor.idNumber && loser.idNumber) {
      filled['idType'] = loser.idType;
      filled['idNumber'] = loser.idNumber;
      filled['idNumberLast4'] = loser.idNumber.slice(-4);
      filled['passportCountry'] = loser.passportCountry;
      filledOnSurvivor['idType'] = survivor.idType;
      filledOnSurvivor['idNumber'] = null;
      filledOnSurvivor['idNumberLast4'] = null;
      filledOnSurvivor['passportCountry'] = survivor.passportCountry;
    }

    const manifest: MergeManifest = {
      loserId,
      loserMrn: loser.mrn,
      mergedAt: now.toISOString(),
      mergedBy: ctx.userId,
      moved,
      loser: { ...loser, dateOfBirth: loser.dateOfBirth?.toISOString() ?? null },
      droppedConsents: collidingConsents.map((c) => ({
        ...c,
        recordedAt: c.recordedAt.toISOString(),
      })),
      survivorId,
      filledOnSurvivor,
    };

    // The loser's identity number has to be cleared, or the partial unique
    // index keeps it reserved and the survivor cannot hold it.
    await tx.patient.update({
      where: { id: loserId },
      data: {
        status: PatientStatus.MERGED,
        mergedIntoId: survivorId,
        mergedAt: now,
        mergeManifest: manifest as unknown as object,
        idNumber: null,
        idNumberLast4: null,
        updatedBy: ctx.userId,
      },
    });

    if (Object.keys(filled).length > 0) {
      await tx.patient.update({
        where: { id: survivorId },
        data: { ...filled, updatedBy: ctx.userId },
      });
    }

    const after = await this.patients.getOrThrow(tx, survivorId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientMerged,
      entityType: 'patient',
      entityId: survivorId,
      subjectPatientId: survivorId,
      before: { survivor: survivor.mrn, loser: loser.mrn },
      after: { survivor: after.mrn, moved },
      reason: `Merged ${loser.mrn} into ${survivor.mrn}`,
    });
    // A second entry against the loser, so opening that record's history
    // explains where it went rather than showing nothing.
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientMerged,
      entityType: 'patient',
      entityId: loserId,
      subjectPatientId: loserId,
      after: { mergedInto: survivor.mrn },
    });

    this.events.publish({
      name: DomainEvent.PatientMerged,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { survivorId, loserId, moved },
    });

    return { patient: this.patients.present(after), moved };
  }

  /**
   * PAT-F-26: puts a merge back, from the manifest it wrote.
   *
   * Only what the merge moved comes back. Anything recorded against the
   * survivor since then stays with the survivor, because it was recorded
   * about the merged patient and moving it would be a guess.
   */
  async unmerge(ctx: TenantContext, loserId: string) {
    const tx = this.db.tx();
    const loser = await tx.patient.findFirst({
      where: { id: loserId },
      select: { id: true, mrn: true, status: true, mergedIntoId: true, mergedAt: true, mergeManifest: true },
    });
    if (!loser) throw new NotFoundError('Patient');
    if (loser.status !== PatientStatus.MERGED || !loser.mergeManifest || !loser.mergedIntoId) {
      throw new BadRequestError('This record has not been merged.', 'not_merged');
    }

    const mergedAt = loser.mergedAt ?? new Date(0);
    const ageDays = (this.clock.now().getTime() - mergedAt.getTime()) / (24 * 3600 * 1000);
    if (ageDays > UNMERGE_WINDOW_DAYS) {
      throw new BadRequestError(
        `This merge is ${Math.floor(ageDays)} days old and can no longer be undone here. ` +
          `The window is ${UNMERGE_WINDOW_DAYS} days, after which too much may have been ` +
          'recorded against the surviving record to separate safely.',
        'unmerge_window_passed',
      );
    }

    const manifest = loser.mergeManifest as unknown as MergeManifest;
    const survivorId = loser.mergedIntoId;

    // Only rows the merge actually moved come back, identified by having
    // been created before the merge. Anything newer belongs to the survivor.
    const restored: Record<string, number> = {};
    for (const table of PATIENT_REFERENCING_TABLES) {
      if (!manifest.moved[table]) continue;
      const column = table === 'patient_consent' ? 'recorded_at' : table === 'patient_document' ? 'uploaded_at' : table === 'patient_contact' ? 'created_at' : 'recorded_at';
      const result = await tx.$executeRawUnsafe(
        `UPDATE "${table}" SET patient_id = $1::uuid
          WHERE patient_id = $2::uuid AND tenant_id = $3::uuid AND ${column} < $4::timestamptz
          `,
        loserId,
        survivorId,
        ctx.tenantId,
        mergedAt.toISOString(),
      );
      restored[table] = Number(result);
    }

    // The survivor gives back what it borrowed, and it has to happen before
    // the loser takes its identity number back: the unique index on active
    // identity documents is checked per statement, so for one moment both
    // records cannot hold the same number.
    if (Object.keys(manifest.filledOnSurvivor ?? {}).length > 0) {
      await tx.patient.update({
        where: { id: survivorId },
        data: { ...manifest.filledOnSurvivor, updatedBy: ctx.userId } as never,
      });
    }

    // Consents the merge dropped rather than moved, put back as they were.
    for (const consent of manifest.droppedConsents ?? []) {
      await tx.patientConsent.create({
        data: {
          id: consent['id'] as string,
          tenantId: ctx.tenantId,
          patientId: loserId,
          channel: consent['channel'] as never,
          purpose: consent['purpose'] as never,
          granted: consent['granted'] as boolean,
          recordedBy: (consent['recordedBy'] as string | null) ?? null,
          recordedAt: new Date(consent['recordedAt'] as string),
          source: (consent['source'] as string | null) ?? null,
        },
      });
    }

    await tx.patient.update({
      where: { id: loserId },
      data: {
        status: PatientStatus.ACTIVE,
        mergedIntoId: null,
        mergedAt: null,
        mergeManifest: undefined,
        idType: manifest.loser['idType'] as never,
        idNumber: (manifest.loser['idNumber'] as string | null) ?? null,
        idNumberLast4: (manifest.loser['idNumber'] as string | null)?.slice(-4) ?? null,
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientUnmerged,
      entityType: 'patient',
      entityId: loserId,
      subjectPatientId: loserId,
      before: { status: PatientStatus.MERGED, mergedInto: survivorId },
      after: { status: PatientStatus.ACTIVE, restored },
    });

    return { patient: this.patients.present(await this.patients.getOrThrow(tx, loserId)), restored };
  }
}
