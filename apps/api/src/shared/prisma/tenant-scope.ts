import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantScopeError } from '../errors/domain-errors.js';

/**
 * Tenant isolation, layer 1.
 *
 * This extension injects `tenant_id` into every query against a tenant-owned
 * model and refuses to run one at all outside an explicit scope. Layer 2 is
 * PostgreSQL row-level security, applied by the `*_row_level_security`
 * migration, which catches anything this misses — including raw SQL.
 *
 * Two layers, because either alone will eventually fail
 * (documents/planning/03-multi-tenancy.md).
 *
 * Nothing in this file trusts request input: the scope is opened by the auth
 * guard from the session, and by nothing else.
 */

/** Models that carry `tenant_id` and must never be queried unscoped. */
export const TENANT_SCOPED_MODELS = new Set([
  'Branch',
  'User',
  'UserBranchRole',
  'Session',
  'PasswordResetToken',
  'TrustedDevice',
  'MfaReplay',
  'AuditLog',
]);

/**
 * Models that are not tenant-owned. `Tenant` is the tenant (it is filtered by
 * primary key instead); `LoginAttempt` records attempts that may never resolve
 * to a tenant at all.
 */
export const PLATFORM_MODELS = new Set(['Tenant', 'LoginAttempt']);

const READ_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const WHERE_WRITE_OPERATIONS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Append-only: the audit trail may only ever be inserted into (AUD-R-01). */
const APPEND_ONLY_MODELS = new Set(['AuditLog']);

export type TenantScope =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'platform'; readonly reason: string };

export type ScopeStore = {
  scope: TenantScope;
  /** The transaction client for the current unit of work. */
  tx?: unknown;
  /** Domain events published during the unit of work, emitted after commit. */
  pendingEvents: Array<() => void>;
  /**
   * TEN-N-04: values resolved once per unit of work. It lives and dies with
   * the transaction, so a change made by one request is visible to the next
   * one without any invalidation to get wrong.
   */
  cache?: Map<string, unknown>;
  /** What this transaction is doing, named for the log if it times out. */
  label?: string;
};

export const scopeStorage = new AsyncLocalStorage<ScopeStore>();

export function currentStore(): ScopeStore | undefined {
  return scopeStorage.getStore();
}

/**
 * TEN-F-17: slow work must not happen inside a tenant transaction.
 *
 * A transaction holds a connection and, often, row locks. Rendering a PDF or
 * waiting on someone else's HTTP endpoint inside one turns a 20 ms request
 * into a 2 s request that is also blocking other people. Gather what is
 * needed, leave the transaction, then do the slow thing — `afterCommit` exists
 * for exactly this.
 *
 * The lint rule catches the obvious shapes; this catches the rest, at the one
 * place that knows for certain.
 */
export function assertOutsideScope(what: string): void {
  const store = scopeStorage.getStore();
  if (store?.tx) {
    throw new TenantScopeError(
      `${what} was attempted inside an open database transaction (${store.label ?? 'unnamed'}). ` +
        'Slow work belongs outside: use DbService.afterCommit(), or do it before the scope opens.',
    );
  }
}

export function currentScope(): TenantScope | undefined {
  return scopeStorage.getStore()?.scope;
}

export function currentTenantId(): string | undefined {
  const scope = currentScope();
  return scope?.kind === 'tenant' ? scope.tenantId : undefined;
}

/**
 * The tenant id of the open scope. Prisma's generated types require
 * `tenant_id` on every create, so writes name it explicitly, the extension
 * checks it agrees with the scope, and the row-level security WITH CHECK
 * clause refuses it at the database if both are somehow wrong.
 */
export function requireTenantId(): string {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new TenantScopeError('This write needs an open tenant scope; none is active.');
  }
  return tenantId;
}

function mergeWhere(where: unknown, tenantId: string, model: string, operation: string): object {
  const current = (where ?? {}) as Record<string, unknown>;
  const existing = current['tenantId'];
  if (existing !== undefined && existing !== tenantId) {
    throw new TenantScopeError(
      `Refused ${model}.${operation}: query filters tenant_id of another tenant.`,
    );
  }
  return { ...current, tenantId };
}

