import { Injectable, Logger } from '@nestjs/common';
import {
  AllergyStatus,
  AllergyType,
  Gender,
  IdType,
  PatientStatus,
} from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { MrnService } from './mrn.service.js';
import { PatientService } from './patient.service.js';
import { lastFour, normaliseIdentity } from './identity.js';
import {
  assertDateOfBirth,
  assertName,
  normaliseEmail,
  normalisePhone,
} from './patient.validation.js';

export type RowVerdict = {
  row: number;
  action: 'IMPORT' | 'SKIP_DUPLICATE' | 'REJECT';
  name?: string;
  mrn?: string;
  /** Plain English, because the clinic reads this report, not a developer. */
  message?: string;
  matchedPatientId?: string;
};

export type ImportReport = {
  batchId: string;
  dryRun: boolean;
  filename: string;
  rowCount: number;
  imported: number;
  skipped: number;
  rejected: number;
  verdicts: RowVerdict[];
};

/** What the CSV is expected to contain. Everything after `name` is optional. */
const COLUMNS = [
  'name',
  'id_type',
  'id_number',
  'date_of_birth',
  'gender',
  'phone',
  'email',
  'address_line1',
  'address_line2',
  'postcode',
  'city',
  'state',
  'mrn',
  'allergies',
  'notes',
] as const;

/**
 * PAT-F-28: bringing the clinic's existing patients across.
 *
 * This runs once, badly, and then again properly. The dry run is the point
 * of the whole thing: the clinic sees exactly what would happen, row by row,
 * decides what to do about the duplicates and the rubbish, and only then is
 * anything written.
 *
 * Deliberately unclever about matching. An import that silently merges two
 * people because their names are similar is far worse than one that creates
 * a duplicate the clinic can merge later, on purpose, having looked at both.
 */
@Injectable()
export class PatientImportService {
  private readonly logger = new Logger(PatientImportService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly patients: PatientService,
    private readonly mrn: MrnService,
  ) {}

  /**
   * A small CSV reader rather than a dependency.
   *
   * Quoted fields with embedded commas, quotes and newlines are the only
   * things a clinic export actually uses, and they are twenty lines. A
   * library would be another supply chain for a file that is read once.
   */
  static parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;

