/**
 * Procedures and the stock to perform them with.
 *
 * Two things at once, because they are useless apart: a procedure with
 * no consumables on the shelf cannot be performed, and stock nobody uses
 * proves nothing. This seeds the consumables, receives an opening
 * balance of each at every branch, and maps them onto the procedures a
 * GP clinic actually does.
 *
 * Running it again tops the shelves back up rather than duplicating.
 *
 *   npm run procedures:seed --workspace @gementar/api
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import {
  BatchStatus,
  ProcedureCategory,
  ProductStatus,
  ProductType,
  StockMovementType,
} from '../src/generated/prisma/enums.js';
import { toSen } from '../src/modules/catalogue/money.js';

type Consumable = {
  sku: string;
  name: string;
  dispenseUnit: string;
  /** False for anything without a lot number: gauze, tape, a mask. */
  batched: boolean;
  coldChain?: boolean;
  generic?: string;
  cost: number;
  opening: number;
};

const CONSUMABLES: Consumable[] = [
  { sku: 'CON-0001', name: 'Nebuliser mask, adult', dispenseUnit: 'pcs', batched: false, cost: 3.5, opening: 60 },
  { sku: 'CON-0002', name: 'Nebuliser mask, paediatric', dispenseUnit: 'pcs', batched: false, cost: 3.5, opening: 40 },
  { sku: 'CON-0003', name: 'Syringe 3 ml with needle', dispenseUnit: 'pcs', batched: false, cost: 0.4, opening: 300 },
  { sku: 'CON-0004', name: 'Alcohol swab', dispenseUnit: 'pcs', batched: false, cost: 0.05, opening: 1000 },
  { sku: 'CON-0005', name: 'Gauze swab 5 x 5 cm', dispenseUnit: 'pcs', batched: false, cost: 0.2, opening: 500 },
  { sku: 'CON-0006', name: 'Adhesive dressing', dispenseUnit: 'pcs', batched: false, cost: 0.6, opening: 300 },
  { sku: 'CON-0007', name: 'Crepe bandage 7.5 cm', dispenseUnit: 'pcs', batched: false, cost: 3.2, opening: 60 },
  { sku: 'CON-0008', name: 'Sterile gloves, pair', dispenseUnit: 'pcs', batched: false, cost: 1.1, opening: 200 },
  { sku: 'CON-0009', name: 'Suture 3/0 nylon', dispenseUnit: 'pcs', batched: true, cost: 6.5, opening: 40 },
  { sku: 'CON-0010', name: 'Povidone-iodine 60 ml', dispenseUnit: 'bottle', batched: true, cost: 7.0, opening: 15 },
];

/** Medicines that are given rather than dispensed. */
const GIVEN: Consumable[] = [
  {
    sku: 'MED-0100', name: 'Salbutamol respule 2.5 mg', generic: 'Salbutamol',
    dispenseUnit: 'pcs', batched: true, cost: 1.8, opening: 80,
  },
  {
    sku: 'MED-0101', name: 'Influenza vaccine', generic: 'Influenza vaccine',
    dispenseUnit: 'vial', batched: true, coldChain: true, cost: 38, opening: 25,
  },
  {
    sku: 'MED-0102', name: 'Tetanus toxoid', generic: 'Tetanus toxoid',
    dispenseUnit: 'vial', batched: true, coldChain: true, cost: 12, opening: 30,
  },
  {
    sku: 'MED-0103', name: 'Lignocaine 2% 5 ml', generic: 'Lidocaine',
    dispenseUnit: 'vial', batched: true, cost: 4.2, opening: 40,
  },
  {
    sku: 'MED-0104', name: 'Dexamethasone 4 mg/ml', generic: 'Dexamethasone',
    dispenseUnit: 'vial', batched: true, cost: 3.1, opening: 30,
  },
];

type Seed = {
  code: string;
  name: string;
  category: ProcedureCategory;
  price: number;
  requiresConsent?: boolean;
  requiresDoctor?: boolean;
  vaccineSku?: string;
  durationMin?: number;
  protocol?: string;
  uses: Array<{ sku: string; quantity: number; optional?: boolean }>;
};

