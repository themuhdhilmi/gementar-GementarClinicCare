/**
 * Seeds one tenant, one branch and one administrator with a single-use
 * set-password link (IAM §18). Idempotent: running it again prints a fresh
 * link for the existing administrator rather than creating a second one.
 *
 *   npm run db:seed -- --tenant "Klinik Sihat" --slug klinik-sihat \
 *                      --branch "Cheras" --code KL01 \
 *                      --admin-name "Dr Siti" --admin-email siti@example.com
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { CryptoService } from '../src/shared/crypto/crypto.service.js';
import { Clock } from '../src/shared/time/clock.js';
import { TokenService } from '../src/modules/identity/services/token.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import { BranchStatus, Role, TenantStatus, TokenPurpose, UserStatus } from '../src/generated/prisma/enums.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const logger = new Logger('Seed');
  // Wired by hand rather than through Nest: a seed script has no business
  // booting the HTTP stack, the scheduler or the guards.
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);
  const clock = new Clock();
  const crypto = new CryptoService(config);
  const tokens = new TokenService(config, crypto, clock);

  const tenantName = arg('tenant', 'Klinik Pilot');
  const slug = arg('slug', 'klinik-pilot').toLowerCase();
  const branchName = arg('branch', 'Cawangan Utama');
  const branchCode = arg('code', 'KL01').toUpperCase();
  const adminName = arg('admin-name', 'Clinic Administrator');
  const adminEmail = arg('admin-email', 'admin@example.test').toLowerCase();

  // The tenant row is created in platform scope, because until it exists there
  // is no tenant to scope to. Everything else is written inside the tenant, the
  // same way the application does it: branch and role tables have no bypass
  // policy at all.
  const tenant = await db.withPlatform('seed tenant row', async (tx) => {
    const existing = await tx.tenant.findFirst({ where: { slug } });
    if (existing) return existing;
    return tx.tenant.create({
      data: {
        id: newId(),
        name: tenantName,
        slug,
        status: TenantStatus.ACTIVE,
        settings: {},
        modules: {},
      },
    });
  });

  const result = await db.withTenant(tenant.id, async (tx) => {
    let branch = await tx.branch.findFirst({ where: { code: branchCode } });
    if (!branch) {
      branch = await tx.branch.create({
        data: {
          id: newId(),
          tenantId: tenant.id,
          code: branchCode,
          name: branchName,
          operatingHours: {},
          settings: {},
          status: BranchStatus.ACTIVE,
        },
      });
    }

    let user = await tx.user.findFirst({ where: { email: adminEmail } });
    if (!user) {
      user = await tx.user.create({
        data: {
          id: newId(),
          tenantId: tenant.id,
          email: adminEmail,
          name: adminName,
          status: UserStatus.INVITED,
          defaultBranchId: branch.id,
        },
      });
    }

    const hasAdminRole = await tx.userBranchRole.findFirst({
      where: { userId: user.id, branchId: branch.id, role: Role.ADMIN },
    });
    if (!hasAdminRole) {
      await tx.userBranchRole.create({
        data: {
          id: newId(),
          tenantId: tenant.id,
          userId: user.id,
          branchId: branch.id,
          role: Role.ADMIN,
        },
      });
    }

    const invite = await tokens.issue(tx, {
      userId: user.id,
      purpose: TokenPurpose.INVITE,
      tenantId: tenant.id,
    });
    return { tenant, branch, user, invite };
  });

  logger.log(`tenant  ${result.tenant.name} (${result.tenant.slug})`);
  logger.log(`branch  ${result.branch.name} [${result.branch.code}]`);
  logger.log(`admin   ${result.user.email}`);
  logger.log(`set password (expires ${result.invite.expiresAt.toISOString()}):`);
  // eslint-disable-next-line no-console
  console.log(`\n  ${result.invite.link}\n`);
  logger.warn('MFA is mandatory for ADMIN: enrolment is forced at first sign-in.');

  await prisma.onModuleDestroy();
}

await main();
