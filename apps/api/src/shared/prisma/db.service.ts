import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { TenantScopeError } from '../errors/domain-errors.js';
import { PrismaService, type Tx } from './prisma.service.js';
import { scopeStorage, type ScopeStore, type TenantScope } from './tenant-scope.js';

export type { Tx };

type TxOptions = { timeoutMs?: number; maxWaitMs?: number };

/**
 * Every unit of work runs inside one transaction with the tenant fixed for its
 * whole duration, mirroring the `withTenant` pattern in
 * `documents/planning/03-multi-tenancy.md`.
 *
 * Two things happen on entry:
 *   1. an AsyncLocalStorage scope is opened, which the Prisma extension reads to
 *      inject `tenant_id` into every query;
 *   2. `@app_tenant_id` is set on the connection, which the database-level write
 *      guards compare against (when a DBA has installed them).
 *
 * Both are set explicitly on every entry, so a stale value left on a pooled
 * connection by an earlier request can never be inherited.
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
    const existing = scopeStorage.getStore();
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

    const store: ScopeStore = { scope, pendingEvents: [] };

    const result = await scopeStorage.run(store, () =>
      this.prisma.client.$transaction(
        async (tx) => {
          store.tx = tx;
          if (scope.kind === 'tenant') {
            await tx.$executeRawUnsafe(
              'SET @app_tenant_id = ?, @app_tenant_guard_off = 0',
              scope.tenantId,
            );
          } else {
            await tx.$executeRawUnsafe('SET @app_tenant_id = NULL, @app_tenant_guard_off = 1');
          }
          try {
            return await fn(tx as unknown as Tx);
          } finally {
            store.tx = undefined;
          }
        },
        {
          timeout: options?.timeoutMs ?? 10_000,
          maxWait: options?.maxWaitMs ?? 5_000,
        },
      ),
    );

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
