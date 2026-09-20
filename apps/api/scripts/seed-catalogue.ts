/**
 * A starter medicine list, so the prescribing screen has something to find.
 *
 * Not a formulary. These are the two dozen things a Malaysian GP clinic
 * reaches for most, with the two fields that make the safety checks work:
 * a generic name on every one, and a drug class on everything an allergy
 * is commonly recorded against (RX-Q-01 is still open on where the real
 * list comes from).
 *
 * Running it twice updates rather than duplicates.
 *
 *   npm run catalogue:seed --workspace @gementar/api
 *   npm run catalogue:seed --workspace @gementar/api -- --tenant klinik-pilot
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import { ProductStatus, ProductType } from '../src/generated/prisma/enums.js';
import { toSen } from '../src/modules/catalogue/money.js';

type Seed = {
  sku: string;
  name: string;
  genericName: string;
  /** Lower case, because that is how the catalogue stores it. */
  drugClass?: string;
  brand?: string;
  form: string;
  strengthText?: string;
  strengthValue?: number;
  strengthUnit?: string;
  dispenseUnit: string;
  isControlled?: boolean;
  maxDailyDose?: number;
  maxDailyDoseUnit?: string;
  defaultDose?: number;
  defaultDoseUnit?: string;
  defaultRoute?: string;
  defaultFrequency?: string;
  /** Ringgit per dispensing unit. */
  price: number;
};

