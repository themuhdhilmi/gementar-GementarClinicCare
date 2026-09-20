import { Injectable } from '@nestjs/common';
import {
  Gender,
  IdType,
  PatientStatus,
  type BloodGroup,
  type MaritalStatus,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
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
import { MrnService } from './mrn.service.js';
import {
  displayIdNumber,
  lastFour,
  maskIdNumber,
  normaliseIdentity,
} from './identity.js';
import {
  assertDateOfBirth,
  assertName,
  assertPostcode,
  describeAge,
  displayPhone,
  normaliseEmail,
  normalisePhone,
} from './patient.validation.js';

export type PatientInput = {
  name: string;
  idType: IdType;
  idNumber?: string | null;
  passportCountry?: string | null;
  passportExpiry?: string | null;
  dateOfBirth?: string | null;
  dobEstimated?: boolean;
  gender: Gender;
  nationality?: string | null;
  race?: string | null;
  religion?: string | null;
  maritalStatus?: MaritalStatus | null;
  occupation?: string | null;
  preferredLanguage?: string | null;
  phone?: string | null;
  phoneAlt?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postcode?: string | null;
  city?: string | null;
  state?: string | null;
  bloodGroup?: BloodGroup | null;
  notes?: string | null;
};

export type DuplicateCandidate = {
  id: string;
  mrn: string;
  name: string;
  idNumberMasked: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  /** Why this looked like the same person, in words a receptionist can act on. */
  reason: string;
  /** An exact document match is a block; the rest are a prompt to look. */
  certain: boolean;
};

const SELECT = {
  id: true,
  mrn: true,
  name: true,
  idType: true,
  idNumber: true,
  passportCountry: true,
  passportExpiry: true,
  dateOfBirth: true,
  dobEstimated: true,
  gender: true,
  nationality: true,
  race: true,
  religion: true,
  maritalStatus: true,
  occupation: true,
  preferredLanguage: true,
  phone: true,
  phoneAlt: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  postcode: true,
  city: true,
  state: true,
  country: true,
  bloodGroup: true,
  nkdaRecorded: true,
  nkdaRecordedAt: true,
  notes: true,
  status: true,
  mergedIntoId: true,
  deceasedAt: true,
  lastVisitAt: true,
  source: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The patient registry.
 *
 * One person, one record, across every branch of the clinic company. The
 * record is the master data every clinical module hangs off, so two things
 * here matter more than the rest: that a duplicate is hard to create, and
 * that the identity number is hard to see by accident.
 */
@Injectable()
export class PatientService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly mrn: MrnService,
  ) {}

  // ------------------------------------------------------------- reading

  async getOrThrow(tx: Tx, patientId: string) {
    const patient = await tx.patient.findFirst({ where: { id: patientId }, select: SELECT });
    if (!patient) throw new NotFoundError('Patient');
    return patient;
  }

  /**
   * PAT-R-05: the identity number leaves here masked unless the caller both
   * holds `patient.unmask_id` and asked for it, and asking is audited.
   */
  async read(ctx: TenantContext, patientId: string, unmask: boolean) {
    const tx = this.db.tx();
    const patient = await this.getOrThrow(tx, patientId);

    if (unmask) {
      if (!ctx.permissions.has('patient.unmask_id')) {
        throw new BadRequestError(
          'You do not have permission to see the full identity number.',
          'unmask_not_permitted',
        );
      }
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.PatientIdUnmasked,
        entityType: 'patient',
        entityId: patientId,
        subjectPatientId: patientId,
      });
    }

    return this.present(patient, unmask);
  }

  /** The shape every screen receives. The raw row never leaves this service. */
  present(patient: Awaited<ReturnType<PatientService['getOrThrow']>>, unmask = false) {
    const now = this.clock.now();
    return {
      ...patient,
      dateOfBirth: patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : null,
      passportExpiry: patient.passportExpiry
        ? patient.passportExpiry.toISOString().slice(0, 10)
        : null,
      deceasedAt: patient.deceasedAt ? patient.deceasedAt.toISOString().slice(0, 10) : null,
      age: describeAge(patient.dateOfBirth, now),
      phoneDisplay: displayPhone(patient.phone),
      idNumber: unmask
        ? displayIdNumber(patient.idType, patient.idNumber)
        : maskIdNumber(patient.idType, patient.idNumber),
      idNumberMasked: maskIdNumber(patient.idType, patient.idNumber),
      unmasked: unmask,
    };
  }

  // -------------------------------------------------------- duplicates

  /**
   * PAT-F-04: has this person been registered already?
   *
   * Two different questions with two different answers. An exact match on an
   * identity document is the same human being and registration stops. A
   * match on name and date of birth, or on a telephone number, is a prompt
   * to look, because families share numbers and Malaysians share names.
   */
  async findDuplicates(
    input: Pick<PatientInput, 'name' | 'idType' | 'idNumber' | 'passportCountry' | 'dateOfBirth' | 'phone'>,
    excludeId?: string,
  ): Promise<DuplicateCandidate[]> {
    const tx = this.db.tx();
    const found = new Map<string, DuplicateCandidate>();

    const add = (row: Record<string, unknown>, reason: string, certain: boolean) => {
      const id = row['id'] as string;
      if (id === excludeId) return;
      const existing = found.get(id);
      if (existing && (existing.certain || !certain)) return;
      const dob = row['dateOfBirth'] as Date | null;
      found.set(id, {
        id,
        mrn: row['mrn'] as string,
        name: row['name'] as string,
        idNumberMasked: maskIdNumber(row['idType'] as IdType, row['idNumber'] as string | null),
        dateOfBirth: dob ? dob.toISOString().slice(0, 10) : null,
        phone: row['phone'] as string | null,
        reason,
        certain,
      });
    };

    const alive = { in: [PatientStatus.ACTIVE, PatientStatus.DECEASED] };
    const columns = {
      id: true,
      mrn: true,
      name: true,
      idType: true,
      idNumber: true,
      dateOfBirth: true,
      phone: true,
    } as const;

    // The certain one: the same document.
    if (input.idType !== IdType.NONE && input.idNumber) {
      const identity = normaliseIdentity(input.idType, input.idNumber, {
        passportCountry: input.passportCountry,
      });
      const exact = await tx.patient.findMany({
        where: {
          idType: input.idType,
          idNumber: identity.idNumber,
          status: alive,
          ...(input.idType === IdType.PASSPORT
            ? { passportCountry: input.passportCountry?.toUpperCase() }
            : {}),
        },
        select: columns,
        take: 5,
      });
      for (const row of exact) {
        add(row, 'The same identity number is already registered.', true);
      }
    }

    // Name and date of birth together. Either alone is far too common.
    //
    // The date is taken off the identity card when it was not typed, which
    // is the ordinary case: registering from a MyKad fills the date in
    // rather than asking for it, so a check that only looked at what was
    // typed would never fire on the commonest path of all.
    let dob = assertDateOfBirth(input.dateOfBirth ?? null, this.clock.now());
    if (!dob && input.idType && input.idNumber) {
      try {
        dob = normaliseIdentity(input.idType, input.idNumber, {
          passportCountry: input.passportCountry,
          now: this.clock.now(),
        }).dateOfBirth ?? null;
      } catch {
        // An unreadable number is the registration's problem to report, not
        // the duplicate check's.
        dob = null;
      }
    }
    if (dob) {
      const sameDay = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT id, mrn, name, id_type AS "idType", id_number AS "idNumber",
                date_of_birth AS "dateOfBirth", phone
           FROM patient
          WHERE tenant_id = $1::uuid
            AND status IN ('ACTIVE', 'DECEASED')
            AND date_of_birth = $2::date
            AND similarity(name_normalised, patient_normalise_name($3)) > 0.4
          LIMIT 5`,
        requireTenantId(),
        dob.toISOString().slice(0, 10),
        input.name,
      );
      for (const row of sameDay) {
        add(row, 'Same date of birth and a very similar name.', false);
      }
    }

    // A telephone number on its own. A whole family shares one, so this is
    // the weakest signal and is never a block.
    const phone = normalisePhone(input.phone);
    if (phone) {
      const samePhone = await tx.patient.findMany({
        where: { phone, status: alive },
        select: columns,
        take: 5,
      });
      for (const row of samePhone) {
        add(row, 'The same telephone number, which may just be the same household.', false);
      }
    }

    return [...found.values()].sort((a, b) => Number(b.certain) - Number(a.certain));
  }

  // ------------------------------------------------------------ writing

  /**
   * PAT-F-01: register someone.
   *
   * Refuses with 409 and the existing record when the identity document is
   * already on file, unless the caller has looked at the candidates and said
   * to go ahead. `force` skips the soft signals only: the same document is
   * always the same person and is refused whatever anybody clicks.
   */
  async register(ctx: TenantContext, input: PatientInput, force = false) {
    const tx = this.db.tx();
    const now = this.clock.now();

    const name = assertName(input.name);
    const identity = normaliseIdentity(input.idType, input.idNumber, {
      passportCountry: input.passportCountry,
      now,
    });

    let dateOfBirth = assertDateOfBirth(input.dateOfBirth ?? null, now);
    let gender = input.gender;
    if (identity.dateOfBirth && !dateOfBirth) dateOfBirth = identity.dateOfBirth;
    if (identity.gender && !gender) gender = identity.gender;

    // PAT-F-05: someone with no document needs a note saying who they are,
    // or the record is unidentifiable and will be duplicated next week.
    if (input.idType === IdType.NONE && !(input.notes ?? '').trim()) {
      throw new BadRequestError(
        'A patient with no identity document needs a note saying who they are, for example ' +
          'the mother’s name and telephone number for a newborn.',
        'note_required',
      );
    }
    if (!dateOfBirth && input.idType !== IdType.NONE) {
      throw new BadRequestError(
        'A date of birth is needed. If it is not known, record the patient as having no ' +
          'identity document and give an estimate.',
        'dob_required',
      );
    }

    const candidates = await this.findDuplicates(input);
    const certain = candidates.filter((c) => c.certain);
    if (certain.length > 0) {
      throw new ConflictError(
        `${certain[0]!.name} is already registered as ${certain[0]!.mrn} with that identity number.`,
        'patient_exists',
        { duplicates: certain },
      );
    }
    if (candidates.length > 0 && !force) {
      throw new ConflictError(
        'Someone very similar is already registered. Check the list before registering again.',
        'possible_duplicate',
        { duplicates: candidates },
      );
    }

    const id = newId();
    const mrn = await this.mrn.next();
    await tx.patient.create({
      data: {
        id,
        tenantId: requireTenantId(),
        mrn,
        name,
        idType: input.idType,
        idNumber: identity.idNumber === '' ? null : identity.idNumber,
        idNumberLast4: identity.idNumber === '' ? null : lastFour(identity.idNumber),
        passportCountry: input.passportCountry?.toUpperCase() ?? null,
        passportExpiry: input.passportExpiry ? new Date(input.passportExpiry) : null,
        dateOfBirth,
        dobEstimated: input.dobEstimated ?? false,
        gender: gender ?? Gender.UNKNOWN,
        nationality: (input.nationality ?? 'MY').toUpperCase(),
        race: input.race ?? null,
        religion: input.religion ?? null,
        maritalStatus: input.maritalStatus ?? null,
        occupation: input.occupation ?? null,
        preferredLanguage: input.preferredLanguage ?? null,
        phone: normalisePhone(input.phone),
        phoneAlt: normalisePhone(input.phoneAlt),
        email: normaliseEmail(input.email),
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        postcode: assertPostcode(input.postcode),
        city: input.city ?? null,
        state: input.state ?? null,
        bloodGroup: input.bloodGroup ?? null,
        notes: input.notes ?? null,
        status: PatientStatus.ACTIVE,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });

    const created = await this.getOrThrow(tx, id);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientRegistered,
      entityType: 'patient',
      entityId: id,
      subjectPatientId: id,
      // The identity number is deliberately not in the audit payload: the
      // trail is read on a dashboard and PAT-N-06 applies there too.
      after: { mrn, name, idType: input.idType, gender: created.gender },
    });
    this.events.publish({
      name: DomainEvent.PatientRegistered,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId: id, mrn },
    });

    return { patient: this.present(created), warnings: identity.warnings };
  }

  /** PAT-F-07: demographics. The patient number and the status do not move. */
  async update(ctx: TenantContext, patientId: string, input: Partial<PatientInput>, reason?: string) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const before = await this.getOrThrow(tx, patientId);

    const data: Record<string, unknown> = { updatedBy: ctx.userId };
    if (input.name !== undefined) data['name'] = assertName(input.name);

    // Changing the identity document is a real event, not a typo fix, so it
    // carries a reason into the audit trail (PAT §14: MyKid becomes MyKad).
    if (input.idType !== undefined || input.idNumber !== undefined) {
      const idType = input.idType ?? before.idType;
      const identity = normaliseIdentity(idType, input.idNumber ?? before.idNumber, {
        passportCountry: input.passportCountry ?? before.passportCountry,
        now,
      });
      if (identity.idNumber !== before.idNumber || idType !== before.idType) {
        if (!(reason ?? '').trim()) {
          throw new BadRequestError(
            'Changing an identity number needs a reason, because the old one stays in the record.',
            'reason_required',
          );
        }
        const clash = await this.findDuplicates(
          { name: before.name, idType, idNumber: identity.idNumber, passportCountry: input.passportCountry },
          patientId,
        );
        const certain = clash.filter((c) => c.certain);
        if (certain.length > 0) {
          throw new ConflictError(
            `${certain[0]!.name} already holds that identity number.`,
            'patient_exists',
            { duplicates: certain },
          );
        }
      }
      data['idType'] = idType;
      data['idNumber'] = identity.idNumber === '' ? null : identity.idNumber;
      data['idNumberLast4'] = identity.idNumber === '' ? null : lastFour(identity.idNumber);
    }

    if (input.passportCountry !== undefined) {
      data['passportCountry'] = input.passportCountry?.toUpperCase() ?? null;
    }
    if (input.passportExpiry !== undefined) {
      data['passportExpiry'] = input.passportExpiry ? new Date(input.passportExpiry) : null;
    }
    if (input.dateOfBirth !== undefined) {
      data['dateOfBirth'] = assertDateOfBirth(input.dateOfBirth, now);
    }
    if (input.dobEstimated !== undefined) data['dobEstimated'] = input.dobEstimated;
    if (input.gender !== undefined) data['gender'] = input.gender;
    if (input.nationality !== undefined) {
      data['nationality'] = (input.nationality ?? 'MY').toUpperCase();
    }
    for (const key of ['race', 'religion', 'maritalStatus', 'occupation', 'preferredLanguage', 'addressLine1', 'addressLine2', 'city', 'state', 'bloodGroup', 'notes'] as const) {
      if (input[key] !== undefined) data[key] = input[key] ?? null;
    }
    if (input.phone !== undefined) data['phone'] = normalisePhone(input.phone);
    if (input.phoneAlt !== undefined) data['phoneAlt'] = normalisePhone(input.phoneAlt);
    if (input.email !== undefined) data['email'] = normaliseEmail(input.email);
    if (input.postcode !== undefined) data['postcode'] = assertPostcode(input.postcode);

    await tx.patient.update({ where: { id: patientId }, data });
    const after = await this.getOrThrow(tx, patientId);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientUpdated,
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      before: this.forAudit(before),
      after: this.forAudit(after),
      reason: reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.PatientUpdated,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId },
    });

    return this.present(after);
  }

  /**
   * PAT-F-25: a patient is never removed, only hidden from search.
   *
   * Their name has to keep appearing on the invoices and encounters that
   * already reference them, so the row stays and the searches exclude it.
   */
  async softDelete(ctx: TenantContext, patientId: string, reason: string) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, patientId);
    if (!reason.trim()) {
      throw new BadRequestError('Deleting a patient record needs a reason.', 'reason_required');
    }
    if (before.status === PatientStatus.MERGED) {
      throw new BadRequestError(
        'This record has already been merged into another one.',
        'patient_merged',
      );
    }

    await tx.patient.update({
      where: { id: patientId },
      data: {
        status: PatientStatus.DELETED,
        deletedAt: this.clock.now(),
        deletedReason: reason.trim(),
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientDeleted,
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      before: { status: before.status },
      after: { status: PatientStatus.DELETED },
      reason,
    });
    this.events.publish({
      name: DomainEvent.PatientDeleted,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { patientId },
    });

    return this.present(await this.getOrThrow(tx, patientId));
  }

  /** What goes in the trail: everything except the identity number. */
  private forAudit(patient: Record<string, unknown>) {
    const { idNumber, ...rest } = patient;
    void idNumber;
    return rest;
  }
}
