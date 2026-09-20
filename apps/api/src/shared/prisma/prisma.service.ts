import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { tenantScopeExtension } from './tenant-scope.js';

export function parseMysqlUrl(raw: string) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

export function createPrismaClient(config: AppConfig) {
  const conn = parseMysqlUrl(config.database.url);
  const adapter = new PrismaMariaDb({
    ...conn,
    connectionLimit: config.database.poolSize,
    // Everything is stored and compared in UTC; display-time zones are a
    // presentation concern (documents/planning/04-data-model.md).
    timezone: 'Z',
    initSql: "SET time_zone='+00:00', sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'",
    // Keep transactions short: an auth request should never wait on a connection.
    acquireTimeout: 10_000,
  });

  return new PrismaClient({
    adapter,
    log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
  }).$extends(tenantScopeExtension);
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

export type Tx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

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

  /**
   * The database-level write guards (see prisma/sql/tenant-write-guard.sql) are
   * installed by a DBA, because creating triggers needs privileges the
   * application account deliberately does not have. Boot loudly if they are
   * missing so "layer 2 is on" is never an assumption.
   */
  async assertDatabaseGuards(): Promise<{ installed: number; expected: number }> {
    const mode = this.config.database.guardMode;
    const rows = await this.client.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      "SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name LIKE 'trg_%_tenant_guard_%'",
    );
    const installed = Number(rows[0]?.n ?? 0);
    const expected = 24; // 8 tenant-owned tables x insert/update/delete

    if (mode === 'off') return { installed, expected };

    if (installed < expected) {
      const message =
        `Database tenant write guards are missing (${installed}/${expected} triggers). ` +
        'Install prisma/sql/tenant-write-guard.sql as a privileged user, or set ' +
        'DB_GUARD_MODE=off to accept application-only isolation.';
      if (mode === 'require') throw new Error(message);
      this.logger.warn(message);
    }
    return { installed, expected };
  }
}
