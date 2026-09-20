/**
 * A handful of patients to try the screens with.
 *
 * Not fixtures for tests, which make their own. These exist so that opening
 * the search box on a fresh development database shows something, and so
 * that the states worth looking at — an unrecorded allergy, a severe one, a
 * patient with no identity document — are all present without anyone having
 * to think them up.
 *
 *   npm run patients:seed --workspace @gementar/api
 *   npm run patients:seed --workspace @gementar/api -- --tenant klinik-pilot
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { loadAppConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/shared/prisma/prisma.service.js';
import { DbService } from '../src/shared/prisma/db.service.js';
import { newId } from '../src/shared/ids/uuid.js';
import {
  AllergySeverity,
  AllergyStatus,
  AllergyType,
  Gender,
  IdType,
  PatientStatus,
  Role,
} from '../src/generated/prisma/enums.js';
import { lastFour, normaliseIdentity } from '../src/modules/patient/identity.js';
import { normalisePhone } from '../src/modules/patient/patient.validation.js';

type Seed = {
  name: string;
  idType: IdType;
  idNumber?: string;
  /**
   * Required, and not inferred.
   *
   * Only a MyKad carries a date of birth. A passport does not, and falling
   * back to a single shared default gave a forty-year-old foreign worker the
   * same birthday as a newborn. Every person here states their own.
   */
  dateOfBirth: string;
  gender: Gender;
  phone?: string;
  notes?: string;
  nkda?: boolean;
  allergies?: Array<{
    substance: string;
    type: AllergyType;
    severity?: AllergySeverity;
    status: AllergyStatus;
    reaction?: string;
  }>;
};