const PROCEDURES: Seed[] = [
  {
    code: 'NEB-0001', name: 'Nebuliser (salbutamol)', category: ProcedureCategory.NEBULISER,
    price: 25, durationMin: 20,
    uses: [
      { sku: 'CON-0001', quantity: 1 },
      { sku: 'MED-0100', quantity: 1 },
    ],
  },
  {
    code: 'NEB-0002', name: 'Nebuliser, child', category: ProcedureCategory.NEBULISER,
    price: 25, durationMin: 20,
    uses: [
      { sku: 'CON-0002', quantity: 1 },
      { sku: 'MED-0100', quantity: 1 },
    ],
  },
  {
    code: 'INJ-0001', name: 'Intramuscular injection', category: ProcedureCategory.INJECTION,
    price: 15,
    uses: [
      { sku: 'CON-0003', quantity: 1 },
      { sku: 'CON-0004', quantity: 1 },
    ],
  },
  {
    code: 'INJ-0002', name: 'Dexamethasone injection', category: ProcedureCategory.INJECTION,
    price: 30,
    uses: [
      { sku: 'CON-0003', quantity: 1 },
      { sku: 'CON-0004', quantity: 1 },
      { sku: 'MED-0104', quantity: 1 },
    ],
  },
  {
    code: 'DRS-0001', name: 'Simple wound dressing', category: ProcedureCategory.DRESSING,
    price: 20,
    uses: [
      { sku: 'CON-0005', quantity: 2 },
      { sku: 'CON-0006', quantity: 1 },
      { sku: 'CON-0008', quantity: 1 },
      { sku: 'CON-0007', quantity: 1, optional: true },
    ],
  },
  {
    code: 'DRS-0002', name: 'Large wound dressing', category: ProcedureCategory.DRESSING,
    price: 40,
    uses: [
      { sku: 'CON-0005', quantity: 6 },
      { sku: 'CON-0006', quantity: 2 },
      { sku: 'CON-0008', quantity: 1 },
      { sku: 'CON-0010', quantity: 1 },
    ],
  },
  {
    code: 'SUR-0001', name: 'Incision and drainage', category: ProcedureCategory.MINOR_SURGERY,
    price: 150, requiresConsent: true, requiresDoctor: true, durationMin: 30,
    protocol: 'Explain the procedure and the risk of scarring before consenting.',
    uses: [
      { sku: 'CON-0008', quantity: 1 },
      { sku: 'CON-0010', quantity: 1 },
      { sku: 'MED-0103', quantity: 1 },
      { sku: 'CON-0005', quantity: 4 },
    ],
  },
  {
    code: 'SUR-0002', name: 'Suturing, up to 5 stitches', category: ProcedureCategory.MINOR_SURGERY,
    price: 180, requiresConsent: true, requiresDoctor: true, durationMin: 30,
    uses: [
      { sku: 'CON-0009', quantity: 1 },
      { sku: 'CON-0008', quantity: 1 },
      { sku: 'MED-0103', quantity: 1 },
      { sku: 'CON-0010', quantity: 1 },
    ],
  },
  {
    code: 'SUR-0003', name: 'Suture removal', category: ProcedureCategory.MINOR_SURGERY,
    price: 30,
    uses: [
      { sku: 'CON-0005', quantity: 2 },
      { sku: 'CON-0008', quantity: 1 },
    ],
  },
  {
    code: 'VAC-0001', name: 'Influenza vaccination', category: ProcedureCategory.VACCINATION,
    price: 60, requiresConsent: true, vaccineSku: 'MED-0101',
    uses: [
      { sku: 'MED-0101', quantity: 1 },
      { sku: 'CON-0003', quantity: 1 },
      { sku: 'CON-0004', quantity: 1 },
    ],
  },
  {
    code: 'VAC-0002', name: 'Tetanus toxoid', category: ProcedureCategory.VACCINATION,
    price: 35, requiresConsent: true, vaccineSku: 'MED-0102',
    uses: [
      { sku: 'MED-0102', quantity: 1 },
      { sku: 'CON-0003', quantity: 1 },
      { sku: 'CON-0004', quantity: 1 },
    ],
  },
  {
    code: 'SCR-0001', name: 'Blood glucose, finger prick', category: ProcedureCategory.SCREENING,
    price: 10,
    uses: [{ sku: 'CON-0004', quantity: 1 }],
  },
  {
    code: 'OTH-0001', name: 'Ear syringing', category: ProcedureCategory.OTHER,
    price: 40, requiresConsent: true,
    uses: [{ sku: 'CON-0005', quantity: 2 }],
  },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

/** Eighteen months out, on the last day of the month, as a pack is stamped. */
function expiry(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() + 7, 0));
}

