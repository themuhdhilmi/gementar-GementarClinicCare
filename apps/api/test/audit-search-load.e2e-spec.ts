import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { newId } from '../src/shared/ids/uuid.js';

const API = '/api/v1';

/**
 * AUD-N-02 and AUD-T-08: searching the trail at the size it will reach.
 *
 * Off by default, because seeding a hundred thousand entries takes a
 * couple of minutes. Run it deliberately:
 *
 *     AUD_LOAD_TEST=true npm run test:e2e -- test/audit-search-load.e2e-spec.ts
 *
 * The specification asks for ten million rows over twelve months. That
 * is the number the *pilot* will not reach for years, and the number
 * this test cannot seed in a reasonable time — so it seeds a hundred
 * thousand, spread across twelve months so partition pruning is actually
 * exercised, and the figure it prints is a floor rather than the answer.
 * Re-run it on the production host, where the database is local.
 */
const ENABLED = process.env['AUD_LOAD_TEST'] === 'true';
const ROWS = Number(process.env['AUD_LOAD_ROWS'] ?? 100_000);
const BATCH = 2_000;

const ACTIONS = [
  'clinical.viewed',
  'patient.updated',
  'encounter.status_changed',
  'invoice.issued',
  'stock.adjusted',
  'auth.login',
];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ] ?? 0
  );
}

describe.skipIf(!ENABLED)('AUD-T-08 — searching a full trail', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let needle: string;

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('audit-load');

    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: fx.admin.email, password: DEFAULT_PASSWORD })
      .expect(200);
    admin = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', admin)
      .expect(200);
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', admin)
      .send({ code: totpFor(enrol.body.secret) })
      .expect(200);

    // The partitions the seeded months will need. In production the
    // nightly job does this; here the data arrives before the months do.
    await harness.db.withPlatform(
      'partitions for the seeded year',
      async (tx) => {
        for (let back = 0; back <= 12; back += 1) {
          await tx.$executeRawUnsafe(
            `SELECT audit_log_ensure_partition((date_trunc('month', now()) - make_interval(months => ${back}))::date)`,
          );
        }
      },
    );

    needle = newId();
    const started = Date.now();
    for (let done = 0; done < ROWS; done += BATCH) {
      const rows = Array.from(
        { length: Math.min(BATCH, ROWS - done) },
        (_, i) => {
          const n = done + i;
          return {
            id: newId(),
            tenantId: fx.tenantId,
            branchId: fx.branchAId,
            actorId: fx.doctor.id,
            actorName: 'Dr Load',
            actorRole: 'DOCTOR',
            action: ACTIONS[n % ACTIONS.length]!,
            entityType: 'patient',
            entityId: newId(),
            // One patient in every thousand is the one we look for.
            subjectPatientId: n % 1_000 === 0 ? needle : newId(),
            occurredAt: new Date(Date.now() - (n % 360) * 86_400_000),
          };
        },
      );
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.createMany({ data: rows }),
      );
    }
    console.log(
      `seeded ${ROWS} entries in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }, 1_200_000);

  afterAll(async () => {
    await harness.stop();
  });

  it(`returns the first page in under 500 ms across ${ROWS} entries`, async () => {
    const byPatient: number[] = [];
    const byActor: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      let started = performance.now();
      await request(harness.server)
        .get(`${API}/audit`)
        .set('Cookie', admin)
        .query({
          patientId: needle,
          from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        })
        .expect(200);
      byPatient.push(performance.now() - started);

      started = performance.now();
      await request(harness.server)
        .get(`${API}/audit`)
        .set('Cookie', admin)
        .query({
          actorId: fx.doctor.id,
          from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        })
        .expect(200);
      byActor.push(performance.now() - started);
    }

    const report = {
      byPatientP95: Math.round(percentile(byPatient, 95)),
      byActorP95: Math.round(percentile(byActor, 95)),
    };
    console.log('AUD-N-02', report);

    expect(report.byPatientP95).toBeLessThan(500);
    expect(report.byActorP95).toBeLessThan(500);
  }, 300_000);

  it('prunes the partitions it does not need', async () => {
    const plan = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT id FROM audit_log
           WHERE tenant_id = $1::uuid
             AND occurred_at >= now() - interval '20 days'
           ORDER BY occurred_at DESC LIMIT 25`,
        fx.tenantId,
      ),
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    console.log(text);

    // Twenty days touches at most two months. Anything more means the
    // partition key is not being used and AUD-F-14 bought nothing.
    const scanned = (text.match(/audit_log_\d{4}_\d{2}/g) ?? []).length;
    expect(scanned).toBeLessThanOrEqual(2);
  }, 120_000);
});