    // A byte-order mark at the start of a file exported from Excel would
    // otherwise become part of the first column name.
    const source = text.replace(/^﻿/, '');

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i]!;
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[i + 1] === '\n') i += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  }

  async run(
    ctx: TenantContext,
    filename: string,
    csv: string,
    options: { dryRun: boolean; startMrnAt?: number },
  ): Promise<ImportReport> {
    const rows = PatientImportService.parseCsv(csv);
    if (rows.length < 2) {
      throw new BadRequestError(
        'That file has no rows under its header line.',
        'import_empty',
      );
    }

    const header = rows[0]!.map((h) => h.trim().toLowerCase().replaceAll(/[\s-]+/g, '_'));
    if (!header.includes('name')) {
      throw new BadRequestError(
        `The first line must name the columns, and must include "name". Recognised columns: ${COLUMNS.join(', ')}.`,
        'import_no_header',
      );
    }

    const unknown = header.filter((h) => h !== '' && !COLUMNS.includes(h as never));
    if (unknown.length > 0) {
      // Refused rather than ignored: a column nobody reads is usually a
      // column somebody expected to be read.
      throw new BadRequestError(
        `These columns are not recognised and would be ignored: ${unknown.join(', ')}. ` +
          `Remove or rename them. Recognised columns: ${COLUMNS.join(', ')}.`,
        'import_unknown_columns',
      );
    }

    const batchId = newId();
    const verdicts: RowVerdict[] = [];
    const now = this.clock.now();
    if (options.startMrnAt && !options.dryRun) {
      await this.mrn.reserveAtLeast(options.startMrnAt);
    }

    // Identity numbers seen earlier in this same file, so a CSV that
    // contains the same person twice is reported rather than half-imported.
    const seenInFile = new Map<string, number>();

    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index]!;
      const get = (column: (typeof COLUMNS)[number]): string => {
        const at = header.indexOf(column);
        return at === -1 ? '' : (cells[at] ?? '').trim();
      };
      const rowNumber = index + 1;

      try {
        const name = assertName(get('name'));
        const idTypeRaw = (get('id_type') || 'NONE').toUpperCase();
        if (!Object.values(IdType).includes(idTypeRaw as IdType)) {
          throw new BadRequestError(
            `"${idTypeRaw}" is not an identity type. Use one of ${Object.values(IdType).join(', ')}.`,
            'invalid_id_type',
          );
        }
        const idType = idTypeRaw as IdType;
        const identity = normaliseIdentity(idType, get('id_number') || null, { now });

        const genderRaw = (get('gender') || '').toUpperCase();
        const gender =
          genderRaw === 'M' || genderRaw === 'MALE'
            ? Gender.MALE
            : genderRaw === 'F' || genderRaw === 'FEMALE'
              ? Gender.FEMALE
              : identity.gender ?? Gender.UNKNOWN;

        const dateOfBirth = get('date_of_birth')
          ? assertDateOfBirth(get('date_of_birth'), now)
          : (identity.dateOfBirth ?? null);

        if (identity.idNumber) {
          const earlier = seenInFile.get(identity.idNumber);
          if (earlier) {
            verdicts.push({
              row: rowNumber,
              action: 'SKIP_DUPLICATE',
              name,
              message: `The same identity number appears on line ${earlier} of this file.`,
            });
            continue;
          }
          seenInFile.set(identity.idNumber, rowNumber);
        }

        const existing = identity.idNumber
          ? await this.db.tx().patient.findFirst({
              where: {
                idType,
                idNumber: identity.idNumber,
                status: { in: [PatientStatus.ACTIVE, PatientStatus.DECEASED] },
              },
              select: { id: true, mrn: true, name: true },
            })
          : null;

        if (existing) {
          verdicts.push({
            row: rowNumber,
            action: 'SKIP_DUPLICATE',
            name,
            mrn: existing.mrn,
            matchedPatientId: existing.id,
            message: `Already registered as ${existing.mrn} (${existing.name}).`,
          });
          continue;
        }

        if (options.dryRun) {
          verdicts.push({ row: rowNumber, action: 'IMPORT', name });
          continue;
        }

        const providedMrn = get('mrn');
        const mrn = providedMrn || (await this.mrn.next());
        const patientId = newId();

        await this.db.tx().patient.create({
          data: {
            id: patientId,
            tenantId: requireTenantId(),
            mrn,
            name,
            idType,
            idNumber: identity.idNumber === '' ? null : identity.idNumber,
            idNumberLast4: identity.idNumber === '' ? null : lastFour(identity.idNumber),
            dateOfBirth,
            gender,
            phone: normalisePhone(get('phone')),
            email: normaliseEmail(get('email')),
            addressLine1: get('address_line1') || null,
            addressLine2: get('address_line2') || null,
            postcode: get('postcode') || null,
            city: get('city') || null,
            state: get('state') || null,
            notes: get('notes') || null,
            status: PatientStatus.ACTIVE,
            source: `IMPORT:${batchId}`,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        });

        // PAT-R-04: an allergy that arrives as free text in a spreadsheet is
        // hearsay until a clinician looks at the patient and confirms it.
        // The amber "not recorded" state is what prompts them to.
        const allergies = get('allergies');
        if (allergies) {
          for (const substance of allergies.split(/[;|]/).map((a) => a.trim()).filter(Boolean)) {
            await this.db.tx().patientAllergy.create({
              data: {
                id: newId(),
                tenantId: requireTenantId(),
                patientId,
                type: AllergyType.OTHER,
                substance: substance.slice(0, 120),
                status: AllergyStatus.UNVERIFIED,
                recordedBy: ctx.userId,
                recordedAt: now,
                notes: `Imported from the previous system: "${substance.slice(0, 200)}"`,
              },
            });
          }
        }

        verdicts.push({ row: rowNumber, action: 'IMPORT', name, mrn });
      } catch (error) {
        verdicts.push({
          row: rowNumber,
          action: 'REJECT',
          name: get('name') || undefined,
          message: error instanceof Error ? error.message : 'Could not be read.',
        });
      }
    }

    const imported = verdicts.filter((v) => v.action === 'IMPORT').length;
    const skipped = verdicts.filter((v) => v.action === 'SKIP_DUPLICATE').length;
    const rejected = verdicts.filter((v) => v.action === 'REJECT').length;

    const report: ImportReport = {
      batchId,
      dryRun: options.dryRun,
      filename,
      rowCount: rows.length - 1,
      imported,
      skipped,
      rejected,
      verdicts,
    };

    await this.db.tx().patientImportBatch.create({
      data: {
        id: batchId,
        tenantId: requireTenantId(),
        filename,
        rowCount: report.rowCount,
        imported,
        skipped,
        merged: 0,
        dryRun: options.dryRun,
        report: report as unknown as object,
        runBy: ctx.userId,
        runAt: now,
      },
    });

    await this.audit.record(this.db.tx(), this.audit.actorFromContext(ctx), {
      action: AuditAction.PatientImported,
      entityType: 'patient_import_batch',
      entityId: batchId,
      after: { filename, dryRun: options.dryRun, imported, skipped, rejected },
    });

    this.logger.log(
      `${options.dryRun ? 'Dry run' : 'Import'} of ${filename}: ` +
        `${imported} to import, ${skipped} already present, ${rejected} rejected.`,
    );
    void this.patients;
    return report;
  }

  async getBatch(batchId: string) {
    return this.db.tx().patientImportBatch.findFirst({ where: { id: batchId } });
  }
}
