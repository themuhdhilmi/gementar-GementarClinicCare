import { describe, expect, it } from 'vitest';
import { scopeStorage, scopedOperation, type ScopeStore } from './tenant-scope.js';

const TENANT = '01a00000-0000-7000-8000-000000000001';
const OTHER = '01a00000-0000-7000-8000-000000000002';

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const store: ScopeStore = { scope: { kind: 'tenant', tenantId: TENANT }, pendingEvents: [] };
  return scopeStorage.run(store, fn);
}

function inPlatform<T>(fn: () => Promise<T>): Promise<T> {
  const store: ScopeStore = { scope: { kind: 'platform', reason: 'test' }, pendingEvents: [] };
  return scopeStorage.run(store, fn);
}

/** Captures what the extension would have passed to Prisma. */
function capture() {
  const seen: unknown[] = [];
  return {
    seen,
    query: async (args: unknown) => {
      seen.push(args);
      return 'result';
    },
  };
}

describe('tenant scoping extension', () => {
  it('adds the tenant filter to reads', async () => {
    const { seen, query } = capture();
    await inTenant(() =>
      scopedOperation({ model: 'User', operation: 'findMany', args: { where: { name: 'a' } }, query }),
    );
    expect(seen[0]).toEqual({ where: { name: 'a', tenantId: TENANT } });
  });

  it('adds the tenant filter to a read with no arguments at all', async () => {
    const { seen, query } = capture();
    await inTenant(() => scopedOperation({ model: 'Session', operation: 'count', args: {}, query }));
    expect(seen[0]).toEqual({ where: { tenantId: TENANT } });
  });

  it('stamps the tenant onto creates', async () => {
    const { seen, query } = capture();
    await inTenant(() =>
      scopedOperation({ model: 'User', operation: 'create', args: { data: { name: 'a' } }, query }),
    );
    expect(seen[0]).toEqual({ data: { name: 'a', tenantId: TENANT } });

    const many = capture();
    await inTenant(() =>
      scopedOperation({
        model: 'UserBranchRole',
        operation: 'createMany',
        args: { data: [{ role: 'NURSE' }, { role: 'DOCTOR' }] },
        query: many.query,
      }),
    );
    expect(many.seen[0]).toEqual({
      data: [
        { role: 'NURSE', tenantId: TENANT },
        { role: 'DOCTOR', tenantId: TENANT },
      ],
    });
  });

  it('refuses a filter or payload naming another tenant', async () => {
    const { query } = capture();
    await expect(
      inTenant(() =>
        scopedOperation({
          model: 'User',
          operation: 'findMany',
          args: { where: { tenantId: OTHER } },
          query,
        }),
      ),
    ).rejects.toThrow(/another tenant/i);

    await expect(
      inTenant(() =>
        scopedOperation({
          model: 'User',
          operation: 'create',
          args: { data: { tenantId: OTHER } },
          query,
        }),
      ),
    ).rejects.toThrow(/another tenant/i);
  });

  it('refuses any query on a tenant-owned model with no scope open', async () => {
    const { query } = capture();
    await expect(
      scopedOperation({ model: 'User', operation: 'findMany', args: {}, query }),
    ).rejects.toThrow(/no tenant scope/i);
  });

  it('lets platform scope through untouched', async () => {
    const { seen, query } = capture();
    await inPlatform(() =>
      scopedOperation({ model: 'User', operation: 'findMany', args: { where: { email: 'x' } }, query }),
    );
    expect(seen[0]).toEqual({ where: { email: 'x' } });
  });

  it('pins the tenant row itself by primary key', async () => {
    const { seen, query } = capture();
    await inTenant(() =>
      scopedOperation({ model: 'Tenant', operation: 'findFirst', args: {}, query }),
    );
    expect(seen[0]).toEqual({ where: { id: TENANT } });

    await expect(
      inTenant(() =>
        scopedOperation({
          model: 'Tenant',
          operation: 'findFirst',
          args: { where: { id: OTHER } },
          query,
        }),
      ),
    ).rejects.toThrow(/outside the current tenant/i);
  });

  it('lets platform-owned models through, since they are not tenant-owned', async () => {
    const { seen, query } = capture();
    await inTenant(() =>
      scopedOperation({
        model: 'LoginAttempt',
        operation: 'create',
        args: { data: { emailKey: 'a@b.test' } },
        query,
      }),
    );
    expect(seen[0]).toEqual({ data: { emailKey: 'a@b.test' } });
  });

  it('keeps the audit trail append-only', async () => {
    const { query } = capture();
    for (const operation of ['update', 'updateMany', 'delete', 'deleteMany', 'upsert']) {
      await expect(
        inTenant(() => scopedOperation({ model: 'AuditLog', operation, args: {}, query })),
      ).rejects.toThrow(/append-only/i);
    }
    const create = capture();
    await inTenant(() =>
      scopedOperation({ model: 'AuditLog', operation: 'create', args: { data: {} }, query: create.query }),
    );
    expect(create.seen[0]).toEqual({ data: { tenantId: TENANT } });
  });

  it('refuses a model nobody has classified', async () => {
    const { query } = capture();
    await expect(
      inTenant(() => scopedOperation({ model: 'Invoice', operation: 'findMany', args: {}, query })),
    ).rejects.toThrow(/not classified/i);
  });

  it('leaves raw queries alone', async () => {
    const { seen, query } = capture();
    await scopedOperation({ operation: '$queryRaw', args: { sql: 'SELECT 1' }, query });
    expect(seen[0]).toEqual({ sql: 'SELECT 1' });
  });
});
