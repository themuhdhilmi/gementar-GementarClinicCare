import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Integration tests run against the real PostgreSQL database named by
 * DATABASE_URL, with row-level security in force exactly as in production.
 *
 * They never truncate anything: each run creates its own tenant with a random
 * slug and deletes exactly what it made, so the suite is safe to point at a
 * shared development database.
 *
 * Audit rows are the exception. They are append-only at the database level, so
 * only an owner connection can remove them: set TEST_ADMIN_DATABASE_URL to have
 * the suite tidy up after itself completely, or leave it unset and accept that
 * test audit rows stay behind.
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
    // Uploads go to a scratch directory, never into the working tree.
    process.env['STORAGE_ROOT'] ??= join(tmpdir(), `cliniccare-test-storage-${process.pid}`);
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

  /** One tenant, two branches, an ADMIN, a DOCTOR and a RECEPTION user. */
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

    // The tenant row first, in platform scope; everything else inside the
    // tenant, because branch and role tables have no bypass policy at all.
    await this.db.withPlatform('test seed tenant', (tx) =>
      tx.tenant.create({
        data: {
          id: tenantId,
          name: `Test ${label}`,
          slug,
          status: TenantStatus.ACTIVE,
          settings: {},
          modules: {},
        },
      }),
    );

    await this.db.withTenant(tenantId, async (tx) => {
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
        const role = key === 'admin' ? Role.ADMIN : key === 'doctor' ? Role.DOCTOR : Role.RECEPTION;
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

    await this.db.withTenant(fixture.tenantId, async (tx) => {
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

  /**
   * Removes exactly what this run created.
   *
   * Cleanup is an administrative act, not an application one: the audit trail
   * is append-only and the last-administrator trigger exists precisely to stop
   * the application doing this. So it runs on one connection as the table
   * owner, with those triggers briefly disabled, and with `app.tenant_id` set
   * per tenant so row-level security still limits the blast radius to this
   * run's data.
   *
   * TEST_ADMIN_DATABASE_URL overrides the connection for setups where the
   * application role is not the owner. If neither account owns the tables, the
   * rows are left behind, which is the safer failure.
   */
  async cleanup(): Promise<void> {
    if (this.createdTenantIds.length === 0) return;
    const tenantIds = [...this.createdTenantIds];
    const emails = [...this.createdEmails];
    this.createdTenantIds.length = 0;
    this.createdEmails.length = 0;

    const url = process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) return;

    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();

    // Tables whose triggers refuse the deletes a cleanup has to do: the
    // append-only audit trail, the last-administrator rule, and the rule
    // that an allergy is never deleted (PAT-R-03).
    const guarded = [
      'audit_log',
      '"user"',
      'user_branch_role',
      'patient_allergy',
      'encounter',
      'encounter_event',
      'triage',
      'triage_amendment',
      'consultation',
      'consultation_amendment',
      'diagnosis',
      // Append-only and immutability triggers refuse the deletes below.
      'product_price_history',
      'prescription_item',
      // Append-only: the ledger refuses a delete whatever asks for one.
      'stock_movement',
      'procedure_price_history',
      'vaccination_record',
    ];
    let disabled = false;
    try {
      for (const table of guarded) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      disabled = true;
    } catch {
      // Not the owner. Carry on; the deletes below will do what they can.
    }

    try {
      for (const tenantId of tenantIds) {
        await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
        for (const table of [
          'audit_log',
          'session',
          // Prescriptions, children before their parents. A later version
          // of an item points at the one it superseded, and that key is
          // RESTRICT rather than NO ACTION, so it cannot be deferred to
          // the end of the statement: the replacements go first.
          // Procedures, children before their parents.
          'vaccination_record',
          'encounter_procedure_consumable',
          'encounter_procedure',
          'procedure_price_history',
          'procedure_consumable',
          'procedure_catalog',
          // Stock, children before their parents.
          'reconciliation_run',
          'stock_movement',
          'product_batch',
          'rx_favourite',
          'prescription_item WHERE supersedes_id IS NOT NULL',
          'prescription_item',
          'prescription',
          // Clinical records, children before their parents.
          'consultation_amendment',
          'consultation_attachment',
          'diagnosis',
          'consultation',
          'clinical_template',
          'quick_phrase',
          'triage_amendment',
          'triage',
          'encounter_event',
          'encounter',
          'queue_sequence',
          'display_token',
          'branch_room',
          'password_reset_token',
          'trusted_device',
          'mfa_replay',
          // Patient registry, children before the patient they hang off.
          'patient_allergy',
          'patient_condition',
          'patient_consent',
          'patient_contact',
          'patient_document',
          'patient_import_batch',
          'patient_recent',
          'patient',
          'mrn_sequence',
          // The catalogue, which prescriptions and stock both hang off.
          'product_price_history',
          'product_branch_setting',
          'product',
          'product_category WHERE parent_id IS NOT NULL',
          'product_category',
          'user_branch_role',
          '"user"',
          'branch',
        ]) {
          // No WHERE clause on purpose: row-level security is the filter, which
          // is one more place the policies get exercised.
          await client.query(`DELETE FROM ${table}`).catch(() => undefined);
        }
      }

      await client.query(
        "SELECT set_config('app.tenant_id', '', false), set_config('app.auth_bypass', 'on', false)",
      );
      await client
        .query('DELETE FROM login_attempt WHERE email_key = ANY($1::text[])', [emails])
        .catch(() => undefined);
      await client
        .query('DELETE FROM tenant WHERE id = ANY($1::uuid[])', [tenantIds])
        .catch(() => undefined);
    } finally {
      if (disabled) {
        for (const table of guarded) {
          await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`).catch(() => undefined);
        }
      }
      await client.end();
    }
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
