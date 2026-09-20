import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { TenantScopeError } from '../errors/domain-errors.js';
import { PrismaService, type Tx } from './prisma.service.js';
import { scopeStorage, type ScopeStore, type TenantScope } from './tenant-scope.js';

export type { Tx };

type TxOptions = {
  timeoutMs?: number;
  maxWaitMs?: number;
  independent?: boolean;
  /** What the work is, for the log if it runs out of time (TEN-N-05). */
  label?: string;
};

/** Prisma's code for "the interactive transaction ran out of time". */
const TRANSACTION_TIMED_OUT = 'P2028';

/**
 * Every unit of work runs inside one transaction with the tenant fixed for its
 * whole duration, mirroring the `withTenant` pattern in
 * `documents/planning/03-multi-tenancy.md`.
 *
 * Two things happen on entry:
 *   1. an AsyncLocalStorage scope is opened, which the Prisma extension reads to
 *      inject `tenant_id` into every query;
 *   2. `app.tenant_id` is set on the transaction with `set_config(..., true)`,
 *      which every row-level security policy reads.
 *
 * `set_config` with `is_local = true` is scoped to the transaction and is undone
 * on commit or rollback, so a value can never leak onto the next request that
 * borrows the same pooled connection. Both are set explicitly on entry anyway.
 *
 * Do not do slow work inside a scope: no PDF rendering, no S3, no outbound HTTP.
 * Gather what you need, leave the transaction, then do the slow thing.
 */
@Injectable()
export class DbService {
  private readonly logger = new Logger(DbService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The unextended client. Only migrations, health checks and tests use it. */
  get raw() {
    return this.prisma.client;
  }

  /** The transaction for the current unit of work. Throws outside a scope. */
  tx(): Tx {
    const store = scopeStorage.getStore();
    if (!store?.tx) {
      throw new TenantScopeError(
        'No database scope is open. Wrap the work in withTenant() or withPlatform().',
      );
    }
    return store.tx as Tx;
  }

  get scope(): TenantScope | undefined {
    return scopeStorage.getStore()?.scope;
  }

  /** Queue work to run once the current transaction has committed. */
  afterCommit(fn: () => void): void {
    const store = scopeStorage.getStore();
    if (!store) {
      fn();
      return;
    }
    store.pendingEvents.push(fn);
  }

  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.run({ kind: 'tenant', tenantId }, fn, options);
  }