const MEDICINES: Seed[] = [
  // --- antibiotics. The classes here are what the allergy check matches on.
  {
    sku: 'MED-0001', name: 'Amoxicillin', genericName: 'Amoxicillin', drugClass: 'penicillins',
    form: 'cap', strengthText: '500 mg', strengthValue: 500, strengthUnit: 'mg',
    dispenseUnit: 'cap', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'TDS', price: 0.45,
  },
  {
    sku: 'MED-0002', name: 'Amoxicillin + Clavulanate', genericName: 'Co-amoxiclav',
    drugClass: 'penicillins', brand: 'Augmentin', form: 'tab', strengthText: '625 mg',
    strengthValue: 625, strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 625,
    defaultDoseUnit: 'mg', defaultRoute: 'PO', defaultFrequency: 'BD', price: 2.2,
  },
  {
    sku: 'MED-0003', name: 'Cloxacillin', genericName: 'Cloxacillin', drugClass: 'penicillins',
    form: 'cap', strengthText: '250 mg', strengthValue: 250, strengthUnit: 'mg',
    dispenseUnit: 'cap', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'QID', price: 0.4,
  },
  {
    sku: 'MED-0004', name: 'Cephalexin', genericName: 'Cephalexin', drugClass: 'cephalosporins',
    form: 'cap', strengthText: '500 mg', strengthValue: 500, strengthUnit: 'mg',
    dispenseUnit: 'cap', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'QID', price: 0.6,
  },
  {
    sku: 'MED-0005', name: 'Azithromycin', genericName: 'Azithromycin', drugClass: 'macrolides',
    form: 'tab', strengthText: '500 mg', strengthValue: 500, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'OD', price: 3.5,
  },
  {
    sku: 'MED-0006', name: 'Erythromycin', genericName: 'Erythromycin', drugClass: 'macrolides',
    form: 'tab', strengthText: '250 mg', strengthValue: 250, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'QID', price: 0.5,
  },
  {
    sku: 'MED-0007', name: 'Metronidazole', genericName: 'Metronidazole',
    drugClass: 'nitroimidazoles', form: 'tab', strengthText: '400 mg', strengthValue: 400,
    strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 400, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'TDS', price: 0.3,
  },
  {
    sku: 'MED-0008', name: 'Cotrimoxazole', genericName: 'Trimethoprim-sulfamethoxazole',
    drugClass: 'sulfonamides', form: 'tab', strengthText: '480 mg', strengthValue: 480,
    strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 960, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'BD', price: 0.35,
  },

  // --- pain and fever
  {
    sku: 'MED-0020', name: 'Paracetamol', genericName: 'Paracetamol', drugClass: 'analgesics',
    brand: 'Panadol', form: 'tab', strengthText: '500 mg', strengthValue: 500, strengthUnit: 'mg',
    dispenseUnit: 'tab', maxDailyDose: 4000, maxDailyDoseUnit: 'mg', defaultDose: 1000,
    defaultDoseUnit: 'mg', defaultRoute: 'PO', defaultFrequency: 'QID', price: 0.15,
  },
  {
    sku: 'MED-0021', name: 'Paracetamol Syrup', genericName: 'Paracetamol',
    drugClass: 'analgesics', form: 'syrup', strengthText: '120 mg/5 ml', dispenseUnit: 'ml',
    defaultDose: 10, defaultDoseUnit: 'ml', defaultRoute: 'PO', defaultFrequency: 'QID',
    price: 0.04,
  },
  {
    sku: 'MED-0022', name: 'Ibuprofen', genericName: 'Ibuprofen', drugClass: 'nsaids',
    form: 'tab', strengthText: '400 mg', strengthValue: 400, strengthUnit: 'mg',
    dispenseUnit: 'tab', maxDailyDose: 1200, maxDailyDoseUnit: 'mg', defaultDose: 400,
    defaultDoseUnit: 'mg', defaultRoute: 'PO', defaultFrequency: 'TDS', price: 0.2,
  },
  {
    sku: 'MED-0023', name: 'Diclofenac Sodium', genericName: 'Diclofenac', drugClass: 'nsaids',
    form: 'tab', strengthText: '50 mg', strengthValue: 50, strengthUnit: 'mg',
    dispenseUnit: 'tab', maxDailyDose: 150, maxDailyDoseUnit: 'mg', defaultDose: 50,
    defaultDoseUnit: 'mg', defaultRoute: 'PO', defaultFrequency: 'BD', price: 0.25,
  },
  {
    sku: 'MED-0024', name: 'Mefenamic Acid', genericName: 'Mefenamic acid', drugClass: 'nsaids',
    form: 'cap', strengthText: '250 mg', strengthValue: 250, strengthUnit: 'mg',
    dispenseUnit: 'cap', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'TDS', price: 0.3,
  },
  {
    sku: 'MED-0025', name: 'Tramadol', genericName: 'Tramadol', drugClass: 'opioids',
    form: 'cap', strengthText: '50 mg', strengthValue: 50, strengthUnit: 'mg',
    dispenseUnit: 'cap', isControlled: true, maxDailyDose: 400, maxDailyDoseUnit: 'mg',
    defaultDose: 50, defaultDoseUnit: 'mg', defaultRoute: 'PO', defaultFrequency: 'TDS',
    price: 0.8,
  },

  // --- everything else a GP reaches for daily
  {
    sku: 'MED-0040', name: 'Chlorpheniramine', genericName: 'Chlorpheniramine',
    drugClass: 'antihistamines', form: 'tab', strengthText: '4 mg', strengthValue: 4,
    strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 4, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'TDS', price: 0.1,
  },
  {
    sku: 'MED-0041', name: 'Loratadine', genericName: 'Loratadine', drugClass: 'antihistamines',
    form: 'tab', strengthText: '10 mg', strengthValue: 10, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 10, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'OD', price: 0.35,
  },
  {
    sku: 'MED-0042', name: 'Cetirizine', genericName: 'Cetirizine', drugClass: 'antihistamines',
    form: 'tab', strengthText: '10 mg', strengthValue: 10, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 10, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'ON', price: 0.3,
  },
  {
    sku: 'MED-0043', name: 'Omeprazole', genericName: 'Omeprazole',
    drugClass: 'proton pump inhibitors', form: 'cap', strengthText: '20 mg', strengthValue: 20,
    strengthUnit: 'mg', dispenseUnit: 'cap', defaultDose: 20, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'OM', price: 0.4,
  },
  {
    sku: 'MED-0044', name: 'Ranitidine', genericName: 'Ranitidine', drugClass: 'h2 antagonists',
    form: 'tab', strengthText: '150 mg', strengthValue: 150, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 150, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'BD', price: 0.25,
  },
  {
    sku: 'MED-0045', name: 'Salbutamol Inhaler', genericName: 'Salbutamol',
    drugClass: 'beta agonists', form: 'inhaler', strengthText: '100 mcg/dose',
    dispenseUnit: 'unit', defaultDose: 2, defaultDoseUnit: 'puff', defaultRoute: 'INH',
    defaultFrequency: 'PRN', price: 18,
  },
  {
    sku: 'MED-0046', name: 'Prednisolone', genericName: 'Prednisolone',
    drugClass: 'corticosteroids', form: 'tab', strengthText: '5 mg', strengthValue: 5,
    strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 30, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'OM', price: 0.15,
  },
  {
    sku: 'MED-0047', name: 'Metformin', genericName: 'Metformin', drugClass: 'biguanides',
    form: 'tab', strengthText: '500 mg', strengthValue: 500, strengthUnit: 'mg',
    dispenseUnit: 'tab', defaultDose: 500, defaultDoseUnit: 'mg', defaultRoute: 'PO',
    defaultFrequency: 'BD', price: 0.12,
  },
  {
    sku: 'MED-0048', name: 'Amlodipine', genericName: 'Amlodipine',
    drugClass: 'calcium channel blockers', form: 'tab', strengthText: '5 mg', strengthValue: 5,
    strengthUnit: 'mg', dispenseUnit: 'tab', defaultDose: 5, defaultDoseUnit: 'mg',
    defaultRoute: 'PO', defaultFrequency: 'OM', price: 0.18,
  },
  {
    sku: 'MED-0049', name: 'Hydrocortisone Cream', genericName: 'Hydrocortisone',
    drugClass: 'corticosteroids', form: 'cream', strengthText: '1%', dispenseUnit: 'tube',
    defaultDose: 1, defaultDoseUnit: 'application', defaultRoute: 'TOP', defaultFrequency: 'BD',
    price: 6.5,
  },
  {
    sku: 'MED-0050', name: 'Oral Rehydration Salts', genericName: 'Oral rehydration salts',
    form: 'sachet', dispenseUnit: 'sachet', defaultDose: 1, defaultDoseUnit: 'sachet',
    defaultRoute: 'PO', defaultFrequency: 'PRN', price: 1.2,
  },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const logger = new Logger('SeedCatalogue');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);

  const slug = arg('tenant', 'klinik-pilot').toLowerCase();
  const tenant = await db.withPlatform('find tenant', (tx) =>
    tx.tenant.findFirst({ where: { slug } }),
  );
  if (!tenant) throw new Error(`No clinic with the slug "${slug}". Run npm run db:seed first.`);

  const created: string[] = [];
  const updated: string[] = [];

  await db.withTenant(tenant.id, async (tx) => {
    for (const medicine of MEDICINES) {
      const data = {
        sku: medicine.sku,
        name: medicine.name,
        type: ProductType.MEDICINE,
        brand: medicine.brand ?? null,
        genericName: medicine.genericName,
        // Stored folded, the way the catalogue service stores it, so the
        // class match finds it whichever way it was typed.
        drugClass: medicine.drugClass?.toLowerCase() ?? null,
        form: medicine.form,
        strengthText: medicine.strengthText ?? null,
        strengthValue: medicine.strengthValue ?? null,
        strengthUnit: medicine.strengthUnit ?? null,
        dispenseUnit: medicine.dispenseUnit,
        isControlled: medicine.isControlled ?? false,
        maxDailyDose: medicine.maxDailyDose ?? null,
        maxDailyDoseUnit: medicine.maxDailyDoseUnit ?? null,
        defaultDose: medicine.defaultDose ?? null,
        defaultDoseUnit: medicine.defaultDoseUnit ?? null,
        defaultRoute: medicine.defaultRoute ?? null,
        defaultFrequency: medicine.defaultFrequency ?? null,
        sellingPrice: toSen(medicine.price),
        status: ProductStatus.ACTIVE,
      };

      const existing = await tx.product.findFirst({
        where: { sku: medicine.sku },
        select: { id: true },
      });

      if (existing) {
        await tx.product.update({ where: { id: existing.id }, data });
        updated.push(medicine.name);
        continue;
      }

      await tx.product.create({
        data: { id: newId(), tenantId: tenant.id, ...data },
      });
      created.push(medicine.name);
    }
  });

  if (created.length > 0) logger.log(`added ${created.length}: ${created.join(', ')}`);
  if (updated.length > 0) logger.log(`brought ${updated.length} up to date`);
  logger.log(
    'Open a consultation and type "amox" in the prescription box. A patient ' +
      'with a penicillin allergy gets an exact warning on Amoxicillin and a ' +
      'class warning on Co-amoxiclav and Cloxacillin.',
  );

  await prisma.onModuleDestroy();
}

await main();
