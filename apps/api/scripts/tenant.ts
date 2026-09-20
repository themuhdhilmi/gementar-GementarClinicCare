/**
 * TEN-F-02: clinics are created and suspended from here, not over HTTP.
 *
 * There is no self-serve signup in V0 and no platform console, so these four
 * things are done by whoever runs the platform, on the box, with a record left
 * in the clinic's own audit trail.
 *
 *   npm run tenant -- create  --slug klinik-pilot --name "Klinik Pilot" \
 *                             --branch KL01 --branch-name "Cawangan Cheras"
 *   npm run tenant -- list
 *   npm run tenant -- suspend --slug klinik-pilot --reason "Unpaid invoice 2026-03"
 *   npm run tenant -- resume  --slug klinik-pilot
 *   npm run tenant -- set-plan --slug klinik-pilot --plan standard
 *   npm run tenant -- modules --slug klinik-pilot --on appointments --off loyalty
 *
 * `--actor` names the person doing it, for the audit entry. It defaults to the
 * operating-system user, which is better than nothing and worse than a name.
 */
import 'dotenv/config';
import { userInfo } from 'node:os';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService, type Tx } from '../src/shared/prisma/db.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { AuditAction } from '../src/modules/audit/audit.actions.js';
import type { AuditActor } from '../src/modules/audit/audit.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import { BranchStatus, TenantStatus } from '../src/generated/prisma/enums.js';
import { assertBranchCode } from '../src/modules/tenancy/branch.validation.js';
import {
  MODULE_FLAGS,
  resolveModuleFlags,
  type ModuleKey,
} from '../src/modules/tenancy/settings/module-flags.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function args(name: string): string[] {
  const found: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === `--${name}` && process.argv[index + 1]) found.push(process.argv[index + 1]!);
  });
  return found;
}

function requireSlug(): string {
  const slug = arg('slug')?.trim().toLowerCase();
  if (!slug) throw new Error('--slug is required');
  if (!SLUG.test(slug)) {
    throw new Error(
      `"${slug}" is not a usable slug. Lower case letters, digits and hyphens, 3 to 40 ` +
        'characters, not starting or ending with a hyphen. It becomes a subdomain and never changes.',
    );
  }
  return slug;
}

/**
 * The platform operator, as they appear in the clinic's audit trail. There is
 * no user row for them, so the entry carries a name and no actor id — which is
 * exactly how a break-glass entry should read.
 */
function platformActor(tenantId: string): AuditActor {
  return {
    tenantId,
    actorId: null,
    actorName: `platform:${arg('actor') ?? userInfo().username}`,
    actorRole: 'PLATFORM',
  };
}

