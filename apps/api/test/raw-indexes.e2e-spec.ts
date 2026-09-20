import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './support/harness.js';

/**
 * Indexes the Prisma schema language cannot express.
 *
 * `prisma migrate diff` only sees what the schema declares, so it
 * proposes dropping every hand-written index — and a `DropIndex` line
 * buried in a hundred-line generated migration is easy to carry through
 * without reading. That is exactly what happened to
 * `patient_name_trgm_idx`: the encounter migration dropped it and
 * nothing recreated it, and patient name search read every row in the
 * tenant for three migrations afterwards. Nothing failed. It was just
 * slower, which is the kind of defect that survives.
 *
 * So the expected set lives here, checked against the live database.
 * Adding a hand-written index means adding a line to this list.
 */
const REQUIRED = [
  {
    name: 'patient_name_trgm_idx',
    table: 'patient',
    why: 'PAT-N-01: name search over 100k patients in under 300 ms',
    expect: /gin.*name_normalised.*gin_trgm_ops/is,
  },
  {
    name: 'product_search_trgm_idx',
    table: 'product',
    why: 'INV-F-06: type-ahead over the catalogue while prescribing',
    expect: /gin.*search_text.*gin_trgm_ops/is,
  },
  {
    name: 'product_barcode_idx',
    table: 'product',
    why: 'INV-F-06: a scanned barcode has to resolve instantly',
    expect: /gin.*barcodes/is,
  },
];

describe('Hand-written indexes survive every migration', () => {
  const harness = new Harness();

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it.each(REQUIRED)('$name exists on $table — $why', async ({ name, table, expect: shape }) => {
    const rows = await harness.db.withPlatform('raw index check', async (tx) =>
      tx.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ${table} AND indexname = ${name}
      `,
    );

    expect(
      rows.length,
      `${name} is missing. A "migrate diff" almost certainly proposed dropping it ` +
        'and the drop was carried into a migration. Recreate it.',
    ).toBe(1);
    expect(rows[0]!.indexdef).toMatch(shape);
  });
});
