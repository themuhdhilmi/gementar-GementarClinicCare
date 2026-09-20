import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
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

function inYears(years: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), 15))
    .toISOString()
    .slice(0, 10);
}

describe('PRC — procedures', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let nurse: string;
  let reception: string;
  let branch: string;

  let mask: string;
  let respule: string;
  let fluVaccine: string;
  let nebuliser: string;
  let minorSurgery: string;
  let consentedProcedure: string;
  let fluShot: string;

  let seq = 0;

  async function addProduct(over: Record<string, unknown>): Promise<string> {
    seq += 1;
    const response = await request(harness.server)
      .post(`${API}/products`)
      .set('Cookie', admin)
      .send({ type: 'CONSUMABLE', dispenseUnit: 'pcs', sellingPrice: 1, ...over })
      .expect(201);
    return response.body.id as string;
  }

  async function addProcedure(body: Record<string, unknown>): Promise<string> {
    const response = await request(harness.server)
      .post(`${API}/procedure-catalog`)
      .set('Cookie', admin)
      .send(body)
      .expect(201);
    return response.body.id as string;
  }

  async function stockIn(lines: Record<string, unknown>[]) {
    await request(harness.server)
      .post(`${API}/branches/${branch}/stock-in`)
      .set('Cookie', admin)
      .send({ lines })
      .expect(201);
  }

  async function onHand(productId: string): Promise<number> {
    const response = await request(harness.server)
      .get(`${API}/branches/${branch}/batches?productId=${productId}`)
      .set('Cookie', admin)
      .expect(200);
    return (response.body.items as Array<{ quantityOnHand: number; status: string }>)
      .filter((b) => b.status === 'ACTIVE')
      .reduce((sum, b) => sum + b.quantityOnHand, 0);
  }

  /** A patient with the doctor, mid-consultation. */
  async function consulting() {
    seq += 1;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Procedure Patient ${seq}`,
        idType: 'NONE',
        gender: 'FEMALE',
        dateOfBirth: new Date(Date.UTC(1970, 0, 1 + seq)).toISOString().slice(0, 10),
        notes: 'Test patient',
        phone: `014-${String(70_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    const patientId = patient.body.patient.id as string;

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
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
    return { patientId, encounterId };
  }

  async function order(encounterId: string, procedureId: string, cookie = doctor, status = 201) {
    const response = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/procedures`)
      .set('Cookie', cookie)
      .send({ procedureId })
      .expect(status);
    return response;
  }

  async function orderedId(encounterId: string, procedureId: string): Promise<string> {
    const response = await order(encounterId, procedureId);
    const items = response.body.items as Array<{ id: string; procedureId: string; status: string }>;
    return items.filter((i) => i.procedureId === procedureId && i.status === 'ORDERED').at(-1)!.id;
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('procedure');
    branch = fx.branchAId;

    const nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Siti',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });

    [doctor, reception, nurse] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, nurseUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);

    mask = await addProduct({ name: 'Nebuliser mask', isBatched: false, dispenseUnit: 'pcs' });
    respule = await addProduct({
      name: 'Salbutamol respule',
      type: 'MEDICINE',
      genericName: 'Salbutamol',
      drugClass: 'beta agonists',
      dispenseUnit: 'pcs',
    });
    fluVaccine = await addProduct({
      name: 'Influenza vaccine',
      type: 'MEDICINE',
      genericName: 'Influenza vaccine',
      dispenseUnit: 'vial',
      isColdChain: true,
    });

    await stockIn([
      { productId: mask, quantity: 100 },
      { productId: respule, batchNo: 'RESP-1', expiry: inYears(2), quantity: 50 },
      { productId: fluVaccine, batchNo: 'FLU-2026A', expiry: inYears(1), quantity: 20 },
    ]);

    nebuliser = await addProcedure({
      name: 'Nebuliser (salbutamol)',
      category: 'NEBULISER',
      price: 25,
      consumables: [
        { productId: mask, quantity: 1 },
        { productId: respule, quantity: 1 },
      ],
    });

    minorSurgery = await addProcedure({
      name: 'Incision and drainage',
      category: 'MINOR_SURGERY',
      price: 150,
      requiresDoctor: true,
      requiresConsent: true,
    });

    consentedProcedure = await addProcedure({
      name: 'Ear syringing',
      category: 'OTHER',
      price: 40,
      requiresConsent: true,
    });

    fluShot = await addProcedure({
      name: 'Influenza vaccination',
      category: 'VACCINATION',
      price: 60,
      vaccineProductId: fluVaccine,
      consumables: [{ productId: fluVaccine, quantity: 1 }],
    });
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  });

  // -------------------------------------------------------- catalogue

  describe('The catalogue (PRC-F-01 … F-04)', () => {
    it('gives a procedure a readable code from its category', async () => {
      const read = await request(harness.server)
        .get(`${API}/procedure-catalog/${nebuliser}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.code).toMatch(/^NEB-\d{4}$/);
      expect(read.body.price).toBe('25.00');
      expect(read.body.consumables).toHaveLength(2);
    });

    it('PRC-F-03: refuses a vaccination that names no vaccine', async () => {
      const refused = await request(harness.server)
        .post(`${API}/procedure-catalog`)
        .set('Cookie', admin)
        .send({ name: 'Mystery jab', category: 'VACCINATION', price: 10 })
        .expect(400);
      expect(refused.body.detail).toContain('name the vaccine');
    });

    it('keeps a price history', async () => {
      const id = await addProcedure({ name: 'Wound dressing', category: 'DRESSING', price: 20 });
      await request(harness.server)
        .patch(`${API}/procedure-catalog/${id}`)
        .set('Cookie', admin)
        .send({ price: 25, priceReason: 'Materials went up' })
        .expect(200);

      const history = await request(harness.server)
        .get(`${API}/procedure-catalog/${id}/price-history`)
        .set('Cookie', admin)
        .expect(200);
      expect(history.body.map((h: { price: string }) => h.price)).toEqual(['25.00', '20.00']);
      expect(history.body[0].reason).toBe('Materials went up');
    });

    it('does not blank fields that were left out of a patch', async () => {
      const id = await addProcedure({
        name: 'Suture removal',
        category: 'OTHER',
        price: 30,
        requiresConsent: true,
        protocol: 'Check for infection first.',
      });
      await request(harness.server)
        .patch(`${API}/procedure-catalog/${id}`)
        .set('Cookie', admin)
        .send({ price: 35 })
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/procedure-catalog/${id}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(read.body.requiresConsent).toBe(true);
      expect(read.body.protocol).toBe('Check for infection first.');
      expect(read.body.name).toBe('Suture removal');
    });
  });

  // ------------------------------------------------------- performing

  describe('Performing (PRC-F-07, PRC-F-08)', () => {
    it('PRC-T-01: deducts every mapped consumable, in one transaction', async () => {
      const masksBefore = await onHand(mask);
      const respulesBefore = await onHand(respule);

      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);

      const performed = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ notes: 'Tolerated well' })
        .expect(200);

      expect(performed.body.status).toBe('PERFORMED');
      expect(performed.body.used).toHaveLength(2);
      expect(await onHand(mask)).toBe(masksBefore - 1);
      expect(await onHand(respule)).toBe(respulesBefore - 1);

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=CONSUME`)
        .set('Cookie', admin)
        .expect(200);
      const mine = movements.body.items.filter(
        (m: { referenceId: string }) => m.referenceId === id,
      );
      expect(mine).toHaveLength(2);
      expect(mine.every((m: { quantity: number }) => m.quantity === -1)).toBe(true);
    });

    it('PRC-T-02: a nurse cannot perform one that needs a doctor', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, minorSurgery);

      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ consentGiven: true, consentBy: 'The patient', site: 'Left forearm' })
        .expect(403);
      expect(refused.body.detail).toContain('performed by a doctor');

      // And the doctor can.
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', doctor)
        .send({ consentGiven: true, consentBy: 'The patient', site: 'Left forearm' })
        .expect(200);
    });

    it('PRC-T-03: refuses one that needs consent when none is recorded', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, consentedProcedure);

      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(422);
      expect(refused.body.detail).toContain('consent');

      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ consentGiven: true, consentBy: 'The patient' })
        .expect(200);
    });

    it('PRC-T-04: a vaccination records the batch and expiry on the patient', async () => {
      const { encounterId, patientId } = await consulting();
      const id = await orderedId(encounterId, fluShot);

      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ site: 'Left deltoid', laterality: 'LEFT', doseNumber: 1 })
        .expect(200);

      const records = await request(harness.server)
        .get(`${API}/patients/${patientId}/vaccinations`)
        .set('Cookie', doctor)
        .expect(200);

      expect(records.body.items).toHaveLength(1);
      expect(records.body.items[0]).toMatchObject({
        vaccineName: 'Influenza vaccine',
        batchNo: 'FLU-2026A',
        site: 'Left deltoid',
        doseNumber: 1,
        withdrawn: false,
      });
      expect(records.body.items[0].expiry).toBeTruthy();
      expect(records.body.items[0].givenByName).toBe('Jururawat Siti');
    });

    it('insists on a site for an injection or a dressing', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, fluShot);
      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(400);
      expect(refused.body.detail).toContain('where on the body');
    });

    it('lets the nurse change what was actually used', async () => {
      const masksBefore = await onHand(mask);
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);

      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ consumables: [{ productId: mask, quantity: 2 }] })
        .expect(200);

      expect(await onHand(mask)).toBe(masksBefore - 2);
    });

    it('refuses when there is not enough, and records it when told to', async () => {
      const scarce = await addProduct({ name: `Scarce swab ${seq}`, isBatched: false });
      await stockIn([{ productId: scarce, quantity: 1 }]);
      const procedure = await addProcedure({
        name: `Swabbing ${seq}`,
        category: 'OTHER',
        price: 5,
        consumables: [{ productId: scarce, quantity: 3 }],
      });

      const first = await consulting();
      const id = await orderedId(first.encounterId, procedure);
      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(422);
      expect(refused.body.detail).toContain('not enough');

      // The nurse used some from a box nobody had entered. The clinical
      // fact is recorded; the shortfall is flagged rather than hidden.
      const done = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ allowShortfall: true })
        .expect(200);
      expect(done.body.status).toBe('PERFORMED');
      expect(done.body.shortfalls[0]).toMatchObject({ wanted: 3, short: 2 });
      expect(await onHand(scarce)).toBe(0);
    });

    it('will not perform the same one twice', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      const again = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(409);
      expect(again.body.detail).toContain('already been done');
    });
  });

  // ------------------------------------------------ price and voiding

  describe('Price and voiding (PRC-F-09, F-10, PRC-T-05, T-06)', () => {
    it('PRC-T-06: a price change after ordering does not change what was ordered', async () => {
      const procedure = await addProcedure({
        name: `Steady price ${seq}`,
        category: 'OTHER',
        price: 30,
      });
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, procedure);

      await request(harness.server)
        .patch(`${API}/procedure-catalog/${procedure}`)
        .set('Cookie', admin)
        .send({ price: 90, priceReason: 'Reviewed' })
        .expect(200);

      const performed = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      expect(performed.body.price).toBe('30.00');
    });

    it('PRC-T-05: voiding within a day puts the stock back', async () => {
      const masksBefore = await onHand(mask);
      const respulesBefore = await onHand(respule);

      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      expect(await onHand(mask)).toBe(masksBefore - 1);

      const voided = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Recorded against the wrong patient at the counter' })
        .expect(200);

      expect(voided.body.status).toBe('VOIDED');
      expect(await onHand(mask)).toBe(masksBefore);
      expect(await onHand(respule)).toBe(respulesBefore);

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=CONSUME_REVERSAL`)
        .set('Cookie', admin)
        .expect(200);
      expect(
        movements.body.items.filter((m: { referenceId: string }) => m.referenceId === id),
      ).toHaveLength(2);

      // Each consumable line knows it was put back.
      const read = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/procedures`)
        .set('Cookie', doctor)
        .expect(200);
      const row = read.body.items.find((i: { id: string }) => i.id === id);
      expect(row.used.every((u: { reversed: boolean }) => u.reversed)).toBe(true);
    });

    it('wants a sentence before it reverses anything', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'oops' })
        .expect(400);
    });

    it('a nurse cannot void', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/void`)
        .set('Cookie', nurse)
        .send({ reason: 'Recorded against the wrong patient entirely' })
        .expect(403);
    });

    it('cancels an order that is not going to happen', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      const cancelled = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/cancel`)
        .set('Cookie', nurse)
        .send({ reason: 'Patient felt better and went home' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
    });

    it('will not cancel something already done', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);
      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/cancel`)
        .set('Cookie', nurse)
        .send({ reason: 'Changed my mind' })
        .expect(409);
      expect(refused.body.detail).toContain('Void it instead');
    });

    it('a voided vaccination stays on the record, marked as withdrawn', async () => {
      const { encounterId, patientId } = await consulting();
      const id = await orderedId(encounterId, fluShot);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({ site: 'Right deltoid' })
        .expect(200);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Entered against the wrong patient by the front desk' })
        .expect(200);

      const records = await request(harness.server)
        .get(`${API}/patients/${patientId}/vaccinations`)
        .set('Cookie', doctor)
        .expect(200);
      expect(records.body.items).toHaveLength(1);
      expect(records.body.items[0].withdrawn).toBe(true);
      expect(records.body.items[0].withdrawnReason).toContain('wrong patient');
    });
  });

  // ------------------------------------------------- the nurse's board

  describe('The queue and the visit (PRC-F-12)', () => {
    it('lists who is waiting, with what is ordered for them', async () => {
      const { encounterId } = await consulting();
      await order(encounterId, nebuliser);

      const queue = await request(harness.server)
        .get(`${API}/branches/${branch}/procedures/queue`)
        .set('Cookie', nurse)
        .expect(200);

      const row = queue.body.items.find(
        (i: { encounterId: string }) => i.encounterId === encounterId,
      );
      expect(row).toBeTruthy();
      expect(row.patient.name).toContain('Procedure Patient');
      expect(row.items[0].name).toBe('Nebuliser (salbutamol)');
    });

    it('drops off the queue once it is done', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);
      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(200);

      const queue = await request(harness.server)
        .get(`${API}/branches/${branch}/procedures/queue`)
        .set('Cookie', nurse)
        .expect(200);
      expect(
        queue.body.items.find((i: { encounterId: string }) => i.encounterId === encounterId),
      ).toBeUndefined();
    });

    it('PRC-F-06: a nurse cannot start one unasked while the clinic says no', async () => {
      const { encounterId } = await consulting();
      const refused = await order(encounterId, nebuliser, nurse, 403);
      expect(refused.body.detail).toContain('without a doctor');
    });

    it('signing a note with a procedure on it sends the patient for it', async () => {
      const { encounterId } = await consulting();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      const consultationId = created.body.id as string;

      await request(harness.server)
        .patch(`${API}/consultations/${consultationId}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Wheezing' })
        .expect(200);
      await request(harness.server)
        .put(`${API}/consultations/${consultationId}/diagnoses`)
        .set('Cookie', doctor)
        .send({ diagnoses: [{ rank: 'PRIMARY', description: 'Asthma', certainty: 'CONFIRMED' }] })
        .expect(200);
      await order(encounterId, nebuliser);

      const signed = await request(harness.server)
        .post(`${API}/consultations/${consultationId}/sign`)
        .set('Cookie', doctor)
        .send({})
        .expect(200);
      expect(signed.body.routedTo).toBe('PROCEDURE_WAITING');
    });

    it('ENC-F-10: a visit cannot be finished with a procedure still waiting', async () => {
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, nebuliser);

      const blocked = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(422);
      expect(JSON.stringify(blocked.body)).toContain('has not been done');

      await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/cancel`)
        .set('Cookie', nurse)
        .send({ reason: 'Patient declined it' })
        .expect(200);

      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(200);
    });
  });

  describe('Boundaries', () => {
    it('PRC-T-09 equivalent: a blocked batch is never consumed', async () => {
      const product = await addProduct({ name: `Recalled swab ${seq}` , isBatched: true });
      await stockIn([{ productId: product, batchNo: 'REC-1', expiry: inYears(2), quantity: 10 }]);
      const batches = await request(harness.server)
        .get(`${API}/branches/${branch}/batches?productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      await request(harness.server)
        .post(`${API}/batches/${batches.body.items[0].id}/block`)
        .set('Cookie', admin)
        .send({ reason: 'Manufacturer recall notice 2026/200' })
        .expect(200);

      const procedure = await addProcedure({
        name: `Recalled use ${seq}`,
        category: 'OTHER',
        price: 5,
        consumables: [{ productId: product, quantity: 1 }],
      });
      const { encounterId } = await consulting();
      const id = await orderedId(encounterId, procedure);

      const refused = await request(harness.server)
        .post(`${API}/encounter-procedures/${id}/perform`)
        .set('Cookie', nurse)
        .send({})
        .expect(422);
      expect(refused.body.detail).toContain('not enough');
    });

    it('reception cannot order or perform', async () => {
      const { encounterId } = await consulting();
      await order(encounterId, nebuliser, reception, 403);
    });
  });
});
