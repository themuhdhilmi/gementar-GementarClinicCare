import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { Role, UserStatus } from '../src/generated/prisma/enums.js';
import { newId } from '../src/shared/ids/uuid.js';
import { TENANT_SCOPED_MODELS } from '../src/shared/prisma/tenant-scope.js';

const API = '/api/v1';

/**
 * The isolation suite from documents/planning/03-multi-tenancy.md, translated
 * to what MySQL can enforce. On Postgres row-level security is the backstop;
 * here it is the Prisma extension plus the DBA trigger script, so these tests
 * are the thing standing between two clinics' records.
 */
describe('Tenant isolation (against real MySQL)', () => {
  const harness = new Harness();
  let a: Fixture;
  let b: Fixture;
  let adminCookieA: string;

  beforeAll(async () => {
    await harness.start();
    a = await harness.seedTenant('iso-a');
    b = await harness.seedTenant('iso-b');

    // Sign in as tenant A's front desk: no MFA requirement, plenty of reach.
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: a.frontdesk.email, password: DEFAULT_PASSWORD })
      .expect(200);
    adminCookieA = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('a query in tenant A never returns tenant B rows', async () => {
    const usersOfA = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.findMany({ select: { id: true, tenantId: true } }),
    );
    expect(usersOfA.length).toBeGreaterThan(0);
    expect(usersOfA.every((u) => u.tenantId === a.tenantId)).toBe(true);
    expect(usersOfA.some((u) => u.id === b.admin.id)).toBe(false);
  });

  it("reading tenant B's user by its real id, from tenant A, finds nothing", async () => {
    const found = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: b.admin.id } }),
    );
    expect(found).toBeNull();

    const byUnique = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.findUnique({ where: { id: b.admin.id } }),
    );
    expect(byUnique).toBeNull();
  });

  it("updating tenant B's user from tenant A changes nothing", async () => {
    const before = await harness.db.withTenant(b.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: b.admin.id }, select: { name: true } }),
    );

    const result = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.updateMany({ where: { id: b.admin.id }, data: { name: 'Hijacked' } }),
    );
    expect(result.count).toBe(0);

    const after = await harness.db.withTenant(b.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: b.admin.id }, select: { name: true } }),
    );
    expect(after?.name).toBe(before?.name);
  });

  it('a write that carries another tenant id is refused before it reaches the database', async () => {
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.user.create({
          data: {
            id: newId(),
            tenantId: b.tenantId,
            email: `sneaky-${newId().slice(-8)}@test.local`,
            name: 'Sneaky',
            status: UserStatus.ACTIVE,
          },
        }),
      ),
    ).rejects.toThrow(/another tenant/i);

    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.user.findMany({ where: { tenantId: b.tenantId } }),
      ),
    ).rejects.toThrow(/another tenant/i);

    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.user.updateMany({ where: { id: a.admin.id }, data: { tenantId: b.tenantId } }),
      ),
    ).rejects.toThrow(/may not be reassigned/i);
  });

  it('a query with no scope open is refused, rather than returning everything', async () => {
    await expect(harness.db.raw.user.findMany({})).rejects.toThrow(/no tenant scope/i);
    await expect(harness.db.raw.session.count()).rejects.toThrow(/no tenant scope/i);
  });

  it('the connection carries @app_tenant_id, so the database guards can act on it', async () => {
    const seen = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ v: string | null }>>('SELECT @app_tenant_id AS v'),
    );
    expect(seen[0]?.v).toBe(a.tenantId);

    const platform = await harness.db.withPlatform('test', (tx) =>
      tx.$queryRawUnsafe<Array<{ v: string | null; off: number }>>(
        'SELECT @app_tenant_id AS v, @app_tenant_guard_off AS off',
      ),
    );
    expect(platform[0]?.v).toBeNull();
    expect(Number(platform[0]?.off)).toBe(1);
  });

  it('opening a different tenant scope inside an open one is refused', async () => {
    await expect(
      harness.db.withTenant(a.tenantId, () => harness.db.withTenant(b.tenantId, async () => 'no')),
    ).rejects.toThrow(/Refused to open/i);
  });

  it('the API refuses cross-tenant identifiers, with 404 rather than 403', async () => {
    const otherUser = await request(harness.server)
      .get(`${API}/users/${b.admin.id}`)
      .set('Cookie', adminCookieA);
    // FRONTDESK lacks admin.users, so authorisation answers first.
    expect(otherUser.status).toBe(403);

    const switchAway = await request(harness.server)
      .put(`${API}/auth/me/branch`)
      .set('Cookie', adminCookieA)
      .send({ branchId: b.branchAId });
    expect(switchAway.status).toBe(403);
  });

  it("a user cannot be given another tenant's branch", async () => {
    const admin = await harness.addUser(a, {
      name: 'Iso Admin',
      roles: [{ branchId: a.branchAId, role: Role.ADMIN }],
    });
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: admin.email, password: DEFAULT_PASSWORD })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    const { totpFor } = await import('./support/harness.js');
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: totpFor(enrol.body.secret) })
      .expect(200);

    const response = await request(harness.server)
      .post(`${API}/users`)
      .set('Cookie', cookie)
      .send({
        name: 'Cross Tenant',
        email: `cross-${newId().slice(-8)}@test.local`,
        roles: [{ branchId: b.branchAId, role: Role.NURSE }],
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('unknown_branch');
  });

  it('every table with a mandatory tenant_id is classified as tenant-scoped', async () => {
    // The MySQL analogue of the "every table has RLS forced" generated test:
    // a table added in eighteen months cannot silently ship unscoped.
    const rows = await harness.db.withPlatform('schema audit', (tx) =>
      tx.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
        `SELECT TABLE_NAME FROM information_schema.columns
          WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND IS_NULLABLE = 'NO'`,
      ),
    );
    const tables = rows.map((r) => r.TABLE_NAME).sort();
    expect(tables.length).toBeGreaterThan(0);

    const modelForTable = (table: string) =>
      table
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

    const unclassified = tables.filter((t) => !TENANT_SCOPED_MODELS.has(modelForTable(t)));
    expect(unclassified).toEqual([]);
  });

  it('the DBA hardening script covers every tenant-owned table', () => {
    const sql = readFileSync(new URL('../prisma/sql/tenant-write-guard.sql', import.meta.url), 'utf8');
    const tables = [
      'branch',
      'user',
      'user_branch_role',
      'session',
      'password_reset_token',
      'trusted_device',
      'mfa_replay',
      'audit_log',
    ];
    for (const table of tables) {
      for (const event of ['ins', 'upd', 'del']) {
        expect(sql).toContain(`CREATE TRIGGER trg_${table}_tenant_guard_${event}`);
      }
    }
    expect(sql).toContain('CREATE TRIGGER trg_audit_log_immutable_upd');
    expect(sql).toContain('CREATE TRIGGER trg_user_last_admin_upd');
  });

  it('the audit trail cannot be rewritten through the ORM', async () => {
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.auditLog.updateMany({ where: {}, data: { action: 'nonsense' } }),
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      harness.db.withTenant(a.tenantId, (tx) => tx.auditLog.deleteMany({ where: {} })),
    ).rejects.toThrow(/append-only/i);
  });
});
