import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = 'prisma/migrations/20260921160000_dispensing/migration.sql';
const SCHEMA = 'prisma/schema.prisma';

const SCALARS = new Set([
  'String', 'Int', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Float', 'Decimal', 'BigInt',
]);
const ENUMS = new Set(['DispenseOutcome']);

function toColumn(field: string): string {
  return field.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * The third of these, after the consultation and the prescribed item,
 * and for the same reason: the trigger names its columns one at a time,
 * so a column added next month is unguarded until somebody notices.
 *
 * Here the stakes are a record of what a patient was physically handed
 * being edited after the fact.
 */
describe('The dispensed-item trigger covers every column (DSP)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const guard = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION dispense_item_is_immutable'),
    sql.indexOf('CREATE TRIGGER dispense_item_is_immutable_trigger'),
  );

  it('names what was handed over', () => {
    for (const column of [
      'product_id',
      'quantity',
      'quantity_unit',
      'pack_rounded',
      'unit_price',
      'line_total',
      'outcome',
      'label_text',
      'dispensed_by',
      'dispensed_at',
      'idempotency_key',
      'is_substitute',
      'original_product_id',
      'prescription_item_id',
      'prescription_item_version',
    ]) {
      expect(guard, column).toContain(`NEW.${column}`);
    }
  });

  it('accounts for every column on the table, one way or the other', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const model = schema.slice(
      schema.indexOf('model DispenseItem {'),
      schema.indexOf('model DispenseItemBatch {'),
    );

    const lines = model.split('\n');
    const columns = lines
      .map((line) => /^ {2}(\w+)\s+(\w+)(\??)(\[\])?/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => !match[4])
      .filter((match) => SCALARS.has(match[2]!) || ENUMS.has(match[2]!))
      .map((match) => {
        const line = lines.find((l) => new RegExp(`^ {2}${match[1]!}\\s`).test(l))!;
        return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? toColumn(match[1]!);
      });

    /**
     * What may still move after something has been handed over. Each one
     * describes a thing that happens *later*, not a change to what
     * happened.
     */
    const mayMove: Record<string, string> = {
      id: 'the primary key',
      tenant_id: 'covered by row-level security and never rewritten',
      dispense_id: 'guarded above, listed here only because the loop sees it twice',
      substitute_reason: 'guarded above',
      outcome_reason: 'guarded above',
      label_prints: 'counts up on every reprint',
      counselled: 'ticked when the session is finished',
      reversed_at: 'DSP-F-16, the undo',
      reversed_by: 'the same',
      reversal_reason: 'the same',
      returned_quantity: 'DSP-F-17, the patient brought some back',
      returned_at: 'the same',
      returned_by: 'the same',
      return_reason: 'the same',
      created_at: 'row bookkeeping',
      updated_at: 'row bookkeeping, written by the ORM on every touch',
    };

    const unaccounted = columns.filter(
      (column) => !guard.includes(`NEW.${column}`) && !(column in mayMove),
    );

    expect(
      unaccounted,
      'These columns exist on a dispensed item and are neither guarded by ' +
        'the immutability trigger nor listed as allowed to change afterwards. ' +
        `Add them to one or the other: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the controlled register and the ledger append-only', () => {
    expect(sql).toContain('controlled_register_no_update');
    expect(sql).toContain('controlled_register_no_delete');
    // DSP-R-08 and DSP-R-03 are the two rules that can only be answered
    // at commit, and both must stay deferred.
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(
      sql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length,
      'both the batch-sum and the controlled-register rules are deferred',
    ).toBe(2);
  });
});
