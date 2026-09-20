import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';

const API = '/api/v1';

/**
 * How many statements does one request send to the database?
 *
 * Milliseconds depend on where the database is; the number of round trips
 * does not, and it is the thing a code change actually moves. Counting them
 * is exact, so this is the guard against a query quietly appearing in a hot
 * path. `test/auth-latency.e2e-spec.ts` measures what they cost.
 *
 * The count comes from the driver's own query log. Prisma writes it with
 * `console.log`, which the test runner replaces with its own, so both that and
 * the raw stream are wrapped: whichever one is really in use gets counted.
 */
function countStatements(): { stop: () => string[] } {
  const seen: string[] = [];
  const take = (text: string): void => {
    for (const line of text.split('\n')) {
      const at = line.indexOf('prisma:query');
      if (at !== -1) seen.push(line.slice(at + 'prisma:query'.length).replaceAll(/\s+/g, ' ').trim());
    }
  };

  const originalLog = console.log.bind(console);
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    take(args.map(String).join(' '));
  };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    take(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  return {
    stop: () => {
      console.log = originalLog;
      process.stdout.write = originalWrite;
      return seen;
    },
  };
}

describe('Round trips per request', () => {
  const harness = new Harness();
  let fx: Fixture;
  let cookie: string;

  beforeAll(async () => {
    await harness.start({ DB_LOG_QUERIES: 'true' });
    fx = await harness.seedTenant('trips');
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: fx.doctor.email, password: DEFAULT_PASSWORD })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
  }, 60_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('the auth guard, on a route that does nothing else', async () => {
    // Warm first: the very first request pays for connection setup.
    await request(harness.server)
      .get(`${API}/clinical-probe/ping-auth`)
      .set('Cookie', cookie)
      .expect(200);

    const counter = countStatements();
    await request(harness.server)
      .get(`${API}/clinical-probe/ping-auth`)
      .set('Cookie', cookie)
      .expect(200);
    const statements = counter.stop();

    process.stderr.write(
      `\n  ${statements.length} statements for one authenticated request:\n` +
        statements.map((q, i) => `    ${i + 1}. ${q.slice(0, 120)}`).join('\n') +
        '\n\n',
    );

    // A count of zero would mean the log was not captured at all rather than
    // that nothing ran, so the floor matters as much as the ceiling.
    expect(statements.length).toBeGreaterThanOrEqual(5);

    // Set the scope, read the session, its user and its tenant, switch the
    // scope, read the roles, COMMIT; then the request's own transaction sets
    // its scope and commits. BEGIN is not logged, so eleven round trips show
    // up here as nine lines. More than this means a query was added to the
    // hottest path in the system: see IAM-OPEN-23 before raising it.
    expect(statements.length).toBeLessThanOrEqual(9);
  });
});
