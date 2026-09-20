import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = 'prisma/migrations/20260921130000_prescription/migration.sql';
const SCHEMA = 'prisma/schema.prisma';

const SCALARS = new Set([
  'String', 'Int', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Float', 'Decimal', 'BigInt',
]);
const ENUMS = new Set(['PrescriptionItemStatus']);

function toColumn(field: string): string {
  return field.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * The same test the consultation has, for the same reason: the trigger
 * names its columns one by one, so a column added later is unguarded
 * until somebody notices. Here the stakes are a dose that changed after
 * the pharmacy read it.
 */
describe('The prescribed-item trigger covers every clinical column (RX-R-06)', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const guard = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION prescription_item_is_immutable'),
    sql.indexOf('CREATE TRIGGER prescription_item_is_immutable_trigger'),
  );

  it('names what was prescribed', () => {
    for (const column of [
      'product_id',
      'external_name',
      'generic_name',
      'drug_class',
      'strength',
      'dose_value',
      'dose_unit',
      'route',
      'frequency_code',
      'frequency_per_day',
      'duration_days',
      'quantity',
      'quantity_unit',
      'instructions',
      'label_text',
      'is_controlled',
    ]) {
      expect(guard, column).toContain(`NEW.${column}`);
    }
  });

  it('accounts for every column on the table, one way or the other', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const model = schema.slice(
      schema.indexOf('model PrescriptionItem {'),
      schema.indexOf('model RxFavourite {'),
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
     * What may still move after an item is prescribed. Every one of
     * these is about the item's journey through the pharmacy rather
     * than about what was prescribed.
     */
    const mayMove: Record<string, string> = {
      id: 'the primary key',
      tenant_id: 'covered by row-level security and never rewritten',
      is_current: 'flipped when a later version supersedes this one',
      status: 'the whole point: dispensed, declined, cancelled, superseded',
      cancelled_reason: 'written when the status becomes cancelled or declined',
      override_confirmed_at: 'written by the signature itself (RX-R-04)',
      updated_at: 'row bookkeeping, written by the ORM on every touch',
    };

    const unaccounted = columns.filter(
      (column) => !guard.includes(`NEW.${column}`) && !(column in mayMove),
    );

    expect(
      unaccounted,
      'These columns exist on a prescribed item and are neither guarded by ' +
        'the immutability trigger nor listed as allowed to change afterwards. ' +
        `Add them to one or the other: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });
});
