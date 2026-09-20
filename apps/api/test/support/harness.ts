import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { TOTP, Secret } from 'otpauth';
import { AppModule } from '../../src/app.module.js';
import { ClinicalProbeModule } from './clinical-probe.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { DbService } from '../../src/shared/prisma/db.service.js';
import { PasswordService } from '../../src/modules/identity/services/password.service.js';
import { newId } from '../../src/shared/ids/uuid.js';
import {
  BranchStatus,
  Role,
  TenantStatus,
  UserStatus,
} from '../../src/generated/prisma/enums.js';

/**
 * Integration tests run against the real MySQL database named by DATABASE_URL.
 *
 * They never truncate anything: each run creates its own tenant with a random
 * slug and deletes exactly what it made. That way the suite is safe to point at
 * a shared development database.
 */

export type SeededUser = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export type Fixture = {
  tenantId: string;
  slug: string;
  branchAId: string;
  branchBId: string;
  admin: SeededUser;
  doctor: SeededUser;
  frontdesk: SeededUser;
};

export const DEFAULT_PASSWORD = 'unremarkable-orchid-canopy-8821';

export class Harness {
  app!: INestApplication;
  db!: DbService;
  passwords!: PasswordService;
  private readonly createdTenantIds: string[] = [];
  private readonly createdEmails: string[] = [];

  static env(overrides: Record<string, string> = {}): void {
    process.env['NODE_ENV'] = 'test';
    process.env['BREACH_CHECK_ENABLED'] = 'false';
    process.env['MAIL_TRANSPORT'] = 'noop';
    // Argon2 at production cost makes a 40-test suite take minutes; the
    // algorithm and the code path are identical, only the work factor differs.
    process.env['ARGON2_MEMORY_KIB'] = '8192';
    process.env['ARGON2_ITERATIONS'] = '1';
    // Every request in the suite comes from 127.0.0.1, so the per-IP limit
    // would fire across unrelated tests. Per-email limits stay at their real
    // values, which is what the acceptance tests care about.
    process.env['LOGIN_MAX_FAILURES_PER_IP'] = '10000';
    // CI installs the DBA hardening script and sets this to `require`, so the
    // suite also proves the triggers do not get in the way of normal work.
    process.env['DB_GUARD_MODE'] ??= 'off';
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  }

