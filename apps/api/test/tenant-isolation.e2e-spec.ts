import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { Role, UserStatus } from '../src/generated/prisma/enums.js';
import { newId } from '../src/shared/ids/uuid.js';
import { TENANT_SCOPED_MODELS } from '../src/shared/prisma/tenant-scope.js';
import { RLS_EXEMPT_TABLES, RLS_PROTECTED_TABLES } from '../src/shared/prisma/prisma.service.js';

const API = '/api/v1';

/**
 * The isolation suite from documents/planning/03-multi-tenancy.md, run against
 * a real PostgreSQL database with row-level security in force.
 *
 * The tests that matter most are the ones that go around the application: raw
 * SQL with no tenant filter, and a write that names another tenant. Layer one
 * (the Prisma extension) cannot see those. Layer two has to.
 */
describe('Tenant isolation (PostgreSQL, row-level security in force)', () => {
  const harness = new Harness();
  let a: Fixture;
  let b: Fixture;
  let cookieA: string;

  beforeAll(async () => {
    await harness.start();
    a = await harness.seedTenant('iso-a');
    b = await harness.seedTenant('iso-b');

    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: a.frontdesk.email, password: DEFAULT_PASSWORD })
      .expect(200);
    cookieA = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
  });

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------- layer 1: the extension

  it('TEN-T-01: a query in tenant A never returns tenant B rows', async () => {
    const users = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.findMany({ select: { id: true, tenantId: true } }),
    );
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => u.tenantId === a.tenantId)).toBe(true);
    expect(users.some((u) => u.id === b.admin.id)).toBe(false);
  });

  it("TEN-T-02: reading tenant B's user by its real id, from tenant A, finds nothing", async () => {
    expect(
      await harness.db.withTenant(a.tenantId, (tx) => tx.user.findFirst({ where: { id: b.admin.id } })),
    ).toBeNull();
    expect(
      await harness.db.withTenant(a.tenantId, (tx) => tx.user.findUnique({ where: { id: b.admin.id } })),
    ).toBeNull();
  });

  it("TEN-T-03: updating tenant B's user from tenant A changes nothing", async () => {
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

  it('TEN-T-04: a write carrying another tenant id is refused before the database', async () => {
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
      harness.db.withTenant(a.tenantId, (tx) => tx.user.findMany({ where: { tenantId: b.tenantId } })),
    ).rejects.toThrow(/another tenant/i);
  });

  it('a query with no scope open is refused, rather than returning everything', async () => {
    await expect(harness.db.raw.user.findMany({})).rejects.toThrow(/no tenant scope/i);
  });

  // ---------------------------------------- layer 2: row-level security

  it('raw SQL that forgets the tenant filter still sees only one tenant', async () => {
    // This is the case layer one cannot catch, and the reason for PostgreSQL.
    const rows = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ tenant_id: string }>>('SELECT id, tenant_id FROM "user"'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);

    const branches = await harness.db.withTenant(a.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ tenant_id: string }>>('SELECT id, tenant_id FROM branch'),
    );
    expect(branches.every((r) => r.tenant_id === a.tenantId)).toBe(true);
  });

  it('TEN-T-04: raw SQL inserting another tenant’s row is rejected by the database', async () => {
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO branch (id, tenant_id, code, name, operating_hours, settings, status, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'XX', 'Smuggled', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', now(), now())`,
          newId(),
          b.tenantId,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('TEN-T-05: with app.tenant_id unset, tenant tables return nothing and reject inserts (TEN-R-04)', async () => {
    await harness.db.raw.$transaction(async (tx) => {
      // No set_config at all: this is what a forgotten scope looks like.
      const branches = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM branch',
      );
      expect(branches[0]?.n).toBe(0);

      const users = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        'SELECT count(*)::int AS n FROM "user"',
      );
      expect(users[0]?.n).toBe(0);

      await expect(
        tx.$executeRawUnsafe(
          `INSERT INTO branch (id, tenant_id, code, name, operating_hours, settings, status, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'ZZ', 'Unscoped', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', now(), now())`,
          newId(),
          a.tenantId,
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('the authentication bypass does not open the branch, role or audit tables', async () => {
    // Platform scope exists so login can find a session before it knows the
    // tenant. It deliberately does not reach the tables below.
    const seen = await harness.db.withPlatform('isolation probe', async (tx) => ({
      branches: await tx.branch.count({}),
      roles: await tx.userBranchRole.count({}),
      audit: await tx.auditLog.count({}),
      users: await tx.user.count({}),
    }));
    expect(seen.branches).toBe(0);
    expect(seen.roles).toBe(0);
    expect(seen.audit).toBe(0);
    // Users are reachable, because login has to resolve an email address.
    expect(seen.users).toBeGreaterThan(0);
  });

  it('the audit trail cannot be rewritten, through the ORM or around it', async () => {
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.auditLog.updateMany({ where: {}, data: { action: 'nonsense' } }),
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE audit_log SET action = 'nonsense'`),
      ),
    ).rejects.toThrow(/AUDIT_IMMUTABLE/i);

    await expect(
      harness.db.withTenant(a.tenantId, (tx) => tx.$executeRawUnsafe('DELETE FROM audit_log')),
    ).rejects.toThrow(/AUDIT_IMMUTABLE/i);
  });

  it('the database refuses to leave a tenant without an active administrator', async () => {
    // Going around the service entirely, which is what the trigger is for.
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "user" SET status = 'DISABLED' WHERE id = $1::uuid`, a.admin.id),
      ),
    ).rejects.toThrow(/LAST_ADMIN/i);

    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM user_branch_role WHERE user_id = $1::uuid AND role = 'ADMIN'`,
          a.admin.id,
        ),
      ),
    ).rejects.toThrow(/LAST_ADMIN/i);
  });

  it('addresses that differ only by case cannot both exist', async () => {
    const email = `Mixed-${newId().slice(-8)}@Test.Local`;
    await harness.db.withTenant(a.tenantId, (tx) =>
      tx.user.create({
        data: {
          id: newId(),
          tenantId: a.tenantId,
          email: email.toLowerCase(),
          name: 'Mixed Case',
          status: UserStatus.ACTIVE,
        },
      }),
    );
    await expect(
      harness.db.withTenant(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "user" (id, tenant_id, email, name, status, failed_attempts, mfa_enabled, permission_version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, 'Shouty', 'ACTIVE', 0, false, 1, now(), now())`,
          newId(),
          a.tenantId,
          email.toUpperCase(),
        ),
      ),
    ).rejects.toThrow(/user_tenant_email_lower_key|duplicate key/i);
  });

  // ------------------------------------------------------- the API surface

  it('TEN-T-08: the API refuses cross-tenant identifiers, including a branch switch', async () => {
    const otherUser = await request(harness.server)
      .get(`${API}/users/${b.admin.id}`)
      .set('Cookie', cookieA);
    // FRONTDESK lacks admin.users, so authorisation answers first.
    expect(otherUser.status).toBe(403);

    const switchAway = await request(harness.server)
      .put(`${API}/auth/me/branch`)
      .set('Cookie', cookieA)
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

  // --------------------------------------------------- the generated test

  it('TEN-T-06: every tenant-owned table has row-level security enabled and forced', async () => {
    // TEN-R-02, checked against the live schema: a table added in eighteen
    // months cannot silently ship unprotected.
    const status = await harness.app.get(
      (await import('../src/shared/prisma/prisma.service.js')).PrismaService,
    ).readRlsStatus();

    expect(status.unprotected).toEqual([]);
    expect(status.unexpected).toEqual([]);
    expect(status.protected.sort()).toEqual([...RLS_PROTECTED_TABLES].sort());
  });

  it('TEN-T-07: the application role cannot bypass row-level security (TEN-R-03)', async () => {
    const { PrismaService } = await import('../src/shared/prisma/prisma.service.js');
    const status = await harness.app.get(PrismaService).readRlsStatus();
    expect(status.role.bypassRls).toBe(false);
    expect(status.role.superuser).toBe(false);
  });

  it('every model is classified, and every exemption is documented', async () => {
    const tables = await harness.db.withPlatform('schema audit', (tx) =>
      tx.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'tenant_id' AND is_nullable = 'NO'`,
      ),
    );
    const names = tables.map((t) => t.table_name).sort();
    expect(names.length).toBeGreaterThan(0);

    const modelForTable = (table: string) =>
      table
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

    expect(names.filter((t) => !TENANT_SCOPED_MODELS.has(modelForTable(t)))).toEqual([]);
    // login_attempt carries a nullable tenant_id on purpose; it is the one
    // exemption, and it is written down.
    expect(Object.keys(RLS_EXEMPT_TABLES)).toContain('login_attempt');
  });
});
