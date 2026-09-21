import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { newId } from '../src/shared/ids/uuid.js';

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

describe('RX — prescribing', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let pharmacist: string;
  let branch: string;
  let branchB: string;

  /** The catalogue the tests prescribe from. */
  let amoxicillin: string;
  let ampicillin: string;
  let paracetamol: string;
  let paracetamolSyrup: string;
  let bandage: string;

  let seq = 0;

  async function addProduct(body: Record<string, unknown>): Promise<string> {
    const response = await request(harness.server)
      .post(`${API}/products`)
      .set('Cookie', admin)
      .send(body)
      .expect(201);
    return response.body.id as string;
  }

  /** A patient sitting with the doctor, and a draft note started. */
  async function consulting(options: { branchId?: string } = {}) {
    seq += 1;
    const at = options.branchId ?? branch;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Rx Patient ${seq}`,
        idType: 'NONE',
        gender: 'FEMALE',
        // A distinct birthday per patient, not a modulus that wraps: two
        // similar names sharing a date trip the duplicate check, and that
        // is the registry working correctly rather than a bug here.
        dateOfBirth: new Date(Date.UTC(1970, 0, 1 + seq)).toISOString().slice(0, 10),
        notes: 'Test patient',
        phone: `012-${String(60_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    const patientId = patient.body.patient.id as string;

    const encounter = await request(harness.server)
      .post(`${API}/branches/${at}/encounters`)
      .set('Cookie', reception)
      .send({ patientId })
      .expect(201);
    const encounterId = encounter.body.encounter.id as string;

    for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to })
        .expect(200);
    }

    const created = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/consultations`)
      .set('Cookie', doctor)
      .send({})
      .expect(201);
    const consultationId = created.body.id as string;

    await request(harness.server)
      .patch(`${API}/consultations/${consultationId}`)
      .set('Cookie', doctor)
      .send({ chiefComplaint: 'Sore throat' })
      .expect(200);
    await request(harness.server)
      .put(`${API}/consultations/${consultationId}/diagnoses`)
      .set('Cookie', doctor)
      .send({ diagnoses: [{ rank: 'PRIMARY', description: 'Tonsillitis', certainty: 'CONFIRMED' }] })
      .expect(200);

    return { patientId, encounterId, consultationId };
  }

  /** The standard item: one 500 mg capsule, three times a day, five days. */
  function course(overrides: Record<string, unknown> = {}) {
    return {
      productId: amoxicillin,
      doseValue: 500,
      doseUnit: 'mg',
      route: 'PO',
      frequencyCode: 'TDS',
      durationDays: 5,
      instructions: 'selepas makan',
      ...overrides,
    };
  }

  async function addItem(consultationId: string, body: Record<string, unknown>, status = 201) {
    return request(harness.server)
      .post(`${API}/consultations/${consultationId}/prescription/items`)
      .set('Cookie', doctor)
      .send(body)
      .expect(status);
  }

  async function recordAllergy(patientId: string, body: Record<string, unknown>) {
    return request(harness.server)
      .post(`${API}/patients/${patientId}/allergies`)
      .set('Cookie', doctor)
      .send({ type: 'DRUG', ...body })
      .expect(201);
  }

  /** Says "this patient has no known drug allergies", so RX-F-14 stays quiet. */
  async function recordNkda(patientId: string) {
    await request(harness.server)
      .put(`${API}/patients/${patientId}/nkda`)
      .set('Cookie', doctor)
      .send({ nkda: true })
      .expect(200);
  }


  /**
   * Closes a visit so the patient can have another.
   *
   * The patient is at `PHARMACY_WAITING` and never collects: since DSP
   * exists, the visit cannot be *completed* while medicine is still
   * waiting, and it is too late to cancel. "Did not answer" is both the
   * legal transition and the honest description, and dispensing it
   * properly is DSP's suite's job rather than this one's.
   */
  async function finish(encounterId: string) {
    await request(harness.server)
      .post(`${API}/encounters/${encounterId}/transition`)
      .set('Cookie', doctor)
      .send({ to: 'NO_SHOW', note: 'Test fixture: patient did not collect' })
      .expect(200);
  }

  async function sign(consultationId: string, body: Record<string, unknown> = {}, status = 200) {
    return request(harness.server)
      .post(`${API}/consultations/${consultationId}/sign`)
      .set('Cookie', doctor)
      .send(body)
      .expect(status);
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('prescription');
    branch = fx.branchAId;
    branchB = fx.branchBId;

    const pharmacistUser = await harness.addUser(fx, {
      name: 'Ahmad Dispenser',
      roles: [{ branchId: fx.branchAId, role: Role.DISPENSER }],
    });

    [doctor, reception, pharmacist] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, pharmacistUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);

    // The doctor works at both branches, so the cross-branch duplicate
    // check has somewhere to look. Written straight to the table: this is
    // scene-setting, not the thing under test.
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.userBranchRole.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          userId: fx.doctor.id,
          branchId: branchB,
          role: Role.DOCTOR,
        },
      }),
    );
    // The session caches the roles it was issued with, so it has to be
    // taken out again after one is added.
    doctor = await signIn(harness, fx.doctor.email);

    amoxicillin = await addProduct({
      name: 'Amoxicillin',
      type: 'MEDICINE',
      genericName: 'Amoxicillin',
      drugClass: 'Penicillins',
      form: 'cap',
      strengthText: '500 mg',
      strengthValue: 500,
      strengthUnit: 'mg',
      dispenseUnit: 'cap',
      sellingPrice: 0.45,
    });

    ampicillin = await addProduct({
      name: 'Ampicillin',
      type: 'MEDICINE',
      genericName: 'Ampicillin',
      drugClass: 'Penicillins',
      strengthText: '250 mg',
      strengthValue: 250,
      strengthUnit: 'mg',
      dispenseUnit: 'cap',
      sellingPrice: 0.3,
    });

    paracetamol = await addProduct({
      name: 'Panadol',
      type: 'MEDICINE',
      genericName: 'Paracetamol',
      drugClass: 'Analgesics',
      strengthText: '500 mg',
      strengthValue: 500,
      strengthUnit: 'mg',
      dispenseUnit: 'tab',
      maxDailyDose: 4000,
      maxDailyDoseUnit: 'mg',
      sellingPrice: 0.2,
    });

    paracetamolSyrup = await addProduct({
      name: 'Paracetamol Syrup',
      type: 'MEDICINE',
      genericName: 'Paracetamol',
      drugClass: 'Analgesics',
      strengthText: '120 mg/5 ml',
      dispenseUnit: 'ml',
      sellingPrice: 0.05,
    });

    bandage = await addProduct({
      name: 'Crepe Bandage',
      type: 'CONSUMABLE',
      dispenseUnit: 'pcs',
      sellingPrice: 3.5,
    });
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------------ items

  describe('Adding items (RX-F-01 … F-03)', () => {
    it('RX-T-05: works the quantity out, and stops doing so once it is typed over', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);

      const added = await addItem(consultationId, course());
      expect(added.body.quantity).toBe(15);
      expect(added.body.quantityUnit).toBe('cap');
      expect(added.body.quantityAuto).toBe(true);

      const edited = await request(harness.server)
        .put(`${API}/prescription-items/${added.body.id}`)
        .set('Cookie', doctor)
        .send(course({ quantity: 20 }))
        .expect(200);
      expect(edited.body.quantity).toBe(20);
      expect(edited.body.quantityAuto).toBe(false);
    });

    it('RX-T-10: writes the label in the patient language', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course());
      expect(added.body.labelText).toContain('Ambil 1 biji');
      expect(added.body.labelText).toContain('3 kali sehari');
      expect(added.body.labelText).toContain('Selama 5 hari');
    });

    it('RX-R-02: snapshots the product, so a later rename does not rewrite it', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course());
      expect(added.body.genericName).toBe('Amoxicillin');
      expect(added.body.drugClass).toBe('penicillins');
      expect(added.body.strength).toBe('500 mg');

      await request(harness.server)
        .patch(`${API}/products/${amoxicillin}`)
        .set('Cookie', admin)
        .send({ genericName: 'Amoxicillin trihydrate', drugClass: 'Beta-lactams' })
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.items[0].genericName).toBe('Amoxicillin');
      expect(read.body.items[0].drugClass).toBe('penicillins');

      // Put it back for the tests that follow.
      await request(harness.server)
        .patch(`${API}/products/${amoxicillin}`)
        .set('Cookie', admin)
        .send({ genericName: 'Amoxicillin', drugClass: 'Penicillins' })
        .expect(200);
    });

    it('will not prescribe something that is not a medicine', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const response = await addItem(consultationId, course({ productId: bandage }), 400);
      expect(response.body.detail).toContain('not a medicine');
    });

    it('takes an external item for the patient to have filled elsewhere', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(
        consultationId,
        course({ productId: undefined, externalName: 'Insulin glargine 100 u/ml', doseValue: 10, doseUnit: 'unit', route: 'SC', frequencyCode: 'ON', quantity: 1 }),
      );
      expect(added.body.isExternal).toBe(true);
      expect(added.body.externalName).toBe('Insulin glargine 100 u/ml');
    });

    it('refuses an item that names nothing, and one that names two things', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course({ productId: undefined }), 400);
      await addItem(consultationId, course({ externalName: 'Something else' }), 400);
    });

    it('insists a PRN item says what it is for', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const response = await addItem(
        consultationId,
        course({ productId: paracetamol, isPrn: true, frequencyCode: 'PRN', quantity: 10 }),
        400,
      );
      expect(response.body.detail).toContain('what this is to be taken for');
    });

    it('asks for the quantity when it cannot be worked out', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      // A syrup with no numeric strength: milligrams cannot become millilitres.
      const response = await addItem(
        consultationId,
        course({ productId: paracetamolSyrup, doseValue: 250, doseUnit: 'mg' }),
        400,
      );
      expect(response.body.detail).toContain('cannot be worked out');
    });
  });

  // --------------------------------------------------------- warnings

  describe('Allergy checking (RX-F-12, RX-T-01 … T-03)', () => {
    it('RX-T-01: an exact match is severe, and blocks the signature until confirmed', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'SEVERE',
        reaction: 'Anaphylaxis',
      });

      const added = await addItem(consultationId, course());
      const allergy = added.body.warnings.find((w: { type: string }) => w.type === 'ALLERGY');
      expect(allergy).toMatchObject({ level: 'EXACT', severity: 'SEVERE' });

      // Without an override at all.
      const blocked = await sign(consultationId, {}, 422);
      expect(blocked.body.detail).toContain('cannot be prescribed yet');

      await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/override`)
        .set('Cookie', doctor)
        .send({ reason: 'Tolerated previously under supervision' })
        .expect(200);

      // With a reason but no confirmation: still blocked (RX-R-04).
      const stillBlocked = await sign(consultationId, {}, 422);
      expect(stillBlocked.body.detail).toContain('confirmed at signing');

      const signed = await sign(consultationId, { confirm: [added.body.id] });
      expect(signed.body.status).toBe('SIGNED');
    });

    it('RX-T-02: a relative of the drug raises a class warning', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Penicillin',
        drugClass: 'Penicillins',
        severity: 'MODERATE',
      });

      const added = await addItem(consultationId, course({ productId: ampicillin, doseValue: 250 }));
      const allergy = added.body.warnings.find((w: { type: string }) => w.type === 'ALLERGY');
      expect(allergy).toMatchObject({ level: 'CLASS' });
      expect(allergy.message).toContain('same class');

      // A class match needs a reason, but not a second confirmation.
      await sign(consultationId, {}, 422);
      await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/override`)
        .set('Cookie', doctor)
        .send({ reason: 'Benefit outweighs risk, mild rash only' })
        .expect(200);
      await sign(consultationId);
    });

    it('RX-T-03: a free-text allergy always says "check by hand"', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, { substance: 'some antibiotic', severity: 'MODERATE' });

      const added = await addItem(consultationId, course({ productId: paracetamol, doseValue: 1000 }));
      const allergy = added.body.warnings.find((w: { type: string }) => w.type === 'ALLERGY');
      expect(allergy).toMatchObject({ level: 'UNLINKED' });
      expect(allergy.message).toContain('by hand');

      // It informs; it does not block.
      await sign(consultationId);
    });

    it('RX-F-14: says so when nobody has asked about allergies at all', async () => {
      const { consultationId } = await consulting();
      const added = await addItem(consultationId, course());
      expect(added.body.warnings.map((w: { type: string }) => w.type)).toContain(
        'NO_ALLERGY_RECORD',
      );
    });

    it('RX-F-04: says when the shelf cannot cover it, and prescribes anyway', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);

      // Nothing has ever been received for these products in this suite,
      // so the shelf is empty and the warning must say so.
      const added = await addItem(consultationId, course());
      const stock = added.body.warnings.find((w: { type: string }) => w.type === 'OUT_OF_STOCK');
      expect(stock).toBeTruthy();
      expect(stock.onHand).toBe(0);
      expect(stock.message).toContain('can still be prescribed');

      // Amber, not blocking: the doctor's decision stands.
      await sign(consultationId);
    });

    it('RX-F-16: warns above the recorded maximum daily dose', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      // 1500 mg six times a day is 9 g, well over the 4 g maximum.
      const added = await addItem(
        consultationId,
        course({ productId: paracetamol, doseValue: 1500, frequencyCode: 'Q4H', durationDays: 2 }),
      );
      const warning = added.body.warnings.find((w: { type: string }) => w.type === 'MAX_DOSE');
      expect(warning).toMatchObject({ dailyDose: 9000, maxDailyDose: 4000, unit: 'mg' });
    });

    it('RX-T-08: an allergy recorded after the draft opened blocks the signature', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);

      const added = await addItem(consultationId, course());
      expect(added.body.warnings.filter((w: { type: string }) => w.type === 'ALLERGY')).toEqual([]);

      // The nurse records it while the doctor is still typing.
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'LIFE_THREATENING',
        reaction: 'Airway swelling',
      });

      const blocked = await sign(consultationId, { confirm: [added.body.id] }, 422);
      expect(blocked.body.detail).toContain('cannot be prescribed yet');
      expect(JSON.stringify(blocked.body)).toContain('while this draft was open');
    });

    it('RX-R-03: recomputes on the server, whatever the client sends', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'MILD',
      });
      // The body carries no warnings field at all, and one appears anyway.
      const added = await addItem(consultationId, course());
      expect(added.body.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Duplicate checking (RX-F-13, RX-T-04)', () => {
    it('RX-T-04: finds the same generic prescribed recently at another branch', async () => {
      // First visit, at branch B.
      const first = await consulting({ branchId: branchB });
      await recordNkda(first.patientId);
      await addItem(first.consultationId, course());
      await sign(first.consultationId);
      await finish(first.encounterId);

      // Same patient, new visit at branch A.
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId: first.patientId })
        .expect(201);
      const encounterId = encounter.body.encounter.id as string;
      for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
        await request(harness.server)
          .post(`${API}/encounters/${encounterId}/transition`)
          .set('Cookie', doctor)
          .send({ to })
          .expect(200);
      }
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      const added = await addItem(created.body.id, course());
      const duplicate = added.body.warnings.find((w: { type: string }) => w.type === 'DUPLICATE');
      expect(duplicate).toBeTruthy();
      expect(duplicate.sameVisit).toBe(false);
      expect(duplicate.branchName).toBe('Branch B');
      expect(duplicate.message).toContain('Amoxicillin was prescribed on');
    });

    it('notices the same generic twice on one prescription', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course({ productId: paracetamol, doseValue: 1000 }));
      const second = await addItem(
        consultationId,
        course({ productId: paracetamolSyrup, doseValue: 10, doseUnit: 'ml', quantity: 100 }),
      );
      const duplicate = second.body.warnings.find((w: { type: string }) => w.type === 'DUPLICATE');
      expect(duplicate).toMatchObject({ sameVisit: true });
      expect(duplicate.message).toContain('already on this prescription');
    });
  });

  describe('Overrides (RX-F-15, RX-T-07)', () => {
    it('RX-T-07: audits the warning payload alongside the reason', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'MODERATE',
      });
      const added = await addItem(consultationId, course());
      await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/override`)
        .set('Cookie', doctor)
        .send({ reason: 'Tolerated previously, mild rash only' })
        .expect(200);

      const audit = await request(harness.server)
        .get(`${API}/audit/events?action=prescription.warning_overridden&pageSize=50`)
        .set('Cookie', admin)
        .expect(200);
      const entry = audit.body.items.find(
        (row: { entityId: string }) => row.entityId === added.body.id,
      );
      expect(entry).toBeTruthy();
      expect(entry.after.reason).toBe('Tolerated previously, mild rash only');
      expect(entry.after.warnings[0]).toMatchObject({ type: 'ALLERGY', level: 'EXACT' });
    });

    it('wants more than a shrug for a reason', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'MODERATE',
      });
      const added = await addItem(consultationId, course());
      await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/override`)
        .set('Cookie', doctor)
        .send({ reason: 'ok' })
        .expect(400);
    });

    it('can refute the allergy record instead, so it stops firing next visit', async () => {
      const { consultationId, patientId } = await consulting();
      const allergy = await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'MILD',
      });
      const allergyId = allergy.body.id ?? allergy.body.allergy?.id;
      const added = await addItem(consultationId, course());

      await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/override`)
        .set('Cookie', doctor)
        .send({ reason: 'Allergy record was the mother, not the patient', refuteAllergyId: allergyId })
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.patient.allergies).toEqual([]);
    });
  });

  // ---------------------------------------------------------- signing

  describe('Signing (RX-F-05) and routing', () => {
    it('sends the patient to the pharmacy when there is something to collect', async () => {
      const { consultationId, patientId, encounterId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());

      const signed = await sign(consultationId);
      expect(signed.body.routedTo).toBe('PHARMACY_WAITING');

      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(encounter.body.encounter.status).toBe('PHARMACY_WAITING');
    });

    it('does not, when nothing was prescribed', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const signed = await sign(consultationId);
      expect(signed.body.routedTo).not.toBe('PHARMACY_WAITING');
    });

    it('makes the items real all at once', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());
      await addItem(consultationId, course({ productId: paracetamol, doseValue: 1000, frequencyCode: 'QID', durationDays: 3 }));

      const before = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(before.body.items.map((i: { status: string }) => i.status)).toEqual(['DRAFT', 'DRAFT']);
      expect(before.body.prescription.status).toBe('DRAFT');

      await sign(consultationId);

      const after = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(after.body.items.map((i: { status: string }) => i.status)).toEqual(['ACTIVE', 'ACTIVE']);
      expect(after.body.prescription.status).toBe('ACTIVE');
      expect(after.body.prescription.signedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------- amendment

  describe('After signing (RX-F-06, RX-R-06, RX-T-06)', () => {
    async function signedItem() {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course());
      await sign(consultationId);
      return { consultationId, itemId: added.body.id as string, patientId };
    }

    it('RX-T-06: refuses a plain edit, and versions an amendment', async () => {
      const { consultationId, itemId } = await signedItem();

      await request(harness.server)
        .put(`${API}/prescription-items/${itemId}`)
        .set('Cookie', doctor)
        .send(course({ doseValue: 250 }))
        .expect(409);

      const amended = await request(harness.server)
        .post(`${API}/prescription-items/${itemId}/amend`)
        .set('Cookie', doctor)
        .send({ reason: 'Renal impairment noted after signing', item: course({ doseValue: 250 }) })
        .expect(201);

      expect(amended.body.version).toBe(2);
      expect(amended.body.supersedesId).toBe(itemId);
      expect(amended.body.status).toBe('ACTIVE');
      // Half a capsule, three times a day, five days: 7.5 rounded up.
      expect(amended.body.quantity).toBe(8);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      const original = read.body.items.find((i: { id: string }) => i.id === itemId);
      expect(original.status).toBe('SUPERSEDED');
      expect(original.isCurrent).toBe(false);
      expect(original.doseValue).toBe(500);

      // The pharmacy sees the current version, flagged as updated.
      const view = await request(harness.server)
        .get(`${API}/prescriptions/${read.body.prescription.id}/dispense-view`)
        .set('Cookie', pharmacist)
        .expect(200);
      expect(view.body.items).toHaveLength(1);
      expect(view.body.items[0]).toMatchObject({ id: amended.body.id, version: 2, updated: true });
    });

    it('will not delete something already prescribed', async () => {
      const { itemId } = await signedItem();
      await request(harness.server)
        .delete(`${API}/prescription-items/${itemId}`)
        .set('Cookie', doctor)
        .expect(409);
    });

    it('cancels with a reason and leaves the row behind', async () => {
      const { consultationId, itemId } = await signedItem();
      const cancelled = await request(harness.server)
        .post(`${API}/prescription-items/${itemId}/cancel`)
        .set('Cookie', doctor)
        .send({ reason: 'Patient already has a full course at home' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.cancelledReason).toContain('full course at home');

      // Nothing is left waiting, so the prescription is finished with.
      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.prescription.status).toBe('COMPLETED');
    });

    it('records a patient declining at the counter', async () => {
      const { itemId } = await signedItem();
      const declined = await request(harness.server)
        .post(`${API}/prescription-items/${itemId}/decline`)
        .set('Cookie', pharmacist)
        .send({ reason: 'Patient will buy it outside' })
        .expect(200);
      expect(declined.body.status).toBe('DECLINED');
    });

    it('refuses an amendment that would prescribe a severe allergen', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course({ productId: paracetamol, doseValue: 1000 }));
      await sign(consultationId);

      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'SEVERE',
      });

      const refused = await request(harness.server)
        .post(`${API}/prescription-items/${added.body.id}/amend`)
        .set('Cookie', doctor)
        .send({ reason: 'Switching to an antibiotic', item: course() })
        .expect(422);
      expect(refused.body.detail).toContain('severe allergy');
    });
  });

  // ------------------------------------------------- the pharmacy view

  describe('What the pharmacy sees (RX-R-10)', () => {
    it('shows the drug and the label, and not the diagnosis', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());
      await sign(consultationId);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);

      const view = await request(harness.server)
        .get(`${API}/prescriptions/${read.body.prescription.id}/dispense-view`)
        .set('Cookie', pharmacist)
        .expect(200);

      expect(view.body.items[0].labelText).toContain('Ambil');
      const body = JSON.stringify(view.body);
      expect(body).not.toContain('Tonsillitis');
      expect(body).not.toContain('Sore throat');
    });

    it('does not show a prescription that has not been signed', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());
      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      await request(harness.server)
        .get(`${API}/prescriptions/${read.body.prescription.id}/dispense-view`)
        .set('Cookie', pharmacist)
        .expect(404);
    });
  });

  // ------------------------------------------------------ module edge

  describe('Boundaries', () => {
    it('RX-T-09: prescribing never moves stock', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course());
      await sign(consultationId);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);

      // The ledger exists now. Nothing in it may point at a prescription
      // or at one of its items: what was intended is not what left the
      // shelf, and only dispensing may say the second thing.
      const referencing = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.stockMovement.count({
          where: {
            OR: [
              { referenceType: { in: ['prescription', 'prescription_item'] } },
              { referenceId: { in: [read.body.prescription.id, added.body.id] } },
            ],
          },
        }),
      );
      expect(referencing).toBe(0);
    });

    it('another doctor cannot prescribe on this consultation', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const other = await harness.addUser(fx, {
        name: 'Dr Locum',
        roles: [{ branchId: branch, role: Role.DOCTOR }],
      });
      const cookie = await signIn(harness, other.email);
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/prescription/items`)
        .set('Cookie', cookie)
        .send(course())
        .expect(404);
    });

    it('reception cannot prescribe at all', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/prescription/items`)
        .set('Cookie', reception)
        .send(course())
        .expect(403);
    });

    it('takes the prescription down with an abandoned consultation', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());

      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/cancel`)
        .set('Cookie', doctor)
        .send({ reason: 'Patient left before the consultation finished' })
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.prescription.status).toBe('CANCELLED');
    });

    it('removes the prescription entirely when the last draft item goes', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course());
      await request(harness.server)
        .delete(`${API}/prescription-items/${added.body.id}`)
        .set('Cookie', doctor)
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.prescription).toBeNull();
    });
  });

  // --------------------------------------------------- repeat and fav

  describe('Fast entry (RX-F-09, RX-F-10)', () => {
    it('repeats the last prescription, re-checking each item', async () => {
      const first = await consulting();
      await recordNkda(first.patientId);
      await addItem(first.consultationId, course());
      await sign(first.consultationId);
      await finish(first.encounterId);

      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId: first.patientId })
        .expect(201);
      for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
        await request(harness.server)
          .post(`${API}/encounters/${encounter.body.encounter.id}/transition`)
          .set('Cookie', doctor)
          .send({ to })
          .expect(200);
      }
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounter.body.encounter.id}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      // An allergy recorded between the two visits must show up on the copy.
      await recordAllergy(first.patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'MODERATE',
      });

      const repeated = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/prescription/repeat-last`)
        .set('Cookie', doctor)
        .expect(201);

      expect(repeated.body.copied).toBe(1);
      const warnings = repeated.body.items[0].warnings.map((w: { type: string }) => w.type);
      expect(warnings).toContain('ALLERGY');
      expect(warnings).toContain('DUPLICATE');
    });

    it('counts what the doctor prescribes', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      await addItem(consultationId, course());

      const favourites = await request(harness.server)
        .get(`${API}/me/rx-favourites`)
        .set('Cookie', doctor)
        .expect(200);
      const amox = favourites.body.items.find(
        (f: { productId: string }) => f.productId === amoxicillin,
      );
      expect(amox).toBeTruthy();
      expect(amox.uses).toBeGreaterThan(0);
      expect(amox.defaults).toMatchObject({ doseValue: 500, frequencyCode: 'TDS' });
    });

    it('checks a proposed set without saving any of it', async () => {
      const { consultationId, patientId } = await consulting();
      await recordAllergy(patientId, {
        substance: 'Amoxicillin',
        productId: amoxicillin,
        severity: 'SEVERE',
      });

      const checked = await request(harness.server)
        .post(`${API}/consultations/${consultationId}/prescription/check`)
        .set('Cookie', doctor)
        .send({ items: [course()] })
        .expect(200);

      expect(checked.body.items[0].quantity).toBe(15);
      expect(checked.body.items[0].warnings[0]).toMatchObject({ level: 'EXACT' });

      const read = await request(harness.server)
        .get(`${API}/consultations/${consultationId}/prescription`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.prescription).toBeNull();
    });
  });

  describe('Labels (RX-F-07)', () => {
    it('rebuilds every label when the language changes', async () => {
      const { consultationId, patientId } = await consulting();
      await recordNkda(patientId);
      const added = await addItem(consultationId, course({ instructions: 'after food' }));
      expect(added.body.labelText).toContain('Ambil');

      const updated = await request(harness.server)
        .put(`${API}/consultations/${consultationId}/prescription/notes`)
        .set('Cookie', doctor)
        .send({ language: 'EN', notesToDispenser: 'Counsel on completing the course' })
        .expect(200);

      expect(updated.body.prescription.language).toBe('EN');
      expect(updated.body.items[0].labelText).toContain('Take 1 capsule');
      expect(updated.body.items[0].labelText).not.toContain('Ambil');
    });
  });
});
