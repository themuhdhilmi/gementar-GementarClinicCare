/**
 * A fee schedule and a few counter items, so billing has prices.
 *
 * Every number here is invented. The real ones come from an hour with
 * the clinic's owner (BIL-OPEN-01), and the point of this script is to
 * make the screens usable before that hour happens — not to guess well.
 *
 *   npm run billing:seed --workspace @gementar/api
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import { FeeTimeBand, ProductStatus } from '../src/generated/prisma/enums.js';
import { ringgitToSen } from '../src/modules/billing/money.js';

/** Most specific wins, so these can be written in any order. */
const FEES: Array<{
  label: string;
  encounterType?: string;
  timeBand?: FeeTimeBand;
  fee: number;
}> = [
  { label: 'Any visit, in hours', fee: 35 },
  { label: 'Any visit, after hours', timeBand: FeeTimeBand.AFTER_HOURS, fee: 50 },
  { label: 'Any visit, Sunday', timeBand: FeeTimeBand.WEEKEND, fee: 50 },
  { label: 'Follow-up', encounterType: 'FOLLOW_UP', fee: 20 },
  { label: 'Follow-up, after hours', encounterType: 'FOLLOW_UP', timeBand: FeeTimeBand.AFTER_HOURS, fee: 35 },
];

const ITEMS: Array<{ code: string; name: string; price: number; category: string }> = [
  { code: 'BIL-0001', name: 'Medical certificate', price: 10, category: 'Documents' },
  { code: 'BIL-0002', name: 'Medical report', price: 80, category: 'Documents' },
  { code: 'BIL-0003', name: 'Referral letter', price: 20, category: 'Documents' },
  { code: 'BIL-0004', name: 'Injection fee', price: 10, category: 'Services' },
  { code: 'BIL-0005', name: 'Dressing pack', price: 12, category: 'Consumables' },
  { code: 'BIL-0006', name: 'Crutches, deposit', price: 50, category: 'Consumables' },
  { code: 'BIL-0007', name: 'Blood pressure check', price: 5, category: 'Services' },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const logger = new Logger('SeedBilling');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);

  const slug = arg('tenant', 'klinik-pilot').toLowerCase();
  const tenant = await db.withPlatform('find tenant', (tx) =>
    tx.tenant.findFirst({ where: { slug } }),
  );
  if (!tenant) throw new Error(`No clinic with the slug "${slug}". Run npm run db:seed first.`);

  await db.withTenant(tenant.id, async (tx) => {
    const staff = await tx.user.findFirst({ select: { id: true } });

    // Written fresh each run: a fee schedule with duplicates in it is
    // worse than no fee schedule, because the wrong rule may win.
    await tx.feeSchedule.deleteMany({});
    for (const rule of FEES) {
      await tx.feeSchedule.create({
        data: {
          id: newId(),
          tenantId: tenant.id,
          encounterType: rule.encounterType ?? null,
          timeBand: rule.timeBand ?? FeeTimeBand.ANY,
          fee: ringgitToSen(rule.fee),
          createdBy: staff?.id ?? null,
        },
      });
    }
    logger.log(`${FEES.length} fee rules: ${FEES.map((f) => `${f.label} RM${f.fee}`).join(', ')}`);

    let added = 0;
    for (const item of ITEMS) {
      const data = {
        code: item.code,
        name: item.name,
        defaultPrice: ringgitToSen(item.price),
        category: item.category,
        status: ProductStatus.ACTIVE,
      };
      const existing = await tx.billableItem.findFirst({
        where: { code: item.code },
        select: { id: true },
      });
      if (existing) {
        await tx.billableItem.update({ where: { id: existing.id }, data });
      } else {
        await tx.billableItem.create({ data: { id: newId(), tenantId: tenant.id, ...data } });
        added += 1;
      }
    }
    logger.log(`${ITEMS.length} counter items, ${added} new`);
  });

  logger.log(
    'Sign a consultation and open Billing: the fee is already on the bill. ' +
      'Every price here is invented — BIL-OPEN-01 is the hour with the owner that replaces them.',
  );

  await prisma.onModuleDestroy();
}

await main();