function applyTenantToData(
  data: unknown,
  tenantId: string,
  model: string,
  operation: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => applyTenantToData(row, tenantId, model, operation));
  }
  const row = (data ?? {}) as Record<string, unknown>;
  const existing = row['tenantId'];
  if (existing !== undefined && existing !== tenantId) {
    throw new TenantScopeError(
      `Refused ${model}.${operation}: payload carries tenant_id of another tenant.`,
    );
  }
  return { ...row, tenantId };
}

function assertNoTenantChange(data: unknown, tenantId: string, model: string): void {
  const row = (data ?? {}) as Record<string, unknown>;
  const next = row['tenantId'];
  if (next !== undefined && next !== tenantId) {
    throw new TenantScopeError(`Refused ${model}.update: tenant_id may not be reassigned.`);
  }
}

type OperationArgs = {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * The extension body. Exported separately so it can be unit-tested without a
 * database connection.
 */
export async function scopedOperation({ model, operation, args, query }: OperationArgs) {
  // Raw queries and `$`-level operations have no model; they are the documented
  // escape hatch and are reviewed by hand.
  if (!model) return query(args);

  const store = scopeStorage.getStore();

  if (APPEND_ONLY_MODELS.has(model) && (WHERE_WRITE_OPERATIONS.has(operation) || operation === 'upsert')) {
    throw new TenantScopeError(`${model} is append-only: ${operation} is not permitted.`);
  }

  if (!store) {
    throw new TenantScopeError(
      `Refused ${model}.${operation}: no tenant scope is open. Wrap the work in ` +
        'DbService.withTenant() or, deliberately, withPlatform().',
    );
  }

  if (store.scope.kind === 'platform') return query(args);

  const tenantId = store.scope.tenantId;

  if (PLATFORM_MODELS.has(model)) {
    // The tenant row itself: constrain by primary key so a tenant-scoped unit of
    // work can never read or write another tenant's record.
    if (model === 'Tenant') {
      if (READ_OPERATIONS.has(operation) || WHERE_WRITE_OPERATIONS.has(operation)) {
        const where = (args['where'] ?? {}) as Record<string, unknown>;
        if (where['id'] !== undefined && where['id'] !== tenantId) {
          throw new TenantScopeError('Refused Tenant access outside the current tenant.');
        }
        return query({ ...args, where: { ...where, id: tenantId } });
      }
      if (CREATE_OPERATIONS.has(operation)) {
        throw new TenantScopeError('Tenants are created in platform scope only.');
      }
    }
    return query(args);
  }

  if (!TENANT_SCOPED_MODELS.has(model)) {
    throw new TenantScopeError(
      `Model ${model} is not classified as tenant-scoped or platform. Add it to ` +
        'TENANT_SCOPED_MODELS or PLATFORM_MODELS in tenant-scope.ts.',
    );
  }

  if (READ_OPERATIONS.has(operation) || WHERE_WRITE_OPERATIONS.has(operation)) {
    const next: Record<string, unknown> = {
      ...args,
      where: mergeWhere(args['where'], tenantId, model, operation),
    };
    if (operation === 'update' || operation === 'updateMany') {
      assertNoTenantChange(args['data'], tenantId, model);
    }
    return query(next);
  }

  if (CREATE_OPERATIONS.has(operation)) {
    return query({ ...args, data: applyTenantToData(args['data'], tenantId, model, operation) });
  }

  if (operation === 'upsert') {
    return query({
      ...args,
      where: mergeWhere(args['where'], tenantId, model, operation),
      create: applyTenantToData(args['create'], tenantId, model, operation),
    });
  }

  throw new TenantScopeError(`Unhandled Prisma operation ${model}.${operation} in tenant scope.`);
}

export const tenantScopeExtension = {
  name: 'cliniccare-tenant-scope',
  query: {
    $allModels: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $allOperations: (params: any) => scopedOperation(params),
    },
  },
};
