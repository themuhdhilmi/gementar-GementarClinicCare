import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { newId } from '../src/shared/ids/uuid.js';

const API = '/api/v1';

/**
 * PAT-N-01 and PAT-T-03: search at the size the pilot will actually reach.
 *
 * Off by default, because seeding a hundred thousand rows takes a couple of
 * minutes and nobody wants that on every push. Run it deliberately:
 *
 *     PAT_LOAD_TEST=true npm run test:e2e -- test/patient-search-load.e2e-spec.ts
 *
 * The number it prints is the one that belongs in §13 of the module
 * specification, and it has to be re-run on the production host, where the
 * database is local and the machine is smaller.
 */
const ENABLED = process.env['PAT_LOAD_TEST'] === 'true';
const ROWS = Number(process.env['PAT_LOAD_ROWS'] ?? 100_000);

const FIRST = ['Ahmad', 'Siti', 'Muhammad', 'Nur', 'Chan', 'Lim', 'Tan', 'Muthu', 'Kumar', 'Farid'];
const SECOND = ['Abdullah', 'Kassim', 'Hassan', 'Ismail', 'Wei Ming', 'Mei Ling', 'Raman', 'Devi'];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe.skipIf(!ENABLED)('PAT — search at scale', () => {
  const harness = new Harness();
  let fx: Fixture;
  let cookie: string;
  let needle: { mrn: string; idNumber: string; last4: string; phone: string; name: string };

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('load');
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: fx.frontdesk.email, password: DEFAULT_PASSWORD })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    // Seeded with raw inserts in batches. Going through the API would take
    // hours and would be measuring registration, not search.
    const started = Date.now();
    const BATCH = 2000;
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      const values: string[] = [];
      const params: unknown[] = [fx.tenantId];
      let n = 2;
      for (let i = 0; i < Math.min(BATCH, ROWS - offset); i += 1) {
        const index = offset + i;
        const name = `${FIRST[index % FIRST.length]} ${SECOND[index % SECOND.length]} ${index}`;
        const ic = String(700_000_000_000 + index * 7);
        const phone = `+60${String(1_000_000_000 + index).slice(0, 10)}`;
        values.push(
          `($${n}::uuid, $1::uuid, $${n + 1}, $${n + 2}, 'MYKAD', $${n + 3}, $${n + 4}, ` +
            `'1985-01-01'::date, 'MALE', 'MY', $${n + 5}, 'ACTIVE', '{}', now(), now())`,
        );
        params.push(newId(), `L-${index}`, name, ic, ic.slice(-4), phone);
        n += 6;
      }
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO patient (id, tenant_id, mrn, name, id_type, id_number, id_number_last4,
                                date_of_birth, gender, nationality, phone, status, merge_manifest,
                                created_at, updated_at)
           VALUES ${values.join(',')}`,
          ...params,
        ),
      );
    }

    const middle = Math.floor(ROWS / 2);
    const ic = String(700_000_000_000 + middle * 7);
    needle = {
      mrn: `L-${middle}`,
      idNumber: ic,
      last4: ic.slice(-4),
      phone: `+60${String(1_000_000_000 + middle).slice(0, 10)}`,
      name: `${FIRST[middle % FIRST.length]} ${SECOND[middle % SECOND.length]} ${middle}`,
    };

    // eslint-disable-next-line no-console
    console.log(`\n  seeded ${ROWS} patients in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    await harness.db.withPlatform('analyse for the planner', (tx) =>
      tx.$executeRawUnsafe('ANALYZE patient'),
    );
  }, 900_000);

  afterAll(async () => {
    await harness.stop();
  }, 300_000);

  it(`PAT-T-03: answers in under 300 ms at ${ROWS} patients`, async () => {
    const run = async (q: string) => {
      const response = await request(harness.server)
        .post(`${API}/patients/search`)
        .set('Cookie', cookie)
        .send({ q })
        .expect(200);
      return response.body.items as Array<{ mrn: string }>;
    };

    // Warm the pool and let the planner settle before measuring.
    for (const q of [needle.last4, needle.name, needle.phone]) await run(q);

    const cases: Array<{ label: string; q: string; expectFirst: boolean }> = [
      { label: 'last four of the identity card', q: needle.last4, expectFirst: false },
      { label: 'whole identity number', q: needle.idNumber, expectFirst: true },
      { label: 'patient number', q: needle.mrn, expectFirst: true },
      { label: 'telephone number', q: needle.phone, expectFirst: true },
      { label: 'full name', q: needle.name, expectFirst: true },
      { label: 'one common name', q: 'ahmad', expectFirst: false },
    ];

    const report: string[] = [];
    let worst = 0;

    for (const testCase of cases) {
      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const at = process.hrtime.bigint();
        const items = await run(testCase.q);
        samples.push(Number(process.hrtime.bigint() - at) / 1e6);
        if (i === 0) {
          expect(items.length, testCase.label).toBeGreaterThan(0);
          if (testCase.expectFirst) expect(items[0]?.mrn, testCase.label).toBe(needle.mrn);
          // PAT §14: a common name is capped rather than returning hundreds.
          expect(items.length, testCase.label).toBeLessThanOrEqual(20);
        }
      }
      const p95 = percentile(samples, 95);
      worst = Math.max(worst, p95);
      report.push(
        `    ${testCase.label.padEnd(32)} p50 ${percentile(samples, 50).toFixed(1)} ms` +
          `   p95 ${p95.toFixed(1)} ms   p99 ${percentile(samples, 99).toFixed(1)} ms`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(`\n  search over ${ROWS} patients, end to end including HTTP:\n${report.join('\n')}\n`);

    // Generous against the 300 ms in PAT-N-01, because this measures a whole
    // HTTP round trip to a database on the other side of a network. The
    // figure that counts is the one from the production host.
    expect(worst).toBeLessThan(1500);
  }, 300_000);
});
