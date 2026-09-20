import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, type SeededUser, DEFAULT_PASSWORD } from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';

const API = '/api/v1';

async function signIn(harness: Harness, email: string): Promise<string> {
  const response = await request(harness.server)
    .post(`${API}/auth/login`)
    .send({ email, password: DEFAULT_PASSWORD })
    .expect(200);
  return (response.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('cc_session='),
  )!;
}

async function signInAdmin(harness: Harness, email: string): Promise<string> {
  const cookie = await signIn(harness, email);
  const enrol = await request(harness.server)
    .post(`${API}/auth/me/mfa/enrol`)
    .set('Cookie', cookie)
    .expect(200);
  await request(harness.server)
    .post(`${API}/auth/me/mfa/confirm`)
    .set('Cookie', cookie)
    .send({ code: totpFor(enrol.body.secret) })
    .expect(200);
  return cookie;
}

/**
 * A registration body with only the fields a given test cares about.
 *
 * Each one gets its own telephone number. Sharing one is how a family is
 * registered, and the duplicate check treats a shared number as a reason to
 * look twice — so a fixture that reuses one would make every registration
 * after the first come back as a possible duplicate.
 */
let phoneCounter = 0;
function patient(overrides: Record<string, unknown> = {}) {
  phoneCounter += 1;
  return {
    name: 'Ali bin Ahmad',
    idType: 'MYKAD',
    idNumber: '900101-14-5677',
    gender: 'MALE',
    phone: `011-${String(10_000_000 + phoneCounter).slice(0, 8)}`,
    ...overrides,
  };
}