async function main(): Promise<void> {
  const logger = new Logger('Tenant');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);
  const audit = new AuditService();
  const command = process.argv[2];

  const find = async (slug: string) => {
    const tenant = await db.withPlatform('find tenant by slug', (tx) =>
      tx.tenant.findFirst({ where: { slug } }),
    );
    if (!tenant) throw new Error(`No clinic with the slug "${slug}".`);
    return tenant;
  };

  switch (command) {
    case 'list': {
      const rows = await db.withPlatform('list tenants', (tx) =>
        tx.tenant.findMany({
          select: { slug: true, name: true, status: true, plan: true },
          orderBy: { slug: 'asc' },
        }),
      );
      if (rows.length === 0) logger.warn('No clinics yet. Create one with: tenant -- create');
      for (const row of rows) {
        // eslint-disable-next-line no-console
        console.log(`  ${row.slug.padEnd(24)} ${row.status.padEnd(10)} ${row.plan.padEnd(12)} ${row.name}`);
      }
      break;
    }

    case 'create': {
      const slug = requireSlug();
      const name = arg('name');
      if (!name) throw new Error('--name is required: what the clinic calls itself.');
      const branchCode = assertBranchCode(arg('branch', 'HQ') as string);
      const branchName = arg('branch-name', name) as string;

      const existing = await db.withPlatform('check slug', (tx) =>
        tx.tenant.findFirst({ where: { slug }, select: { id: true } }),
      );
      if (existing) throw new Error(`The slug "${slug}" is taken.`);

      const tenantId = newId();
      await db.withPlatform('create tenant', (tx) =>
        tx.tenant.create({
          data: {
            id: tenantId,
            name,
            slug,
            status: TenantStatus.ACTIVE,
            plan: arg('plan', 'pilot') as string,
            timezone: arg('timezone', 'Asia/Kuala_Lumpur') as string,
            settings: {},
            modules: {},
          },
        }),
      );

      // The branch and the audit entry are the clinic's own rows, so they are
      // written inside the clinic's scope: neither table has a bypass policy.
      const branchId = newId();
      await db.withTenant(tenantId, async (tx: Tx) => {
        await tx.branch.create({
          data: {
            id: branchId,
            tenantId,
            code: branchCode,
            name: branchName,
            operatingHours: {},
            settings: {},
            status: BranchStatus.ACTIVE,
          },
        });
        await audit.record(tx, platformActor(tenantId), {
          action: AuditAction.TenantCreated,
          entityType: 'tenant',
          entityId: tenantId,
          after: { slug, name, branch: branchCode },
        });
      });

      logger.log(`created ${name} (${slug}) with branch ${branchCode}`);
      logger.log('Next: create the first administrator with npm run user:create.');
      break;
    }

    case 'suspend':
    case 'resume': {
      const suspending = command === 'suspend';
      const tenant = await find(requireSlug());
      const reason = arg('reason');
      if (suspending && !reason) {
        throw new Error('--reason is required to suspend: the clinic will ask why.');
      }
      const next = suspending ? TenantStatus.SUSPENDED : TenantStatus.ACTIVE;
      if (tenant.status === next) {
        logger.warn(`${tenant.name} is already ${next}. Nothing to do.`);
        break;
      }

      await db.withTenant(tenant.id, async (tx: Tx) => {
        await tx.tenant.update({ where: { id: tenant.id }, data: { status: next } });
        await audit.record(tx, platformActor(tenant.id), {
          action: suspending ? AuditAction.TenantSuspended : AuditAction.TenantResumed,
          entityType: 'tenant',
          entityId: tenant.id,
          before: { status: tenant.status },
          after: { status: next },
          reason: reason ?? null,
        });
      });

      logger.log(`${tenant.name} is now ${next}.`);
      if (suspending) {
        logger.warn(
          'Everyone signed in there is refused on their next request, with a message that ' +
            'says the clinic is suspended. No data has been touched.',
        );
      }
      break;
    }

    case 'set-plan': {
      const tenant = await find(requireSlug());
      const plan = arg('plan');
      if (!plan) throw new Error('--plan is required');
      await db.withTenant(tenant.id, async (tx: Tx) => {
        await tx.tenant.update({ where: { id: tenant.id }, data: { plan } });
        await audit.record(tx, platformActor(tenant.id), {
          action: AuditAction.TenantPlanChanged,
          entityType: 'tenant',
          entityId: tenant.id,
          before: { plan: tenant.plan },
          after: { plan },
        });
      });
      logger.log(`${tenant.name} is now on the ${plan} plan.`);
      break;
    }

    case 'modules': {
      const tenant = await find(requireSlug());
      const on = args('on') as ModuleKey[];
      const off = args('off') as ModuleKey[];
      for (const key of [...on, ...off]) {
        if (!(key in MODULE_FLAGS)) {
          throw new Error(
            `"${key}" is not a module. Known: ${Object.keys(MODULE_FLAGS).join(', ')}`,
          );
        }
      }

      const before = resolveModuleFlags(tenant.modules);
      const after = { ...before };
      for (const key of on) after[key] = true;
      for (const key of off) after[key] = false;

      if (on.length + off.length > 0) {
        await db.withTenant(tenant.id, async (tx: Tx) => {
          await tx.tenant.update({ where: { id: tenant.id }, data: { modules: after } });
          await audit.record(tx, platformActor(tenant.id), {
            action: AuditAction.TenantModulesChanged,
            entityType: 'tenant',
            entityId: tenant.id,
            before,
            after,
          });
        });
      }

      for (const [key, label] of Object.entries(MODULE_FLAGS)) {
        // eslint-disable-next-line no-console
        console.log(`  ${after[key as ModuleKey] ? 'on ' : 'off'}  ${key.padEnd(20)} ${label}`);
      }
      break;
    }

    default:
      throw new Error(
        `Unknown command "${command ?? ''}". One of: create, list, suspend, resume, set-plan, modules.`,
      );
  }

  await prisma.onModuleDestroy();
}

await main();