const PEOPLE: Seed[] = [
  {
    name: 'Ahmad bin Zulkifli',
    idType: IdType.MYKAD,
    idNumber: '880114-14-5533',
    dateOfBirth: '1988-01-14',
    gender: Gender.MALE,
    phone: '012-345 6789',
    nkda: true,
  },
  {
    name: 'Siti Nurhaliza binti Kassim',
    idType: IdType.MYKAD,
    idNumber: '920307-10-5124',
    dateOfBirth: '1992-03-07',
    gender: Gender.FEMALE,
    phone: '013-222 8899',
    allergies: [
      {
        substance: 'Penicillin',
        type: AllergyType.DRUG,
        severity: AllergySeverity.LIFE_THREATENING,
        status: AllergyStatus.VERIFIED,
        reaction: 'Anaphylaxis, admitted 2019',
      },
    ],
  },
  {
    name: 'Muthu a/l Ramasamy',
    idType: IdType.MYKAD,
    idNumber: '750919-08-5077',
    dateOfBirth: '1975-09-19',
    gender: Gender.MALE,
    phone: '019-777 1234',
    allergies: [
      {
        substance: 'Sulfa drugs',
        type: AllergyType.DRUG,
        severity: AllergySeverity.MODERATE,
        // Recorded by the counter from what the patient said; a clinician
        // has not confirmed it, and the screen says so.
        status: AllergyStatus.UNVERIFIED,
        reaction: 'Rash',
      },
    ],
  },
  {
    name: 'Chan Wei Ming',
    idType: IdType.MYKAD,
    idNumber: '011122-14-5515',
    dateOfBirth: '2001-11-22',
    gender: Gender.MALE,
    phone: '011-2233 4455',
    // Nobody has asked. This is the amber state, and it is the point.
  },
  {
    name: 'Nur Aisyah binti Ahmad',
    idType: IdType.NONE,
    dateOfBirth: '2026-08-01',
    gender: Gender.FEMALE,
    phone: '012-345 6789',
    notes: 'Newborn. Mother Ahmad bin Zulkifli’s household, same telephone number.',
  },
  {
    name: 'Rahmat Santoso',
    idType: IdType.PASSPORT,
    idNumber: 'C4821990',
    // A passport carries no date of birth, so it has to be asked for. This
    // is the case that was wrong: he was born in 1984, not last month.
    dateOfBirth: '1984-06-22',
    gender: Gender.MALE,
    phone: '018-909 1122',
    notes: 'Speaks Bahasa Indonesia. Passport expires next year.',
  },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const logger = new Logger('SeedPatients');
  const config = loadAppConfig();
  const prisma = new PrismaService(config);
  const db = new DbService(prisma, config);

  const slug = arg('tenant', 'klinik-pilot').toLowerCase();
  const tenant = await db.withPlatform('find tenant', (tx) =>
    tx.tenant.findFirst({ where: { slug } }),
  );
  if (!tenant) throw new Error(`No clinic with the slug "${slug}". Run npm run db:seed first.`);

  const created: string[] = [];
  const repaired: string[] = [];

  await db.withTenant(tenant.id, async (tx) => {
    /**
     * Somebody real to attribute the allergies to.
     *
     * `recorded_by` means "which member of staff wrote this down", and an
     * allergy nobody is accountable for is the thing PAT-F-11 exists to
     * prevent. An earlier version of this script put the tenant's own id
     * there, which is a valid uuid and not a person.
     */
    const recorder =
      (await tx.user.findFirst({
        where: { branchRoles: { some: { role: Role.DOCTOR } } },
        select: { id: true, name: true },
      })) ?? (await tx.user.findFirst({ select: { id: true, name: true } }));

    if (!recorder) {
      throw new Error(
        'This clinic has no staff yet, and an allergy has to be recorded by somebody. ' +
          'Run npm run db:seed, or create a user first.',
      );
    }

    // Continue the clinic's own numbering rather than colliding with it.
    const sequence = await tx.mrnSequence.findFirst({ where: { tenantId: tenant.id } });
    let next = sequence?.next ?? 1;

    for (const person of PEOPLE) {
      const identity = normaliseIdentity(person.idType, person.idNumber ?? null, {
        passportCountry: person.idType === IdType.PASSPORT ? 'ID' : null,
      });

      // Matched on the document, or on the name when there is none. These
      // are demo rows in a development database with known values.
      const existing = identity.idNumber
        ? await tx.patient.findFirst({
            where: { idType: person.idType, idNumber: identity.idNumber },
            select: { id: true },
          })
        : await tx.patient.findFirst({
            where: { name: person.name, idType: IdType.NONE },
            select: { id: true },
          });

      const fields = {
        name: person.name,
        idType: person.idType,
        idNumber: identity.idNumber || null,
        idNumberLast4: identity.idNumber ? lastFour(identity.idNumber) : null,
        passportCountry: person.idType === IdType.PASSPORT ? 'ID' : null,
        // Stated, never inferred. A passport carries no birthday.
        dateOfBirth: new Date(`${person.dateOfBirth}T00:00:00.000Z`),
        gender: person.gender,
        phone: normalisePhone(person.phone),
        notes: person.notes ?? null,
        nkdaRecorded: person.nkda === true ? true : person.allergies ? false : null,
        nkdaRecordedAt: person.nkda === true ? new Date() : null,
        status: PatientStatus.ACTIVE,
      };

      let patientId: string;
      if (existing) {
        // Updated rather than skipped, so that running this again repairs
        // what an earlier version of the script got wrong.
        patientId = existing.id;
        await tx.patient.update({ where: { id: patientId }, data: fields });
        repaired.push(person.name);
      } else {
        patientId = newId();
        await tx.patient.create({
          data: {
            id: patientId,
            tenantId: tenant.id,
            mrn: `P-${String(next).padStart(6, '0')}`,
            source: 'MANUAL',
            ...fields,
          },
        });
        next += 1;
        created.push(person.name);
      }

      for (const allergy of person.allergies ?? []) {
        const already = await tx.patientAllergy.findFirst({
          where: { patientId, substance: allergy.substance },
          select: { id: true },
        });
        const attribution = {
          recordedBy: recorder.id,
          verifiedBy: allergy.status === AllergyStatus.VERIFIED ? recorder.id : null,
          verifiedAt: allergy.status === AllergyStatus.VERIFIED ? new Date() : null,
        };
        if (already) {
          // An allergy is never deleted (PAT-R-03), so a wrong attribution
          // is corrected in place rather than by replacing the row.
          await tx.patientAllergy.update({ where: { id: already.id }, data: attribution });
          continue;
        }
        await tx.patientAllergy.create({
          data: {
            id: newId(),
            tenantId: tenant.id,
            patientId,
            type: allergy.type,
            substance: allergy.substance,
            severity: allergy.severity ?? null,
            reaction: allergy.reaction ?? null,
            status: allergy.status,
            recordedAt: new Date(),
            ...attribution,
          },
        });
      }
    }

    await tx.mrnSequence.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, next },
      update: { next },
    });

    logger.log(`allergies recorded by ${recorder.name}`);
  });

  if (created.length > 0) logger.log(`added: ${created.join(', ')}`);
  if (repaired.length > 0) logger.log(`already there, brought up to date: ${repaired.join(', ')}`);
  logger.log('Open /patients and search for "ahmad", "5533" or "012-345 6789".');

  await prisma.onModuleDestroy();
}

await main();
