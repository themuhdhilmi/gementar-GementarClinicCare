import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';

const API = '/api/v1';

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function time(run: () => Promise<unknown>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return samples;
}

/**
 * IAM-N-01 and the "under 1 s to workspace" target in §11, measured rather
 * than assumed.
 *
 * The thresholds asserted here are regression guards, not the requirement:
 * the real numbers depend on the machine and on how far away the database is,
 * and the authoritative measurement is this suite run on the production host.
 * What the assertions catch is a change that makes the guard an order of
 * magnitude slower.
 */
describe('Auth latency (IAM-N-01)', () => {
  const harness = new Harness();
  let fx: Fixture;
  let cookie: string;

  beforeAll(async () => {
    // Production hashing cost, so the sign-in figure means something.
    await harness.start({ ARGON2_MEMORY_KIB: '65536', ARGON2_ITERATIONS: '3' });
    fx = await harness.seedTenant('latency');
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: fx.doctor.email, password: DEFAULT_PASSWORD })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('the auth guard costs a few milliseconds a request', async () => {
    const iterations = 60;
    // Warm the pool and the query plans first.
    await time(() => request(harness.server).get(`${API}/clinical-probe/ping`), 10);
    await time(
      () => request(harness.server).get(`${API}/clinical-probe/ping-auth`).set('Cookie', cookie),
      10,
    );

    const publicRoute = await time(
      () => request(harness.server).get(`${API}/clinical-probe/ping`).expect(200),
      iterations,
    );
    const guarded = await time(
      () =>
        request(harness.server)
          .get(`${API}/clinical-probe/ping-auth`)
          .set('Cookie', cookie)
          .expect(200),
      iterations,
    );

    const overhead = {
      p50: percentile(guarded, 50) - percentile(publicRoute, 50),
      p95: percentile(guarded, 95) - percentile(publicRoute, 95),
    };

    // eslint-disable-next-line no-console
    console.log(
      `\n  auth guard over ${iterations} requests` +
        `\n    public route     p50 ${percentile(publicRoute, 50).toFixed(2)} ms   p95 ${percentile(publicRoute, 95).toFixed(2)} ms` +
        `\n    authenticated    p50 ${percentile(guarded, 50).toFixed(2)} ms   p95 ${percentile(guarded, 95).toFixed(2)} ms` +
        `\n    guard overhead   p50 ${overhead.p50.toFixed(2)} ms   p95 ${overhead.p95.toFixed(2)} ms\n`,
    );

    expect(overhead.p95).toBeLessThan(50);
  });

  it('signing in and landing on the workspace stays under a second', async () => {
    const samples = await time(async () => {
      const login = await request(harness.server)
        .post(`${API}/auth/login`)
        .send({ email: fx.doctor.email, password: DEFAULT_PASSWORD })
        .expect(200);
      const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('cc_session='),
      )!;
      await request(harness.server).get(`${API}/auth/me`).set('Cookie', session).expect(200);
    }, 5);

    // eslint-disable-next-line no-console
    console.log(
      `  sign-in then /auth/me   p50 ${percentile(samples, 50).toFixed(0)} ms   ` +
        `p95 ${percentile(samples, 95).toFixed(0)} ms   (Argon2id at 64 MiB, 3 iterations)\n`,
    );

    expect(percentile(samples, 95)).toBeLessThan(1000);
  });
});
