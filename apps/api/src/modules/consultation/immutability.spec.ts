import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLINICAL_FIELDS } from './consultation.service.js';

const MIGRATION = 'prisma/migrations/20260921110000_consultation/migration.sql';
const SCHEMA = 'prisma/schema.prisma';

/** Prisma's own scalar types. Anything else in that position is a relation. */
const SCALARS = new Set(['String', 'Int', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Float', 'Decimal', 'BigInt']);

/** Prisma enums used on this model, which are columns rather than relations. */
const ENUMS = new Set(['ConsultationStatus']);

/** `chiefComplaint` is `chief_complaint` in the database. */
function toColumn(field: string): string {
  return field.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * The immutability trigger names its columns one by one rather than
 * comparing whole rows, because a few columns must stay writable after
 * signing. That makes it possible to add a clinical field and forget it,
 * and a silent gap in an immutability rule is worse than no rule, because
 * everybody believes the record is safe.
 *
 * This is the test the migration's own comment promises.
 */
describe('The signed-record trigger covers every clinical column (CON-R-01)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const guard = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION consultation_signed_is_immutable'),
    sql.indexOf('CREATE TRIGGER consultation_signed_is_immutable_trigger'),
  );

  it('names every section a doctor writes', () => {
    const missing = CLINICAL_FIELDS.filter((field) => !guard.includes(`NEW.${toColumn(field)}`));
    expect(
      missing,
      `These sections can be changed after signing without the trigger noticing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('names the fields that say whose record it is and when it was signed', () => {
    for (const column of [
      'status',
      'doctor_id',
      'patient_id',
      'encounter_id',
      'signed_at',
      'signed_by',
      'content_hash',
      'follow_up_due',
      'follow_up_note',
    ]) {
      expect(guard, column).toContain(`NEW.${column}`);
    }
  });

  /**
   * The reverse direction, and the one that actually catches a mistake:
   * every column the schema declares on a consultation is either guarded
   * or is on a short list of things that are allowed to move afterwards.
   * Adding a column puts it in neither, and this fails.
   */
  it('accounts for every column on the table, one way or the other', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const model = schema.slice(
      schema.indexOf('model Consultation {'),
      schema.indexOf('model Diagnosis {'),
    );

    // Scalar columns only, one line at a time. An earlier version took a
    // 300-character window around each field name, which spilled into the
    // following lines and picked up their `@map`, so a planted unguarded
    // column was silently renamed to one that was allowed to move. The
    // test passed and proved nothing.
    const columns = model
      .split('\n')
      .map((line) => /^ {2}(\w+)\s+(\w+)(\??)(\[\])?/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      // A list is a relation, never a column.
      .filter((match) => !match[4])
      .filter((match) => SCALARS.has(match[2]!) || ENUMS.has(match[2]!))
      .map((match) => {
        const line = model.split('\n').find((l) => new RegExp(`^ {2}${match[1]!}\\s`).test(l))!;
        return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? toColumn(match[1]!);
      });

    /** Columns that may legitimately change after a record is signed. */
    const mayMove: Record<string, string> = {
      id: 'the primary key, which never changes anyway',
      tenant_id: 'covered by row-level security and never rewritten',
      branch_id: 'where the visit happened, not clinical content',
      sequence: 'its position among the visit’s consultations',
      template_id: 'which template it started from',
      copied_from_id: 'which earlier visit the history came from',
      started_at: 'when the doctor opened it',
      last_autosave_at: 'the draft clock, meaningless once signed',
      signed_ip: 'recorded at signing and not part of the clinical content',
      cancelled_at: 'unreachable: a signed record cannot become cancelled',
      cancel_reason: 'the same',
      created_at: 'row bookkeeping',
      updated_at: 'row bookkeeping, written by the ORM on every touch',
    };

    const unaccounted = columns.filter(
      (column) => !guard.includes(`NEW.${column}`) && !(column in mayMove),
    );

    expect(
      unaccounted,
      'These columns exist on a consultation and are neither guarded by the ' +
        'immutability trigger nor listed as allowed to change after signing. ' +
        `Add them to one or the other: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });
});
