/**
 * Creates or updates a staff account with a known password, for testing and
 * training. Roles and passwords are normally set through the admin screens;
 * this exists for the first few accounts, before anyone can sign in to use
 * them, and for putting a demo clinic back to a known state.
 *
 *   npm run user:create -- --email doctor@klinik.test --name "Dr Siti" \
 *                          --role DOCTOR --branch KL01 --password "..."
 *
 * Options:
 *   --tenant   tenant slug                      (default: klinik-pilot)
 *   --branch   branch code                      (default: the tenant's first)
 *   --role     ADMIN | DOCTOR | NURSE | RECEPTION | DISPENSER | CASHIER, repeatable
 *   --password at least 12 characters           (default: generated and printed)
 *   --mfa-off  clear any existing second factor
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { PasswordService } from '../src/modules/identity/services/password.service.js';
import { BreachedPasswordService } from '../src/modules/identity/services/breached-password.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import { Role, UserStatus } from '../src/generated/prisma/enums.js';

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

async function main(): Promise<void> {
  const logger = new Logger('CreateUser');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);
  const passwords = new PasswordService(config, new BreachedPasswordService(config));

  const slug = (arg('tenant', 'klinik-pilot') as string).toLowerCase();
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name') ?? 'Test User';
  const branchCode = arg('branch')?.toUpperCase();
  const roles = (args('role').length > 0 ? args('role') : ['RECEPTION']).map(
    (r) => r.toUpperCase() as Role,
  );
  const password = arg('password') ?? `ujian-${newId().slice(-12)}`;
  const clearMfa = process.argv.includes('--mfa-off');

  if (!email) throw new Error('--email is required');
  for (const role of roles) {
    if (!Object.values(Role).includes(role)) throw new Error(`Unknown role: ${role}`);
  }

  const check = await passwords.validate(password, { email, name });
  if (!check.ok) throw new Error(`Password rejected: ${check.messages.join(' ')}`);
  const passwordHash = await passwords.hash(password);

  const tenant = await db.withPlatform('find tenant', (tx) => tx.tenant.findFirst({ where: { slug } }));
  if (!tenant) throw new Error(`No tenant with slug "${slug}". Run npm run db:seed first.`);

  const result = await db.withTenant(tenant.id, async (tx) => {
    const branch = branchCode
      ? await tx.branch.findFirst({ where: { code: branchCode } })
      : await tx.branch.findFirst({ orderBy: { code: 'asc' } });
    if (!branch) throw new Error(`No branch ${branchCode ?? ''} in tenant ${slug}`);

    const existing = await tx.user.findFirst({ where: { email }, select: { id: true } });
    const userId = existing?.id ?? newId();

    if (existing) {
      await tx.user.update({
        where: { id: userId },
        data: {
          name,
          passwordHash,
          status: UserStatus.ACTIVE,
          failedAttempts: 0,
          lockedUntil: null,
          defaultBranchId: branch.id,
          permissionVersion: { increment: 1 },
          ...(clearMfa
            ? { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryEnc: null, mfaEnrolledAt: null }
            : {}),
        },
      });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_changed' },
      });
      // Only the assignments that are actually going away. Deleting and
      // recreating would momentarily remove the tenant's last ADMIN, which the
      // database refuses — rightly.
      await tx.userBranchRole.deleteMany({
        where: { userId, NOT: { AND: [{ branchId: branch.id }, { role: { in: roles } }] } },
      });
    } else {
      await tx.user.create({
        data: {
          id: userId,
          tenantId: tenant.id,
          email,
          name,
          passwordHash,
          status: UserStatus.ACTIVE,
          defaultBranchId: branch.id,
        },
      });
    }

    await tx.userBranchRole.createMany({
      data: roles.map((role) => ({
        id: newId(),
        tenantId: tenant.id,
        userId,
        branchId: branch.id,
        role,
      })),
      skipDuplicates: true,
    });

    return { userId, branch };
  });

  logger.log(`account ready: ${email}`);
  logger.log(`  tenant   ${tenant.name} (${slug})`);
  logger.log(`  branch   ${result.branch.name} [${result.branch.code}]`);
  logger.log(`  roles    ${roles.join(', ')}`);
  if (roles.includes(Role.ADMIN)) {
    logger.warn('  ADMIN requires MFA: the first sign-in forces enrolment with an authenticator app.');
  }
  // eslint-disable-next-line no-console
  console.log(`\n  email    ${email}\n  password ${password}\n`);

  await prisma.onModuleDestroy();
}

await main();