  async start(envOverrides: Record<string, string> = {}): Promise<void> {
    Harness.env(envOverrides);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, ClinicalProbeModule],
    }).compile();
    this.app = moduleRef.createNestApplication();
    configureApp(this.app);
    await this.app.init();
    this.db = this.app.get(DbService);
    this.passwords = this.app.get(PasswordService);
  }

  async stop(): Promise<void> {
    await this.cleanup();
    await this.app?.close();
  }

  get server() {
    return this.app.getHttpServer();
  }

  /** One tenant, two branches, an ADMIN, a DOCTOR and a FRONTDESK. */
  async seedTenant(label: string): Promise<Fixture> {
    const suffix = newId().slice(-12);
    const slug = `t-${label}-${suffix}`.toLowerCase().slice(0, 60);
    const tenantId = newId();
    const branchAId = newId();
    const branchBId = newId();
    const hash = await this.passwords.hash(DEFAULT_PASSWORD);

    const users: Record<string, SeededUser> = {
      admin: { id: newId(), email: `admin-${suffix}@test.local`, password: DEFAULT_PASSWORD, name: 'Admin Ali' },
      doctor: { id: newId(), email: `doc-${suffix}@test.local`, password: DEFAULT_PASSWORD, name: 'Doctor Devi' },
      frontdesk: { id: newId(), email: `front-${suffix}@test.local`, password: DEFAULT_PASSWORD, name: 'Front Faiz' },
    };

    await this.db.withPlatform('test seed', async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, name: `Test ${label}`, slug, status: TenantStatus.ACTIVE, settings: {}, modules: {} },
      });
      for (const [id, code, name] of [
        [branchAId, 'TA', 'Branch A'],
        [branchBId, 'TB', 'Branch B'],
      ] as const) {
        await tx.branch.create({
          data: {
            id,
            tenantId,
            code,
            name,
            operatingHours: {},
            settings: {},
            status: BranchStatus.ACTIVE,
          },
        });
      }

      for (const [key, user] of Object.entries(users)) {
        await tx.user.create({
          data: {
            id: user.id,
            tenantId,
            email: user.email,
            name: user.name,
            passwordHash: hash,
            status: UserStatus.ACTIVE,
            defaultBranchId: branchAId,
          },
        });
        const role = key === 'admin' ? Role.ADMIN : key === 'doctor' ? Role.DOCTOR : Role.FRONTDESK;
        await tx.userBranchRole.create({
          data: { id: newId(), tenantId, userId: user.id, branchId: branchAId, role },
        });
      }
    });

    this.createdTenantIds.push(tenantId);
    this.createdEmails.push(...Object.values(users).map((u) => u.email));

    return {
      tenantId,
      slug,
      branchAId,
      branchBId,
      admin: users['admin']!,
      doctor: users['doctor']!,
      frontdesk: users['frontdesk']!,
    };
  }

  /** Adds a user with an arbitrary set of roles. */
  async addUser(
    fixture: Fixture,
    input: { name: string; roles: Array<{ branchId: string; role: Role }>; status?: UserStatus },
  ): Promise<SeededUser> {
    const id = newId();
    const email = `u-${id.slice(-12)}@test.local`;
    const hash = await this.passwords.hash(DEFAULT_PASSWORD);

    await this.db.withPlatform('test seed user', async (tx) => {
      await tx.user.create({
        data: {
          id,
          tenantId: fixture.tenantId,
          email,
          name: input.name,
          passwordHash: hash,
          status: input.status ?? UserStatus.ACTIVE,
          defaultBranchId: input.roles[0]?.branchId ?? fixture.branchAId,
        },
      });
      for (const r of input.roles) {
        await tx.userBranchRole.create({
          data: {
            id: newId(),
            tenantId: fixture.tenantId,
            userId: id,
            branchId: r.branchId,
            role: r.role,
          },
        });
      }
    });

    this.createdEmails.push(email);
    return { id, email, password: DEFAULT_PASSWORD, name: input.name };
  }

  async cleanup(): Promise<void> {
    if (this.createdTenantIds.length === 0) return;
    const tenantIds = [...this.createdTenantIds];
    const emails = [...this.createdEmails];

    await this.db.withPlatform('test cleanup', async (tx) => {
      const where = { tenantId: { in: tenantIds } };
      // The audit trail is append-only through the ORM by design (AUD-R-01), so
      // the suite removes its own rows with raw SQL. On a database where the
      // DBA hardening script is installed this is refused, and the rows are
      // simply left behind — which is the correct behaviour to leave in place.
      try {
        const list = tenantIds.map(() => '?').join(',');
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_log WHERE tenant_id IN (${list})`,
          ...tenantIds,
        );
      } catch {
        /* audit immutability triggers are installed; nothing to do */
      }
      await tx.session.deleteMany({ where });
      await tx.passwordResetToken.deleteMany({ where });
      await tx.trustedDevice.deleteMany({ where });
      await tx.mfaReplay.deleteMany({ where });
      await tx.userBranchRole.deleteMany({ where });
      await tx.loginAttempt.deleteMany({ where: { emailKey: { in: emails } } });
      await tx.user.deleteMany({ where });
      await tx.branch.deleteMany({ where });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    });

    this.createdTenantIds.length = 0;
    this.createdEmails.length = 0;
  }
}

export function totpFor(secret: string, offsetSteps = 0): string {
  const totp = new TOTP({
    issuer: 'ClinicCare',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

/** Extracts the session cookie value from a set-cookie header list. */
export function sessionCookie(setCookie: string[] | undefined): string | undefined {
  return setCookie?.find((c) => c.startsWith('cc_session='));
}