async function main(): Promise<void> {
  const logger = new Logger('SeedProcedures');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);

  const slug = arg('tenant', 'klinik-pilot').toLowerCase();
  const tenant = await db.withPlatform('find tenant', (tx) =>
    tx.tenant.findFirst({ where: { slug } }),
  );
  if (!tenant) throw new Error(`No clinic with the slug "${slug}". Run npm run db:seed first.`);

  await db.withTenant(tenant.id, async (tx) => {
    const staff = await tx.user.findFirst({ select: { id: true, name: true } });
    if (!staff) throw new Error('This clinic has no staff yet. Run npm run db:seed first.');
    const branches = await tx.branch.findMany({ select: { id: true, name: true } });

    // ---- the things procedures use
    const productBySku = new Map<string, string>();
    for (const item of [...CONSUMABLES, ...GIVEN]) {
      const data = {
        sku: item.sku,
        name: item.name,
        type: item.generic ? ProductType.MEDICINE : ProductType.CONSUMABLE,
        genericName: item.generic ?? null,
        dispenseUnit: item.dispenseUnit,
        isBatched: item.batched,
        isColdChain: item.coldChain ?? false,
        sellingPrice: BigInt(toSen(item.cost)),
        status: ProductStatus.ACTIVE,
      };
      const existing = await tx.product.findFirst({ where: { sku: item.sku }, select: { id: true } });
      if (existing) {
        await tx.product.update({ where: { id: existing.id }, data });
        productBySku.set(item.sku, existing.id);
      } else {
        const created = await tx.product.create({
          data: { id: newId(), tenantId: tenant.id, ...data },
        });
        productBySku.set(item.sku, created.id);
      }
    }
    logger.log(`${productBySku.size} consumables and given medicines`);

    // ---- an opening balance at every branch
    //
    // Posted through the ledger's own shape rather than by setting a
    // number: the invariant is that on-hand equals the sum of movements,
    // and a seed that writes only the cache would leave every batch
    // reported as a mismatch by the nightly job the next morning.
    let posted = 0;
    for (const branch of branches) {
      for (const item of [...CONSUMABLES, ...GIVEN]) {
        const productId = productBySku.get(item.sku)!;
        const batchNo = item.batched ? `${item.sku}-A` : 'NB';

        let batch = await tx.productBatch.findFirst({
          where: { branchId: branch.id, productId, batchNo },
        });
        if (!batch) {
          batch = await tx.productBatch.create({
            data: {
              id: newId(),
              tenantId: tenant.id,
              branchId: branch.id,
              productId,
              batchNo,
              expiryDate: item.batched ? expiry() : null,
              costPrice: BigInt(toSen(item.cost)),
              quantityOnHand: 0,
              status: BatchStatus.ACTIVE,
              sourceType: item.batched ? 'opening' : 'synthetic',
              createdBy: staff.id,
            },
          });
        }

        // Top back up to the opening figure rather than adding again, so
        // running this twice does not double the shelf.
        const onHand = Number(batch.quantityOnHand);
        const difference = item.opening - onHand;
        if (difference === 0) continue;

        await tx.stockMovement.create({
          data: {
            id: newId(),
            tenantId: tenant.id,
            branchId: branch.id,
            productId,
            batchId: batch.id,
            type: difference > 0 ? StockMovementType.OPENING : StockMovementType.ADJUST_OUT,
            quantity: difference,
            unitCost: BigInt(toSen(item.cost)),
            balanceAfter: item.opening,
            referenceType: 'seed',
            reasonCode: 'opening_balance',
            reasonText: 'Development seed',
            performedBy: staff.id,
            performedByName: staff.name,
          },
        });
        await tx.productBatch.update({
          where: { id: batch.id },
          data: { quantityOnHand: item.opening },
        });
        posted += 1;
      }
    }
    logger.log(`${posted} opening movements across ${branches.length} branches`);

    // ---- the procedures themselves
    let created = 0;
    let updated = 0;
    for (const seed of PROCEDURES) {
      const data = {
        code: seed.code,
        name: seed.name,
        category: seed.category,
        price: BigInt(toSen(seed.price)),
        requiresConsent: seed.requiresConsent ?? false,
        requiresDoctor: seed.requiresDoctor ?? false,
        vaccineProductId: seed.vaccineSku ? (productBySku.get(seed.vaccineSku) ?? null) : null,
        defaultDurationMin: seed.durationMin ?? null,
        protocol: seed.protocol ?? null,
        status: ProductStatus.ACTIVE,
      };

      const existing = await tx.procedureCatalog.findFirst({
        where: { code: seed.code },
        select: { id: true },
      });
      const id = existing?.id ?? newId();

      if (existing) {
        await tx.procedureCatalog.update({ where: { id }, data });
        updated += 1;
      } else {
        await tx.procedureCatalog.create({
          data: { id, tenantId: tenant.id, ...data, createdBy: staff.id },
        });
        await tx.procedurePriceHistory.create({
          data: {
            id: newId(),
            tenantId: tenant.id,
            procedureId: id,
            price: BigInt(toSen(seed.price)),
            setBy: staff.id,
            reason: 'Development seed',
          },
        });
        created += 1;
      }

      await tx.procedureConsumable.deleteMany({ where: { procedureId: id } });
      for (const use of seed.uses) {
        await tx.procedureConsumable.create({
          data: {
            id: newId(),
            tenantId: tenant.id,
            procedureId: id,
            productId: productBySku.get(use.sku)!,
            quantity: use.quantity,
            optional: use.optional ?? false,
          },
        });
      }
    }
    logger.log(`procedures: ${created} added, ${updated} brought up to date`);
  });

  logger.log(
    'Open a consultation, order "nebuliser", sign, then go to Procedures as the nurse. ' +
      'The mask and the respule are already filled in, and Stock shows them leave.',
  );

  await prisma.onModuleDestroy();
}

await main();