describe('PAT — patient registry', () => {
  const harness = new Harness();
  let fx: Fixture;
  let reception: string;
  let doctor: string;
  let nurse: string;
  let admin: string;
  let nurseUser: SeededUser;

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('patient');
    nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Mei',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    [reception, doctor, nurse] = await Promise.all([
      signIn(harness, fx.frontdesk.email),
      signIn(harness, fx.doctor.email),
      signIn(harness, nurseUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------------ registering

  describe('Registering (PAT-F-01 … F-05)', () => {
    it('PAT-T-01: fills the date of birth and sex in from the MyKad', async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Siti binti Kassim', idNumber: '900101-14-5678', gender: 'FEMALE' }))
        .expect(201);

      expect(created.body.patient.dateOfBirth).toBe('1990-01-01');
      expect(created.body.patient.gender).toBe('FEMALE');
      expect(created.body.patient.mrn).toMatch(/^P-\d{6}$/);
    });

    it('PAT-T-02: refuses a second registration of the same identity card', async () => {
      const first = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Chan Wei Ming', idNumber: '850612-10-5123' }))
        .expect(201);

      const again = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Chan W M', idNumber: '850612-10-5123' }))
        .expect(409);

      expect(again.body.code).toBe('patient_exists');
      expect(again.body.errors.duplicates[0].id).toBe(first.body.patient.id);
      // Even with force: the same card is the same person, always.
      await request(harness.server)
        .post(`${API}/patients?force=true`)
        .set('Cookie', reception)
        .send(patient({ name: 'Chan W M', idNumber: '850612-10-5123' }))
        .expect(409);
    });

    it('warns about a likely duplicate, and lets it through once seen', async () => {
      await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Kumar a/l Raman', idNumber: '770203-08-5991' }))
        .expect(201);

      // A different card, same name and birthday. Twins exist, so this is a
      // prompt rather than a refusal.
      const warned = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Kumar Raman', idNumber: '770203-08-5992' }))
        .expect(409);
      expect(warned.body.code).toBe('possible_duplicate');
      expect(warned.body.errors.duplicates[0].certain).toBe(false);

      await request(harness.server)
        .post(`${API}/patients?force=true`)
        .set('Cookie', reception)
        .send(patient({ name: 'Kumar Raman', idNumber: '770203-08-5992' }))
        .expect(201);
    });

    it('PAT-F-05: someone with no identity document needs a note', async () => {
      const refused = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send({ name: 'Baby of Siti', idType: 'NONE', gender: 'FEMALE' })
        .expect(400);
      expect(refused.body.code).toBe('note_required');

      await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send({
          name: 'Baby of Siti',
          idType: 'NONE',
          gender: 'FEMALE',
          notes: 'Newborn. Mother Siti binti Kassim, 012-345 6789.',
          dateOfBirth: '2026-09-01',
        })
        .expect(201);
    });

    it('refuses a MyKad whose date portion is not a date', async () => {
      const refused = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ idNumber: '901301-14-5678' }))
        .expect(400);
      expect(refused.body.code).toBe('invalid_mykad');
    });

    it('gives each patient the next number, and never the same one twice', async () => {
      const made = await Promise.all(
        [1, 2, 3].map((n) =>
          request(harness.server)
            .post(`${API}/patients`)
            .set('Cookie', reception)
            .send(patient({ name: `Sequence Test ${n}`, idType: 'NONE', idNumber: null, notes: 'x' }))
            .expect(201),
        ),
      );
      const numbers = made.map((r) => r.body.patient.mrn);
      expect(new Set(numbers).size).toBe(3);
    });
  });

  // --------------------------------------------------------------- masking

  describe('Identity masking (PAT-F-24, PAT-R-05)', () => {
    let patientId: string;

    beforeAll(async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Masked Person', idNumber: '880808-08-8888' }))
        .expect(201);
      patientId = created.body.patient.id;
    });

    it('PAT-T-05: masked by default, full only when asked, and audited', async () => {
      const masked = await request(harness.server)
        .get(`${API}/patients/${patientId}`)
        .set('Cookie', reception)
        .expect(200);
      expect(masked.body.idNumber).toBe('••••••-••-8888');
      expect(masked.body.unmasked).toBe(false);

      const full = await request(harness.server)
        .get(`${API}/patients/${patientId}?unmask=true`)
        .set('Cookie', reception)
        .expect(200);
      expect(full.body.idNumber).toBe('880808-08-8888');

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'patient.id_unmasked' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('refuses to unmask for somebody without the permission', async () => {
      // A nurse may read the record and may not see the whole card.
      const refused = await request(harness.server)
        .get(`${API}/patients/${patientId}?unmask=true`)
        .set('Cookie', nurse)
        .expect(400);
      expect(refused.body.code).toBe('unmask_not_permitted');
    });

    it('PAT-N-06: the identity number is not in the audit trail either', async () => {
      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'patient.registered' })
        .expect(200);
      expect(JSON.stringify(trail.body)).not.toContain('880808088888');
    });
  });

  // ---------------------------------------------------------------- search

  describe('Search (PAT-F-16 … F-20)', () => {
    let target: string;

    beforeAll(async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(
          patient({
            name: 'Zulkifli bin Hassan',
            idNumber: '750505-05-5055',
            phone: '019-888 7766',
          }),
        )
        .expect(201);
      target = created.body.patient.id;
    });

    const find = async (q: string) =>
      (
        await request(harness.server)
          .post(`${API}/patients/search`)
          .set('Cookie', reception)
          .send({ q })
          .expect(200)
      ).body.items as Array<{ id: string; matchedOn: string }>;

    it('finds by the last four of the identity card', async () => {
      const hits = await find('5055');
      expect(hits.map((h) => h.id)).toContain(target);
    });

    it('finds by the whole identity number, ranked first', async () => {
      const hits = await find('750505-05-5055');
      expect(hits[0]?.id).toBe(target);
      expect(hits[0]?.matchedOn).toBe('id');
    });

    it('finds by telephone number however it is written', async () => {
      for (const written of ['019-888 7766', '0198887766', '+60198887766']) {
        const hits = await find(written);
        expect(hits.map((h) => h.id), written).toContain(target);
      }
    });

    it('finds by patient number', async () => {
      const record = await request(harness.server)
        .get(`${API}/patients/${target}`)
        .set('Cookie', reception)
        .expect(200);
      const hits = await find(record.body.mrn);
      expect(hits[0]?.id).toBe(target);
      expect(hits[0]?.matchedOn).toBe('mrn');
    });

    it('PAT-T-04: ignores "bin" and the word order', async () => {
      // A receptionist types what the patient says, which is rarely the
      // order on the card and never includes the particles.
      for (const typed of ['zulkifli hassan', 'ZULKIFLI', 'hassan zulkifli', 'zulkifli bin hassan']) {
        const hits = await find(typed);
        expect(hits.map((h) => h.id), typed).toContain(target);
      }
    });

    it('PAT-F-20: ignores diacritics and a/l, a/p', async () => {
      await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Muthu a/l Ramasamy', idNumber: '820202-02-2022' }))
        .expect(201);
      expect((await find('muthu ramasamy')).length).toBeGreaterThan(0);
      expect((await find('MUTHU RAMASAMY')).length).toBeGreaterThan(0);
    });

    it('returns nothing rather than everything for an empty search', async () => {
      expect(await find('')).toEqual([]);
    });

    it('PAT-F-19: shows what this person opened at this counter', async () => {
      await request(harness.server)
        .get(`${API}/patients/${target}`)
        .set('Cookie', reception)
        .expect(200);

      const mine = await request(harness.server)
        .get(`${API}/patients/recent`)
        .set('Cookie', reception)
        .expect(200);
      expect(mine.body.items.map((h: { id: string }) => h.id)).toContain(target);

      // Another person's list is their own, even at the same branch.
      const theirs = await request(harness.server)
        .get(`${API}/patients/recent`)
        .set('Cookie', nurse)
        .expect(200);
      expect(theirs.body.items.map((h: { id: string }) => h.id)).not.toContain(target);
    });

    it('a name with digits in it is a name, not a card number', async () => {
      // "Muthu Devi 50000" must not rank whoever's card ends 0000 first.
      const hits = await find('Zulkifli bin Hassan');
      expect(hits[0]?.id).toBe(target);
      expect(hits[0]?.matchedOn).toBe('name');
    });

    it('carries the allergy badge without a second request (PAT-N-03)', async () => {
      const hits = await find('750505-05-5055');
      expect(hits[0]).toHaveProperty('allergyState', 'NOT_RECORDED');
    });

    it('does not return a deleted patient, and keeps the record readable', async () => {
      const doomed = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Deleted Person', idNumber: '600101-01-0101' }))
        .expect(201);

      await request(harness.server)
        .post(`${API}/patients/${doomed.body.patient.id}/delete`)
        .set('Cookie', admin)
        .send({ reason: 'Registered in error, duplicate of a paper record' })
        .expect(200);

      // PAT-T-12: gone from search, still there when something links to it.
      expect((await find('600101-01-0101')).length).toBe(0);
      const still = await request(harness.server)
        .get(`${API}/patients/${doomed.body.patient.id}`)
        .set('Cookie', reception)
        .expect(200);
      expect(still.body.name).toBe('Deleted Person');
      expect(still.body.status).toBe('DELETED');
    });
  });

  // -------------------------------------------------------------- clinical

  describe('Allergies and conditions (PAT-F-11 … F-15)', () => {
    let patientId: string;

    beforeAll(async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Allergy Person', idNumber: '950707-07-7077' }))
        .expect(201);
      patientId = created.body.patient.id;
    });

    it('PAT-T-10: starts as "not recorded", which is not the same as none', async () => {
      const summary = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      expect(summary.body.allergyState).toBe('NOT_RECORDED');
      expect(summary.body.nkdaRecorded).toBeNull();
    });

    it('records "no known drug allergies" as a thing somebody said', async () => {
      const after = await request(harness.server)
        .put(`${API}/patients/${patientId}/nkda`)
        .set('Cookie', nurse)
        .send({ nkda: true })
        .expect(200);
      expect(after.body.allergyState).toBe('NKDA');
      expect(after.body.nkdaRecordedAt).not.toBeNull();
    });

    it('PAT-T-06: a nurse records it unverified, a doctor verified', async () => {
      const byNurse = await request(harness.server)
        .post(`${API}/patients/${patientId}/allergies`)
        .set('Cookie', nurse)
        .send({ type: 'DRUG', substance: 'Penicillin', severity: 'SEVERE', reaction: 'Rash' })
        .expect(201);
      expect(byNurse.body.status).toBe('UNVERIFIED');

      const byDoctor = await request(harness.server)
        .post(`${API}/patients/${patientId}/allergies`)
        .set('Cookie', doctor)
        .send({ type: 'FOOD', substance: 'Peanuts', severity: 'LIFE_THREATENING' })
        .expect(201);
      expect(byDoctor.body.status).toBe('VERIFIED');
      expect(byDoctor.body.verifiedBy).not.toBeNull();
    });

    it('a drug allergy needs a severity, because it decides the warning', async () => {
      const refused = await request(harness.server)
        .post(`${API}/patients/${patientId}/allergies`)
        .set('Cookie', doctor)
        .send({ type: 'DRUG', substance: 'Aspirin' })
        .expect(400);
      expect(refused.body.code).toBe('severity_required');
    });

    it('recording an allergy clears the "nobody asked" state', async () => {
      const summary = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      expect(summary.body.allergyState).toBe('SEVERE');
      expect(summary.body.allergyCount).toBe(2);
    });

    it('refuses "no known allergies" while allergies are recorded', async () => {
      const refused = await request(harness.server)
        .put(`${API}/patients/${patientId}/nkda`)
        .set('Cookie', doctor)
        .send({ nkda: true })
        .expect(400);
      expect(refused.body.code).toBe('allergies_present');
    });

    it('PAT-T-07: refuting keeps the entry, with the reason and the author', async () => {
      const summary = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      const penicillin = summary.body.allergies.find(
        (a: { substance: string }) => a.substance === 'Penicillin',
      );

      const refuted = await request(harness.server)
        .post(`${API}/patients/${patientId}/allergies/${penicillin.id}/refute`)
        .set('Cookie', doctor)
        .send({ reason: 'Challenged under supervision in 2026, tolerated without reaction.' })
        .expect(200);
      expect(refuted.body.status).toBe('REFUTED');
      expect(refuted.body.refutedReason).toContain('Challenged');

      const after = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      // Still in the list, so the next prescriber can see it was considered.
      expect(after.body.allergies.map((a: { id: string }) => a.id)).toContain(penicillin.id);
      expect(after.body.allergyCount).toBe(1);
    });

    it('a nurse cannot verify or refute, a doctor can', async () => {
      const summary = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      const peanuts = summary.body.allergies.find(
        (a: { substance: string }) => a.substance === 'Peanuts',
      );
      await request(harness.server)
        .post(`${API}/patients/${patientId}/allergies/${peanuts.id}/refute`)
        .set('Cookie', nurse)
        .send({ reason: 'no' })
        .expect(403);
    });

    it('PAT-T-11: the front desk cannot read the clinical tab, and nothing is logged', async () => {
      const before = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'clinical.viewed' })
        .expect(200);

      await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', reception)
        .expect(403);

      const after = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'clinical.viewed' })
        .expect(200);
      expect(after.body.total).toBe(before.body.total);
    });

    it('records a chronic condition and resolves it', async () => {
      const created = await request(harness.server)
        .post(`${API}/patients/${patientId}/conditions`)
        .set('Cookie', doctor)
        .send({ condition: 'Type 2 diabetes mellitus', icd10Code: 'E11', onsetDate: '2019-04-01' })
        .expect(201);
      expect(created.body.status).toBe('ACTIVE');

      const resolved = await request(harness.server)
        .patch(`${API}/patients/${patientId}/conditions/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ condition: 'Type 2 diabetes mellitus', status: 'RESOLVED' })
        .expect(200);
      expect(resolved.body.status).toBe('RESOLVED');
      expect(resolved.body.resolvedAt).not.toBeNull();
    });
  });

  // ----------------------------------------------------- contacts, consents

  describe('Contacts and consents (PAT-F-08, PAT-F-09)', () => {
    let patientId: string;

    beforeAll(async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Contact Person', idNumber: '910909-09-9099' }))
        .expect(201);
      patientId = created.body.patient.id;
    });

    it('makes the first contact primary, and moves it when another is', async () => {
      const first = await request(harness.server)
        .post(`${API}/patients/${patientId}/contacts`)
        .set('Cookie', reception)
        .send({ name: 'Fatimah binti Omar', relationship: 'Wife', phone: '013-222 3344' })
        .expect(201);
      expect(first.body.items[0].isPrimary).toBe(true);

      const second = await request(harness.server)
        .post(`${API}/patients/${patientId}/contacts`)
        .set('Cookie', reception)
        .send({ name: 'Adik', relationship: 'Brother', phone: '014-555 6677', isPrimary: true })
        .expect(201);
      const primaries = second.body.items.filter((c: { isPrimary: boolean }) => c.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].name).toBe('Adik');
    });

    it('stores the contact number in one shape', async () => {
      const contacts = await request(harness.server)
        .get(`${API}/patients/${patientId}/contacts`)
        .set('Cookie', reception)
        .expect(200);
      expect(contacts.body.items.map((c: { phone: string }) => c.phone)).toContain('+60132223344');
    });

    it('records each consent separately, with who asked', async () => {
      const set = await request(harness.server)
        .put(`${API}/patients/${patientId}/consents`)
        .set('Cookie', reception)
        .send({
          consents: [
            { channel: 'SMS', purpose: 'REMINDERS', granted: true },
            { channel: 'SMS', purpose: 'MARKETING', granted: false },
          ],
        })
        .expect(200);

      const reminders = set.body.items.find(
        (c: { purpose: string }) => c.purpose === 'REMINDERS',
      );
      expect(reminders.granted).toBe(true);
      expect(reminders.recordedBy).not.toBeNull();
      expect(reminders.recordedAt).toBeTruthy();
    });
  });

  // ------------------------------------------------------------- documents

  describe('Attachments (PAT-F-23, PAT-N-04)', () => {
    let patientId: string;
    const PDF = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('scanned identity card'),
    ]);

    beforeAll(async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Document Person', idNumber: '860606-06-6066' }))
        .expect(201);
      patientId = created.body.patient.id;
    });

    it('takes a scan, and hands back a link that expires', async () => {
      const uploaded = await request(harness.server)
        .post(`${API}/patients/${patientId}/documents`)
        .set('Cookie', reception)
        .field('type', 'ID_COPY')
        .attach('file', PDF, { filename: 'ic.pdf', contentType: 'application/pdf' })
        .expect(201);

      expect(uploaded.body.items).toHaveLength(1);
      const document = uploaded.body.items[0];
      expect(document.mime).toBe('application/pdf');
      expect(document.sizeBytes).toBe(PDF.length);
      // The key is ours, under the tenant, never the name the browser sent.
      expect(document.storageKey).toContain(fx.tenantId);
      expect(document.storageKey).not.toContain('ic.pdf');

      const link = await request(harness.server)
        .get(`${API}/patients/${patientId}/documents/${document.id}`)
        .set('Cookie', reception)
        .expect(200);
      expect(link.body.url).toContain('token=');
      expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const content = await request(harness.server)
        .get(link.body.url.replace('/api/v1', API))
        .set('Cookie', reception)
        .expect(200);
      expect(Buffer.from(content.body).equals(PDF)).toBe(true);
      // Never rendered in this origin: a PDF is a program.
      expect(content.headers['content-disposition']).toContain('attachment');
      expect(content.headers['x-content-type-options']).toBe('nosniff');
    });

    it('refuses the bytes without a valid token, however the row is asked for', async () => {
      const documents = await request(harness.server)
        .get(`${API}/patients/${patientId}/documents`)
        .set('Cookie', reception)
        .expect(200);
      const id = documents.body.items[0].id;

      await request(harness.server)
        .get(`${API}/patients/${patientId}/documents/${id}/content`)
        .set('Cookie', reception)
        .expect(404);
      await request(harness.server)
        .get(`${API}/patients/${patientId}/documents/${id}/content?token=forged`)
        .set('Cookie', reception)
        .expect(404);
    });

    it('records who asked to see it', async () => {
      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'patient.document_viewed' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('judges the file by its bytes, not by its name', async () => {
      const refused = await request(harness.server)
        .post(`${API}/patients/${patientId}/documents`)
        .set('Cookie', reception)
        .field('type', 'OTHER')
        .attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), {
          filename: 'harmless.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
      expect(refused.body.code).toBe('file_wrong_type');
    });

    it('removes a document softly, so Friday\u2019s mistake is fixable on Monday', async () => {
      const documents = await request(harness.server)
        .get(`${API}/patients/${patientId}/documents`)
        .set('Cookie', reception)
        .expect(200);
      const id = documents.body.items[0].id;

      const after = await request(harness.server)
        .delete(`${API}/patients/${patientId}/documents/${id}`)
        .set('Cookie', reception)
        .expect(200);
      expect(after.body.items).toHaveLength(0);

      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.patientDocument.findFirst({ where: { id } }),
      );
      expect(row?.deletedAt).not.toBeNull();
    });
  });

  // ----------------------------------------------------------------- merge

  describe('Merging duplicates (PAT-F-26)', () => {
    it('PAT-T-08: moves everything to the survivor, and puts it back', async () => {
      const survivor = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        // No identity card and no telephone number, so the merge has
        // something to fill in from the other record.
        .send({ name: 'Merge Survivor', idType: 'NONE', gender: 'MALE', notes: 'keep' })
        .expect(201);
      const loser = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(
          patient({
            name: 'Merge Loser',
            idNumber: '830303-03-3033',
            phone: '017-111 2233',
          }),
        )
        .expect(201);

      const survivorId = survivor.body.patient.id as string;
      const loserId = loser.body.patient.id as string;

      await request(harness.server)
        .post(`${API}/patients/${loserId}/contacts`)
        .set('Cookie', reception)
        .send({ name: 'Next of kin', phone: '016-999 8877' })
        .expect(201);
      await request(harness.server)
        .post(`${API}/patients/${loserId}/allergies`)
        .set('Cookie', doctor)
        .send({ type: 'DRUG', substance: 'Sulfa', severity: 'MODERATE' })
        .expect(201);

      const merged = await request(harness.server)
        .post(`${API}/patients/${survivorId}/merge`)
        .set('Cookie', admin)
        .send({ loserId })
        .expect(200);

      expect(merged.body.moved.patient_allergy).toBe(1);
      expect(merged.body.moved.patient_contact).toBe(1);
      // The survivor had no identity number and no telephone; it takes them.
      expect(merged.body.patient.idNumberMasked).toBe('••••••-••-3033');
      expect(merged.body.patient.phone).toBe('+60171112233');

      const loserAfter = await request(harness.server)
        .get(`${API}/patients/${loserId}`)
        .set('Cookie', reception)
        .expect(200);
      expect(loserAfter.body.status).toBe('MERGED');
      expect(loserAfter.body.mergedIntoId).toBe(survivorId);

      const survivorClinical = await request(harness.server)
        .get(`${API}/patients/${survivorId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      expect(survivorClinical.body.allergies).toHaveLength(1);

      // And back again.
      const unmerged = await request(harness.server)
        .post(`${API}/patients/${loserId}/unmerge`)
        .set('Cookie', admin)
        .expect(200);
      expect(unmerged.body.patient.status).toBe('ACTIVE');
      expect(unmerged.body.restored.patient_allergy).toBe(1);

      const survivorAfter = await request(harness.server)
        .get(`${API}/patients/${survivorId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      expect(survivorAfter.body.allergies).toHaveLength(0);
    });

    it('refuses to merge a record into itself, and only an administrator may', async () => {
      const one = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Solo Person', idNumber: '790707-07-7079' }))
        .expect(201);
      const id = one.body.patient.id;

      await request(harness.server)
        .post(`${API}/patients/${id}/merge`)
        .set('Cookie', admin)
        .send({ loserId: id })
        .expect(400);

      await request(harness.server)
        .post(`${API}/patients/${id}/merge`)
        .set('Cookie', reception)
        .send({ loserId: id })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------- export

  describe('Subject access request (PAT-F-27)', () => {
    it('gives an administrator everything held, identity number included', async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'Export Person', idNumber: '870707-07-7078' }))
        .expect(201);
      const id = created.body.patient.id;

      await request(harness.server)
        .post(`${API}/patients/${id}/allergies`)
        .set('Cookie', doctor)
        .send({ type: 'FOOD', substance: 'Shellfish' })
        .expect(201);

      const exported = await request(harness.server)
        .post(`${API}/patients/${id}/export`)
        .set('Cookie', admin)
        .expect(200);

      // The patient asking about themselves gets the whole number.
      expect(exported.body.patient.idNumber).toBe('870707-07-7078');
      expect(exported.body.allergies).toHaveLength(1);
      expect(exported.body.exportedBy).toBeTruthy();

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'patient.exported' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('nobody but an administrator may export', async () => {
      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send(patient({ name: 'No Export', idNumber: '890909-09-9098' }))
        .expect(201);
      for (const who of [reception, doctor, nurse]) {
        await request(harness.server)
          .post(`${API}/patients/${created.body.patient.id}/export`)
          .set('Cookie', who)
          .expect(403);
      }
    });
  });

  // ---------------------------------------------------------------- import

  describe('Importing the old system (PAT-F-28)', () => {
    const csv = [
      'name,id_type,id_number,gender,phone,allergies',
      'Import One,MYKAD,940404-04-4044,F,012-111 1111,Penicillin;Dust',
      'Import Two,MYKAD,940404-04-4044,F,012-222 2222,',
      'Import Three,MYKAD,not-a-number,M,012-333 3333,',
      ',MYKAD,950505-05-5055,M,,',
      'Import Five,NONE,,M,012-555 5555,',
    ].join('\n');

    it('PAT-T-09: a dry run reports every row and writes nothing', async () => {
      const before = await request(harness.server)
        .post(`${API}/patients/search`)
        .set('Cookie', reception)
        .send({ q: 'Import' })
        .expect(200);

      const report = await request(harness.server)
        .post(`${API}/patients/import?dryRun=true`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'legacy.csv', contentType: 'text/csv' })
        .expect(200);

      expect(report.body.dryRun).toBe(true);
      expect(report.body.rowCount).toBe(5);
      // Import One and Import Five.
      expect(report.body.imported).toBe(2);
      // Import Two repeats the card on the line above it.
      expect(report.body.skipped).toBe(1);
      // A card number that is not one, and a row with no name at all.
      expect(report.body.rejected).toBe(2);
      for (const verdict of report.body.verdicts) {
        expect(typeof verdict.row).toBe('number');
        if (verdict.action !== 'IMPORT') expect(verdict.message).toBeTruthy();
      }

      const after = await request(harness.server)
        .post(`${API}/patients/search`)
        .set('Cookie', reception)
        .send({ q: 'Import' })
        .expect(200);
      expect(after.body.items.length).toBe(before.body.items.length);
    });

    it('imports for real, and records imported allergies as unverified', async () => {
      const report = await request(harness.server)
        .post(`${API}/patients/import?dryRun=false`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'legacy.csv', contentType: 'text/csv' })
        .expect(200);
      expect(report.body.imported).toBe(2);

      const found = await request(harness.server)
        .post(`${API}/patients/search`)
        .set('Cookie', reception)
        .send({ q: 'Import One' })
        .expect(200);
      const imported = found.body.items[0];
      expect(imported).toBeTruthy();

      const clinical = await request(harness.server)
        .get(`${API}/patients/${imported.id}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      // PAT-R-04: hearsay from a spreadsheet, until a clinician confirms it.
      expect(clinical.body.allergies).toHaveLength(2);
      expect(clinical.body.allergies.every((a: { status: string }) => a.status === 'UNVERIFIED')).toBe(
        true,
      );
      expect(clinical.body.allergies[0].notes).toContain('Imported from the previous system');
    });

    it('running it twice skips everyone rather than duplicating them', async () => {
      const again = await request(harness.server)
        .post(`${API}/patients/import?dryRun=false`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'legacy.csv', contentType: 'text/csv' })
        .expect(200);
      expect(again.body.imported).toBe(1); // only the row with no identity card
      expect(again.body.skipped).toBe(2);
    });

    it('refuses a column nobody will read', async () => {
      const refused = await request(harness.server)
        .post(`${API}/patients/import?dryRun=true`)
        .set('Cookie', admin)
        .attach('file', Buffer.from('name,blood_type\nAli,O+'), { filename: 'x.csv' })
        .expect(400);
      expect(refused.body.detail).toContain('blood_type');
    });

    it('only an administrator may import', async () => {
      await request(harness.server)
        .post(`${API}/patients/import?dryRun=true`)
        .set('Cookie', reception)
        .attach('file', Buffer.from(csv), { filename: 'legacy.csv' })
        .expect(403);
    });
  });
});
