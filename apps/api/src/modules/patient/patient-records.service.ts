import { Inject, Injectable } from '@nestjs/common';
import {
  PatientDocumentType,
  type ConsentChannel,
  type ConsentPurpose,
} from '../../generated/prisma/enums.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { StorageService } from '../../shared/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PatientService } from './patient.service.js';
import { assertName, normalisePhone } from './patient.validation.js';

export type ContactInput = {
  name: string;
  relationship?: string | null;
  phone: string;
  isPrimary?: boolean;
};

export type ConsentInput = {
  channel: ConsentChannel;
  purpose: ConsentPurpose;
  granted: boolean;
};

/** PAT-F-23: what may be attached, and what it is served back as. */
const ALLOWED_UPLOADS = new Map<string, { extension: string; magic: (b: Buffer) => boolean }>([
  [
    'application/pdf',
    { extension: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  ],
  [
    'image/png',
    {
      extension: 'png',
      magic: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    },
  ],
  [
    'image/jpeg',
    { extension: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ],
]);

/**
 * The things hanging off a patient that are neither demographics nor clinical
 * facts: who to telephone in an emergency, what the patient agreed to be
 * contacted about, and the scanned paper.
 */
@Injectable()
export class PatientRecordsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly patients: PatientService,
    private readonly storage: StorageService,
  ) {}

  // -------------------------------------------------------------- contacts

  async listContacts(tx: Tx, patientId: string) {
    return tx.patientContact.findMany({
      where: { patientId },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
  }

  /** PAT-F-08: several are allowed, and exactly one of them is the first call. */
  async addContact(ctx: TenantContext, patientId: string, input: ContactInput) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);

    const id = newId();
    const phone = normalisePhone(input.phone);
    if (!phone) {
      throw new BadRequestError(
        'An emergency contact without a telephone number is not a contact.',
        'phone_required',
      );
    }

    const existing = await tx.patientContact.count({ where: { patientId } });
    const primary = input.isPrimary ?? existing === 0;
    if (primary) await this.clearPrimary(tx, patientId);

    await tx.patientContact.create({
      data: {
        id,
        tenantId: requireTenantId(),
        patientId,
        name: assertName(input.name),
        relationship: input.relationship ?? null,
        phone,
        isPrimary: primary,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientContactChanged,
      entityType: 'patient_contact',
      entityId: id,
      subjectPatientId: patientId,
      after: { name: input.name, relationship: input.relationship ?? null, isPrimary: primary },
    });
    return this.listContacts(tx, patientId);
  }

  async updateContact(
    ctx: TenantContext,
    patientId: string,
    contactId: string,
    input: Partial<ContactInput>,
  ) {
    const tx = this.db.tx();
    const before = await tx.patientContact.findFirst({ where: { id: contactId, patientId } });
    if (!before) throw new NotFoundError('Contact');

    if (input.isPrimary) await this.clearPrimary(tx, patientId);
    await tx.patientContact.update({
      where: { id: contactId },
      data: {
        ...(input.name === undefined ? {} : { name: assertName(input.name) }),
        ...(input.relationship === undefined ? {} : { relationship: input.relationship }),
        ...(input.phone === undefined ? {} : { phone: normalisePhone(input.phone) ?? before.phone }),
        ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientContactChanged,
      entityType: 'patient_contact',
      entityId: contactId,
      subjectPatientId: patientId,
      before,
      after: await tx.patientContact.findFirst({ where: { id: contactId } }),
    });
    return this.listContacts(tx, patientId);
  }

  async removeContact(ctx: TenantContext, patientId: string, contactId: string) {
    const tx = this.db.tx();
    const before = await tx.patientContact.findFirst({ where: { id: contactId, patientId } });
    if (!before) throw new NotFoundError('Contact');
    await tx.patientContact.delete({ where: { id: contactId } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientContactChanged,
      entityType: 'patient_contact',
      entityId: contactId,
      subjectPatientId: patientId,
      before,
    });
    return this.listContacts(tx, patientId);
  }

  private async clearPrimary(tx: Tx, patientId: string) {
    await tx.patientContact.updateMany({ where: { patientId }, data: { isPrimary: false } });
  }

  // -------------------------------------------------------------- consents

  async listConsents(tx: Tx, patientId: string) {
    return tx.patientConsent.findMany({ where: { patientId }, orderBy: [{ channel: 'asc' }] });
  }

  /**
   * PAT-F-09: each channel and purpose is its own opt-in, recorded with who
   * asked and when. Marketing starts off and stays off until somebody says
   * otherwise, which is what "opt-in" has to mean to be worth anything.
   */
  async setConsents(ctx: TenantContext, patientId: string, inputs: ConsentInput[]) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);
    const before = await this.listConsents(tx, patientId);
    const now = this.clock.now();

    for (const input of inputs) {
      const existing = before.find(
        (c) => c.channel === input.channel && c.purpose === input.purpose,
      );
      if (existing) {
        if (existing.granted === input.granted) continue;
        await tx.patientConsent.update({
          where: { id: existing.id },
          data: { granted: input.granted, recordedBy: ctx.userId, recordedAt: now, source: 'staff' },
        });
      } else {
        await tx.patientConsent.create({
          data: {
            id: newId(),
            tenantId: requireTenantId(),
            patientId,
            channel: input.channel,
            purpose: input.purpose,
            granted: input.granted,
            recordedBy: ctx.userId,
            recordedAt: now,
            source: 'staff',
          },
        });
      }
    }

    const after = await this.listConsents(tx, patientId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientConsentChanged,
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      before,
      after,
    });
    this.events.publish({
      name: DomainEvent.PatientConsentChanged,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { patientId },
    });
    return after;
  }

  // ------------------------------------------------------------- documents

  async listDocuments(tx: Tx, patientId: string) {
    return tx.patientDocument.findMany({
      where: { patientId, deletedAt: null },
      orderBy: { uploadedAt: 'desc' },
    });
  }

  /**
   * Checks and stores an uploaded file.
   *
   * The bytes are written outside the transaction, deliberately: a 20 MB
   * write must not hold a database connection (TEN-F-17), and the storage
   * service refuses to run inside one. So the file lands first and the row
   * is written after. A crash between the two leaves an unreferenced file,
   * which is litter; the other order would leave a row pointing at nothing,
   * which is a broken record.
   */
  async prepareUpload(file: { buffer: Buffer; mimetype?: string; originalname?: string }) {
    if (!file?.buffer?.length) {
      throw new BadRequestError('No file was uploaded.', 'file_missing');
    }
    if (file.buffer.length > this.config.storage.maxUploadBytes) {
      throw new BadRequestError(
        `That file is larger than the ${Math.round(this.config.storage.maxUploadBytes / 1_000_000)} MB limit.`,
        'file_too_large',
      );
    }

    // What it is, decided by its contents rather than by what the browser
    // said, because the browser is repeating what the filesystem guessed.
    const detected = [...ALLOWED_UPLOADS.entries()].find(([, spec]) => spec.magic(file.buffer));
    if (!detected) {
      throw new BadRequestError(
        'Attachments must be a PDF, a JPEG or a PNG.',
        'file_wrong_type',
      );
    }

    const [mime, spec] = detected;
    return {
      mime,
      extension: spec.extension,
      bytes: file.buffer,
      filename: sanitiseFilename(file.originalname ?? `document.${spec.extension}`),
    };
  }

  async recordDocument(
    ctx: TenantContext,
    patientId: string,
    type: PatientDocumentType,
    stored: { mime: string; filename: string; sizeBytes: number; storageKey: string },
  ) {
    const tx = this.db.tx();
    await this.patients.getOrThrow(tx, patientId);

    const id = newId();
    await tx.patientDocument.create({
      data: {
        id,
        tenantId: requireTenantId(),
        patientId,
        type,
        filename: stored.filename,
        mime: stored.mime,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
        uploadedBy: ctx.userId,
        uploadedAt: this.clock.now(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientDocumentAdded,
      entityType: 'patient_document',
      entityId: id,
      subjectPatientId: patientId,
      after: { type, filename: stored.filename, sizeBytes: stored.sizeBytes },
    });

    return this.listDocuments(tx, patientId);
  }

  /**
   * PAT-N-04: a link good for five minutes, and an audit entry for the fact
   * that somebody asked for it.
   */
  async issueDocumentLink(ctx: TenantContext, patientId: string, documentId: string) {
    const tx = this.db.tx();
    const document = await tx.patientDocument.findFirst({
      where: { id: documentId, patientId, deletedAt: null },
    });
    if (!document) throw new NotFoundError('Document');

    const { token, expiresAt } = this.storage.signKey(document.storageKey, ctx.tenantId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientDocumentViewed,
      entityType: 'patient_document',
      entityId: documentId,
      subjectPatientId: patientId,
      after: { filename: document.filename },
    });

    return {
      url: `/api/v1/patients/${patientId}/documents/${documentId}/content?token=${token}`,
      expiresAt: expiresAt.toISOString(),
      filename: document.filename,
      mime: document.mime,
    };
  }

  async fetchDocument(ctx: TenantContext, patientId: string, documentId: string, token: string) {
    const tx = this.db.tx();
    const document = await tx.patientDocument.findFirst({
      where: { id: documentId, patientId, deletedAt: null },
    });
    if (!document) throw new NotFoundError('Document');
    if (!this.storage.verifyKey(document.storageKey, ctx.tenantId, token)) {
      throw new NotFoundError('Document');
    }
    return document;
  }

  /**
   * PAT-F-27: everything held about one patient, for a subject access
   * request under the PDPA.
   *
   * JSON rather than a PDF, because what a person is entitled to is the
   * data, and a PDF of a data dump is a worse copy of the same thing. The
   * identity number is included in full: the request is from the patient
   * about themselves, and masking it would defeat the purpose. That is
   * exactly why the route needs `patient.export` and a recent re-auth, and
   * why the export itself is recorded.
   */
  async exportPatient(ctx: TenantContext, patientId: string) {
    const tx = this.db.tx();
    const patient = await this.patients.getOrThrow(tx, patientId);
    const [contacts, consents, documents, allergies, conditions] = await Promise.all([
      this.listContacts(tx, patientId),
      this.listConsents(tx, patientId),
      this.listDocuments(tx, patientId),
      tx.patientAllergy.findMany({ where: { patientId }, orderBy: { recordedAt: 'asc' } }),
      tx.patientCondition.findMany({ where: { patientId }, orderBy: { recordedAt: 'asc' } }),
    ]);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientExported,
      entityType: 'patient',
      entityId: patientId,
      subjectPatientId: patientId,
      after: { documents: documents.length, allergies: allergies.length },
    });

    return {
      exportedAt: this.clock.now().toISOString(),
      exportedBy: ctx.userName,
      patient: this.patients.present(patient, true),
      contacts,
      consents,
      allergies,
      conditions,
      // The attachments are listed rather than embedded. Each is fetched on
      // its own signed link, and a base64 blob of twenty megabytes inside a
      // JSON document helps nobody.
      documents: documents.map((d) => ({
        id: d.id,
        type: d.type,
        filename: d.filename,
        sizeBytes: d.sizeBytes,
        uploadedAt: d.uploadedAt,
      })),
      note:
        'Visits, prescriptions and invoices are added to this export as those modules are built.',
    };
  }

  async deleteDocument(ctx: TenantContext, patientId: string, documentId: string) {
    const tx = this.db.tx();
    const document = await tx.patientDocument.findFirst({
      where: { id: documentId, patientId, deletedAt: null },
    });
    if (!document) throw new NotFoundError('Document');

    // Soft, like everything else about a patient: a document removed by
    // mistake on a Friday is wanted again on Monday.
    await tx.patientDocument.update({
      where: { id: documentId },
      data: { deletedAt: this.clock.now(), deletedBy: ctx.userId },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientDocumentDeleted,
      entityType: 'patient_document',
      entityId: documentId,
      subjectPatientId: patientId,
      before: { filename: document.filename, type: document.type },
    });
    return this.listDocuments(tx, patientId);
  }
}

/** A name from a browser is a string somebody chose. This makes it a label. */
function sanitiseFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? 'document';
  const cleaned = base.replaceAll(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'document').slice(0, 255);
}