  /**
   * Something resolved once per unit of work (TEN-N-04).
   *
   * The cache is the transaction's, so it cannot outlive it: a setting changed
   * by one request is read fresh by the next. Outside a scope there is nothing
   * to cache against and the work simply runs.
   */
  async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const store = scopeStorage.getStore();
    if (!store) return fn();
    store.cache ??= new Map<string, unknown>();
    if (store.cache.has(key)) return store.cache.get(key) as T;
    const value = await fn();
    store.cache.set(key, value);
    return value;
  }

  /** Drops a cached value, for the request that has just changed it. */
  forget(key: string): void {
    scopeStorage.getStore()?.cache?.delete(key);
  }

  /**
   * Runs the work in a transaction of its own, even when one is already open.
   *
   * For the one case where a record has to outlive a failure: a rejected
   * verification code must be audited and counted even though the request
   * carrying it is about to roll back. Everything else should use
   * `withTenant`, because two open transactions touching the same rows can
   * deadlock. Keep the work here narrow and additive — inserts, not updates
   * to rows the caller is holding.
   */
  withTenantIndependently<T>(
    tenantId: string,
    reason: string,
    fn: (tx: Tx) => Promise<T>,
    options?: TxOptions,
  ): Promise<T> {
    this.logger.debug(`independent transaction: ${reason}`);
    return this.run({ kind: 'tenant', tenantId }, fn, { ...options, independent: true });
  }

  /**
   * The authentication lookup, in one transaction rather than two.
   *
   * A request has to find its session before it knows which tenant it belongs
   * to, and then read that tenant's data. Doing it as two transactions costs
   * an extra BEGIN and COMMIT on every single request — about a third of the
   * guard's latency budget (IAM-N-01). This opens one transaction in platform
   * scope and hands the caller a `becomeTenant` it must call before touching
   * anything tenant-owned; the switch closes the authentication bypass at the
   * same moment, so it cannot be left open by a forgetful caller.
   */
  async withAuthLookup<T>(
    fn: (tx: Tx, becomeTenant: (tenantId: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.withPlatform('authenticate a request', async (tx) => {
      const store = scopeStorage.getStore();
      const becomeTenant = async (tenantId: string) => {
        await tx.$executeRawUnsafe(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.auth_bypass', 'off', true)",
          tenantId,
        );
        if (store) store.scope = { kind: 'tenant', tenantId };
      };
      return fn(tx, becomeTenant);
    });
  }

  /**
   * Unscoped access. Legitimate uses are narrow and each one is named:
   * resolving a login before the tenant is known, the nightly cleanup job,
   * seeding, and tests. The reason is logged in development.
   */
  withPlatform<T>(reason: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.run({ kind: 'platform', reason }, fn, options);
  }

  private async run<T>(
    scope: TenantScope,
    fn: (tx: Tx) => Promise<T>,
    options?: TxOptions,
  ): Promise<T> {
    const existing = options?.independent ? undefined : scopeStorage.getStore();
    if (existing?.tx) {
      // Prisma transactions do not nest. Re-entering the *same* scope simply
      // joins the open transaction, which is what callers mean. Re-entering a
      // different one is a bug, and a dangerous one, so it stops here.
      const same =
        existing.scope.kind === 'tenant' && scope.kind === 'tenant'
          ? existing.scope.tenantId === scope.tenantId
          : existing.scope.kind === scope.kind;
      if (!same) {
        throw new TenantScopeError(
          `Refused to open a ${scope.kind} scope inside an open ${existing.scope.kind} scope.`,
        );
      }
      return fn(existing.tx as Tx);
    }

    const label =
      options?.label ?? (scope.kind === 'platform' ? scope.reason : `tenant ${scope.tenantId}`);
    const store: ScopeStore = { scope, pendingEvents: [], label };
    const timeout = options?.timeoutMs ?? this.config.database.transactionTimeoutMs;
    const startedAt = Date.now();

    const result = await scopeStorage.run(store, () =>
      this.prisma.client.$transaction(
        async (tx) => {
          store.tx = tx;
          if (scope.kind === 'tenant') {
            await tx.$executeRawUnsafe(
              "SELECT set_config('app.tenant_id', $1, true), set_config('app.auth_bypass', 'off', true)",
              scope.tenantId,
            );
          } else {
            // Platform scope opens the authentication tables, and only those:
            // branch, user_branch_role and audit_log have no bypass policy at
            // all, so they stay unreachable however this is called.
            await tx.$executeRawUnsafe(
              "SELECT set_config('app.tenant_id', '', true), set_config('app.auth_bypass', 'on', true)",
            );
          }
          try {
            return await fn(tx as unknown as Tx);
          } finally {
            store.tx = undefined;
          }
        },
        { timeout, maxWait: options?.maxWaitMs ?? 5_000 },
      ),
    ).catch((error: unknown) => {
      // TEN-N-05: a transaction that overran is a bug in the handler, not a
      // slow database, so the log has to say which handler it was.
      if ((error as { code?: string })?.code === TRANSACTION_TIMED_OUT) {
        this.logger.error(
          `${label} held a transaction for ${Date.now() - startedAt} ms and was aborted ` +
            `at the ${timeout} ms limit. Slow work does not belong inside a tenant scope: ` +
            'gather what you need, leave the transaction, then do it.',
        );
      }
      throw error;
    });

    for (const emit of store.pendingEvents) {
      try {
        emit();
      } catch (error) {
        this.logger.error('after-commit handler failed', error as Error);
      }
    }
    return result;
  }
}
