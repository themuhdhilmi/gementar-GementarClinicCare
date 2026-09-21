import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { tenantScopeExtension } from './tenant-scope.js';

/** Tables that must have row-level security enabled and forced. */
export const RLS_PROTECTED_TABLES = [
  'tenant',
  'branch',
  'user',
  'user_branch_role',
  'session',
  'password_reset_token',
  'trusted_device',
  'mfa_replay',
  'audit_log',
  'patient',
  'patient_contact',
  'patient_consent',
  'patient_allergy',
  'patient_condition',
  'patient_document',
  'patient_import_batch',
  'patient_recent',
  'mrn_sequence',
  'encounter',
  'encounter_event',
  'branch_room',
  'queue_sequence',
  'display_token',
  'triage',
  'triage_amendment',
  'consultation',
  'diagnosis',
  'consultation_amendment',
  'consultation_attachment',
  'clinical_template',
  'quick_phrase',
  'product',
  'product_category',
  'product_price_history',
  'product_branch_setting',
] as const;

/**
 * Tables deliberately left without row-level security, and why. The isolation
 * suite asserts this list rather than tolerating whatever it finds.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  login_attempt:
    'An attempt may never resolve to a tenant, and the rate limiter counts attempts before it knows who is knocking. No clinical data.',
  _prisma_migrations: 'Migration bookkeeping, written by the migration tool.',
};

export function createPrismaClient(config: AppConfig) {
  const adapter = new PrismaPg(
    {
      connectionString: config.database.url,
      max: config.database.poolSize,
      // Keep transactions short: an auth request should never wait on a connection.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: 'cliniccare-api',
    },
    {
      onPoolError: (error) => new Logger('PrismaPool').error(error.message),
      onConnectionError: (error) => new Logger('PrismaConnection').warn(error.message),
    },
  );

  return new PrismaClient({
    adapter,
    log: config.database.logQueries
      ? ['query', 'warn', 'error']
      : config.nodeEnv === 'development'
        ? ['warn', 'error']
        : ['error'],
  }).$extends(tenantScopeExtension);
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

export type Tx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export type RlsStatus = {
  protected: string[];
  unprotected: string[];
  unexpected: string[];
  role: { name: string; superuser: boolean; bypassRls: boolean; ownsTables: boolean };
};

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: ExtendedPrismaClient;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = createPrismaClient(config);
  }

  async onModuleInit(): Promise<void> {
    await this.client.$queryRawUnsafe('SELECT 1');
    await this.assertDatabaseGuards();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async readRlsStatus(): Promise<RlsStatus> {
    // `p` as well as `r`: `audit_log` is partitioned by month (AUD-F-14)
    // and a partitioned parent is relkind `p`. Its own partitions are
    // excluded — they are storage for a table that is already on this
    // list, they each carry the same policy, and listing them would mean
    // this check grew a new row every month forever.
    const tables = await this.client.$queryRawUnsafe<
      Array<{ relname: string; rls: boolean; forced: boolean }>
    >(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition`,
    );
    const [role] = await this.client.$queryRawUnsafe<
      Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
    >(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

    // Owning the tables means being able to drop a policy (IAM-Q-05). Policies
    // still apply, because they are FORCEd, but the account facing the
    // internet should not be able to remove them.
    const [owned] = await this.client.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT count(*) AS n FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'
          AND pg_get_userbyid(c.relowner) = current_user`,
    );

    const byName = new Map(tables.map((t) => [t.relname, t]));
    const protectedTables: string[] = [];
    const unprotected: string[] = [];

    for (const table of RLS_PROTECTED_TABLES) {
      const row = byName.get(table);
      if (row?.rls && row.forced) protectedTables.push(table);
      else unprotected.push(table);
    }

    // A table nobody classified: it exists, it is not exempt, and it has no
    // row-level security. That is how a new table ships unprotected.
    const unexpected = tables
      .filter((t) => !RLS_PROTECTED_TABLES.includes(t.relname as never))
      .filter((t) => !(t.relname in RLS_EXEMPT_TABLES))
      .filter((t) => !(t.rls && t.forced))
      .map((t) => t.relname);

    return {
      protected: protectedTables,
      unprotected,
      unexpected,
      role: {
        name: role?.rolname ?? 'unknown',
        superuser: Boolean(role?.rolsuper),
        bypassRls: Boolean(role?.rolbypassrls),
        ownsTables: Number(owned?.n ?? 0) > 0,
      },
    };
  }

  /**
   * TEN-R-02 and TEN-R-03, checked at boot rather than assumed.
   *
   * Row-level security that is switched off, or an application role that
   * bypasses it, looks exactly like row-level security that works — right up
   * until the day two clinics share a database. So the process says which it
   * is, every time it starts, and in `require` mode refuses to serve.
   */
  async assertDatabaseGuards(): Promise<RlsStatus> {
    const status = await this.readRlsStatus();
    const mode = this.config.database.guardMode;
    if (mode === 'off') return status;

    const problems: string[] = [];
    if (status.unprotected.length > 0) {
      problems.push(
        `row-level security is not enabled and forced on: ${status.unprotected.join(', ')}`,
      );
    }
    if (status.unexpected.length > 0) {
      problems.push(
        `these tables have no row-level security and are not on the documented exemption list: ${status.unexpected.join(', ')}`,
      );
    }
    if (status.role.bypassRls) {
      problems.push(`the database role ${status.role.name} has BYPASSRLS, which disables isolation`);
    }
    if (status.role.superuser) {
      problems.push(`the database role ${status.role.name} is a superuser, which bypasses isolation`);
    }

    // Not a problem, because FORCE means the policies apply to the owner too.
    // It is worth saying out loud on every boot until it is done (IAM-Q-05).
    if (status.role.ownsTables) {
      this.logger.warn(
        `The application connects as ${status.role.name}, which owns its tables and can ` +
          'therefore drop a policy. Row-level security is FORCEd so isolation holds; ' +
          'before go-live, run prisma/sql/app-role.sql and connect as the unprivileged role.',
      );
    }

    if (problems.length === 0) return status;

    const message =
      `Tenant isolation is not fully in place:\n  - ${problems.join('\n  - ')}\n` +
      'Run `prisma migrate deploy`, and connect as an unprivileged role ' +
      '(prisma/sql/app-role.sql). Set DB_GUARD_MODE=off to accept application-only isolation.';

    if (mode === 'require') throw new Error(message);
    this.logger.warn(message);
    return status;
  }
}
