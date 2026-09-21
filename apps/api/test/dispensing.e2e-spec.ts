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

/** A date `months` out, on the 15th. */
function inMonths(months: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 15))
    .toISOString()
    .slice(0, 10);
}

describe('DSP — dispensing', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let dispenser: string;
  let nurse: string;
  let cashier: string;
  let branch: string;

  let seq = 0;

  async function addProduct(over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const response = await request(harness.server)
      .post(`${API}/products`)
      .set('Cookie', admin)
      .send({
        name: `Amoxicillin ${seq}`,
        type: 'MEDICINE',
        genericName: `Amoxicillin ${seq}`,
        drugClass: 'penicillins',
        strengthText: '500 mg',
        strengthValue: 500,
        strengthUnit: 'mg',
        dispenseUnit: 'cap',
        sellingPrice: 0.5,
        ...over,
      })
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

  async function batchesOf(productId: string) {
    const response = await request(harness.server)
      .get(`${API}/branches/${branch}/batches?productId=${productId}`)
      .set('Cookie', admin)
      .expect(200);
    return response.body.items as Array<{
      id: string;
      batchNo: string;
      quantityOnHand: number;
      quantityQuarantined: number;
      status: string;
    }>;
  }

  async function onHand(productId: string): Promise<number> {
    return (await batchesOf(productId))
      .filter((b) => b.status === 'ACTIVE')
      .reduce((sum, b) => sum + b.quantityOnHand, 0);
  }

  /**
   * A patient seen, prescribed `items`, and signed — so they are sitting
   * at the pharmacy with an active prescription.
   */
  async function prescribed(items: Array<Record<string, unknown>>) {
    seq += 1;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Dispense Patient ${seq}`,
        idType: 'MYKAD',
        // A real day of a real month: the day part has to stay inside
        // 01–28 however far `seq` runs.
        idNumber: `8801${String(1 + (seq % 28)).padStart(2, '0')}-14-${String(1000 + seq).slice(-4)}`,
        gender: 'MALE',
        dateOfBirth: new Date(Date.UTC(1970, 0, 1 + seq)).toISOString().slice(0, 10),
        phone: `017-${String(80_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    const patientId = patient.body.patient.id as string;

    await request(harness.server)
      .put(`${API}/patients/${patientId}/nkda`)
      .set('Cookie', doctor)
      .send({ nkda: true })
      .expect(200);

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

    for (const item of items) {
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/prescription/items`)
        .set('Cookie', doctor)
        .send({
          doseValue: 1,
          doseUnit: 'cap',
          route: 'PO',
          frequencyCode: 'TDS',
          durationDays: 5,
          ...item,
        })
        .expect(201);
    }

    await request(harness.server)
      .post(`${API}/consultations/${consultationId}/sign`)
      .set('Cookie', doctor)
      .send({})
      .expect(200);

    return { patientId, encounterId, consultationId };
  }

  async function openSession(encounterId: string, cookie = dispenser) {
    const response = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/dispense`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    return response.body as {
      id: string;
      items: Array<{
        prescriptionItemId: string;
        displayName: string;
        prescribedQuantity: number;
        suggestion: Array<{ batchId: string; batchNo: string; quantity: number }>;
        shortfall: number;
        isControlled: boolean;
        amendedSinceOpen: boolean;
      }>;
    };
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('dispensing');
    branch = fx.branchAId;

    const dispenserUser = await harness.addUser(fx, {
      name: 'Dispenser Lim',
      roles: [{ branchId: fx.branchAId, role: Role.DISPENSER }],
    });
    const nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Hana',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    const cashierUser = await harness.addUser(fx, {
      name: 'Juruwang Siva',
      roles: [{ branchId: fx.branchAId, role: Role.CASHIER }],
    });

    [doctor, reception, dispenser, nurse, cashier] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, dispenserUser.email),
      signIn(harness, nurseUser.email),
      signIn(harness, cashierUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------------- FEFO

  describe('Choosing a batch (DSP-F-03, DSP-T-01 … T-03)', () => {
    it('DSP-T-01: takes it all from the batch that expires first', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'B1', expiry: inMonths(14), quantity: 10 },
        { productId: product, batchNo: 'B2', expiry: inMonths(12), quantity: 30 },
      ]);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);

      expect(session.items[0]?.suggestion).toHaveLength(1);
      expect(session.items[0]?.suggestion[0]).toMatchObject({ batchNo: 'B2', quantity: 15 });
    });

    it('DSP-T-02: splits across batches, earliest first', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'C1', expiry: inMonths(12), quantity: 10 },
        { productId: product, batchNo: 'C2', expiry: inMonths(14), quantity: 30 },
      ]);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);

      expect(session.items[0]?.suggestion).toEqual([
        expect.objectContaining({ batchNo: 'C1', quantity: 10 }),
        expect.objectContaining({ batchNo: 'C2', quantity: 5 }),
      ]);
    });

    it('DSP-T-03: an expired batch cannot be chosen', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'D1', expiry: inMonths(12), quantity: 20 }]);
      const [good] = await batchesOf(product);

      // Age it past its date behind the application's back, the way
      // time would.
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.productBatch.update({
          where: { id: good!.id },
          data: { expiryDate: new Date('2020-01-31T00:00:00.000Z') },
        }),
      );

      const { encounterId } = await prescribed([{ productId: product, quantity: 5 }]);
      const session = await openSession(encounterId);
      // It is not offered at all.
      expect(session.items[0]?.suggestion).toEqual([]);
      expect(session.items[0]?.shortfall).toBe(5);

      // And it cannot be forced.
      const refused = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({
          quantity: 5,
          batches: [{ batchId: good!.id, quantity: 5, overrideReason: 'It is all we have' }],
        })
        .expect(422);
      expect(refused.body.detail).toContain('expired');
    });

    it('DSP-T-10: choosing another batch without a reason is refused', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'E1', expiry: inMonths(12), quantity: 20 },
        { productId: product, batchNo: 'E2', expiry: inMonths(20), quantity: 20 },
      ]);
      const batches = await batchesOf(product);
      const later = batches.find((b) => b.batchNo === 'E2')!;

      const { encounterId } = await prescribed([{ productId: product, quantity: 5 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;

      const refused = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ quantity: 5, batches: [{ batchId: later.id, quantity: 5 }] })
        .expect(422);
      expect(refused.body.detail).toContain('expires first');

      const allowed = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({
          quantity: 5,
          batches: [
            { batchId: later.id, quantity: 5, overrideReason: 'The earlier box is physically empty' },
          ],
        })
        .expect(200);
      expect(allowed.body.batches[0]).toMatchObject({ wasSuggested: false });
    });

    it('does not promise the same stock to two lines of one prescription', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'F1', expiry: inMonths(12), quantity: 12 }]);

      const { encounterId } = await prescribed([
        { productId: product, quantity: 10 },
        { productId: product, quantity: 10, instructions: 'second course' },
      ]);
      const session = await openSession(encounterId);

      const first = session.items[0]!;
      const second = session.items[1]!;
      expect(first.suggestion.reduce((s, p) => s + p.quantity, 0)).toBe(10);
      // Only two left for the second line, and it says so rather than
      // promising ten that are not there.
      expect(second.suggestion.reduce((s, p) => s + p.quantity, 0)).toBe(2);
      expect(second.shortfall).toBe(8);
    });
  });

  // -------------------------------------------------------- dispensing

  describe('Handing it over (DSP-F-10, DSP-T-04 … T-08)', () => {
    it('DSP-T-04: moves the stock and records the line, together', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'G1', expiry: inMonths(12), quantity: 40 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;

      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      expect(done.body.outcome).toBe('DISPENSED');
      expect(done.body.quantity).toBe(15);
      expect(done.body.lineTotal).toBe('7.50');
      expect(await onHand(product)).toBe(before - 15);

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=DISPENSE&productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      const mine = movements.body.items.filter(
        (m: { referenceId: string }) => m.referenceId === done.body.id,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ quantity: -15, referenceType: 'dispense_item' });
    });

    it('DSP-T-04 (rollback): a failure after the movement leaves nothing behind', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'H1', expiry: inMonths(12), quantity: 20 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 5 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;
      const batches = await batchesOf(product);

      // The batch lines must add up to the quantity. Sending one that
      // does not fails the deferred constraint at commit, after the
      // movement has already been written — which is precisely the
      // "forced failure after the insert" this test is for.
      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ quantity: 5, batches: [{ batchId: batches[0]!.id, quantity: 4 }] })
        .expect(400);

      expect(await onHand(product)).toBe(before);
      const after = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(after.body.items[0].dispensed).toBeNull();
    });

    it('DSP-T-05: twenty at once never go below zero', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'I1', expiry: inMonths(12), quantity: 10 }]);

      // Ten separate prescriptions of 1, dispensed simultaneously, from
      // a shelf of ten. Then an eleventh must fail.
      const sessions = [];
      for (let i = 0; i < 12; i += 1) {
        const { encounterId } = await prescribed([{ productId: product, quantity: 1 }]);
        const session = await openSession(encounterId);
        sessions.push(session);
      }

      const results = await Promise.all(
        sessions.map((session) =>
          request(harness.server)
            .post(
              `${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`,
            )
            .set('Cookie', dispenser)
            .send({}),
        ),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(10);
      expect(await onHand(product)).toBe(0);
    });

    it('DSP-T-06: the same idempotency key dispenses once', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'J1', expiry: inMonths(12), quantity: 40 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;
      const key = `test-${newId()}`;

      const first = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ idempotencyKey: key })
        .expect(200);

      const second = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ idempotencyKey: key })
        .expect(200);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.replayed).toBe(true);
      expect(await onHand(product)).toBe(before - 15);
    });

    it('DSP-T-07: the completed event carries the price actually charged', async () => {
      const product = await addProduct({ sellingPrice: 1.25 });
      await stockIn([{ productId: product, batchNo: 'K1', expiry: inMonths(12), quantity: 40 }]);

      const { encounterId } = await prescribed([{ productId: product, quantity: 4 }]);
      const session = await openSession(encounterId);
      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      expect(done.body.unitPrice).toBe('1.25');
      expect(done.body.lineTotal).toBe('5.00');

      // DSP-R-09: a later price change does not rewrite it.
      await request(harness.server)
        .patch(`${API}/products/${product}`)
        .set('Cookie', admin)
        .send({ sellingPrice: 9.99, priceReason: 'Supplier increase' })
        .expect(200);

      const read = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(read.body.items[0].dispensed.lineTotal).toBe('5.00');
    });

    it('DSP-T-08: an undo puts it back and says so in the ledger', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'L1', expiry: inMonths(12), quantity: 40 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);
      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);
      expect(await onHand(product)).toBe(before - 15);

      await request(harness.server)
        .post(`${API}/dispense-items/${done.body.id}/undo`)
        .set('Cookie', doctor)
        .send({ reason: 'Wrong batch scanned' })
        .expect(200);

      expect(await onHand(product)).toBe(before);
      const reversals = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=DISPENSE_REVERSAL&productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      expect(reversals.body.items).toHaveLength(1);

      // And the item is waiting again.
      const read = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(read.body.items[0].status).toBe('ACTIVE');
      expect(read.body.items[0].dispensed).toBeNull();
    });

    it('refuses to hand over more than was prescribed', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'M1', expiry: inMonths(12), quantity: 40 }]);

      const { encounterId } = await prescribed([{ productId: product, quantity: 10 }]);
      const session = await openSession(encounterId);
      const refused = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ quantity: 12 })
        .expect(422);
      expect(refused.body.detail).toContain('10');
    });

    it('DSP-F-05: a partial needs a reason, and leaves the item waiting', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'N1', expiry: inMonths(12), quantity: 40 }]);

      const { encounterId } = await prescribed([{ productId: product, quantity: 30 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;

      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ quantity: 12 })
        .expect(400);

      const partial = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ quantity: 12, reason: 'Only twelve on the shelf' })
        .expect(200);
      expect(partial.body.outcome).toBe('PARTIAL');

      const read = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(read.body.items[0].status).toBe('PARTIAL');
    });

    it('DSP-F-06: rounds a pack up and says what it did', async () => {
      const syrup = await addProduct({
        name: `Syrup ${seq + 500}`,
        dispenseUnit: 'ml',
        isPackDispensed: true,
        packSize: 60,
        isBatched: true,
        sellingPrice: 0.1,
      });
      await stockIn([{ productId: syrup, batchNo: 'S1', expiry: inMonths(12), quantity: 300 }]);

      const { encounterId } = await prescribed([
        { productId: syrup, quantity: 37.5, doseUnit: 'ml', doseValue: 2.5 },
      ]);
      const session = await openSession(encounterId);
      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      expect(done.body.quantity).toBe(60);
      expect(done.body.packRounded).toBe(true);
      expect(done.body.outcomeReason).toContain('1 pack of 60');
    });
  });

  // ---------------------------------------------------- not dispensed

  describe('When nothing is handed over (DSP-F-08)', () => {
    it('records a decline with a reason and bills nothing', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'O1', expiry: inMonths(12), quantity: 20 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 10 }]);
      const session = await openSession(encounterId);
      const declined = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ outcome: 'DECLINED', reason: 'Patient says they still have some at home' })
        .expect(200);

      expect(declined.body.outcome).toBe('DECLINED');
      expect(declined.body.lineTotal).toBe('0.00');
      expect(await onHand(product)).toBe(before);
    });

    it('wants a reason before it records one', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'P1', expiry: inMonths(12), quantity: 20 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 10 }]);
      const session = await openSession(encounterId);
      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ outcome: 'DECLINED' })
        .expect(400);
    });
  });

  // ------------------------------------------------------ substitution

  describe('Substituting (DSP-F-07, DSP-T-11)', () => {
    it('DSP-T-11: another brand of the same generic is routine', async () => {
      const brand = await addProduct({ name: `Brandname ${seq + 600}`, genericName: 'Shared Generic A' });
      const generic = await addProduct({ name: `Generic ${seq + 601}`, genericName: 'Shared Generic A' });
      await stockIn([
        { productId: brand, batchNo: 'Q1', expiry: inMonths(12), quantity: 5 },
        { productId: generic, batchNo: 'Q2', expiry: inMonths(12), quantity: 50 },
      ]);
      const genericBefore = await onHand(generic);

      const { encounterId } = await prescribed([{ productId: brand, quantity: 15 }]);
      const session = await openSession(encounterId);

      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/substitute`)
        .set('Cookie', dispenser)
        .send({ productId: generic, reason: 'Brand out of stock' })
        .expect(200);

      expect(await onHand(generic)).toBe(genericBefore - 15);

      const read = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(read.body.items[0].status).toBe('DISPENSED');
    });

    it('DSP-T-11: a different generic is a prescribing decision', async () => {
      const prescribedProduct = await addProduct({ genericName: 'Generic One B' });
      const other = await addProduct({ genericName: 'Generic Two B' });
      await stockIn([
        { productId: prescribedProduct, batchNo: 'R1', expiry: inMonths(12), quantity: 20 },
        { productId: other, batchNo: 'R2', expiry: inMonths(12), quantity: 20 },
      ]);

      const { encounterId } = await prescribed([{ productId: prescribedProduct, quantity: 10 }]);
      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;

      // A nurse may dispense and may not substitute a different
      // medicine; a dispenser and a doctor both hold the permission
      // that says they may.
      const refused = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/substitute`)
        .set('Cookie', nurse)
        .send({ productId: other, reason: 'Nothing else left' })
        .expect(403);
      expect(refused.body.detail).toContain('prescribing decision');

      // A doctor holds `dispense.substitute`, and may.
      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${rxItemId}/substitute`)
        .set('Cookie', doctor)
        .send({ productId: other, reason: 'Agreed with the prescriber by telephone' })
        .expect(200);
    });
  });

  // ------------------------------------------------- controlled drugs

  describe('Controlled drugs (DSP-F-18, F-19, DSP-T-09)', () => {
    async function controlledProduct() {
      const product = await addProduct({
        name: `Tramadol ${seq + 700}`,
        genericName: `Tramadol ${seq + 700}`,
        drugClass: 'opioids',
        isControlled: true,
        sellingPrice: 0.8,
      });
      await stockIn([{ productId: product, batchNo: 'T1', expiry: inMonths(18), quantity: 100 }]);
      return product;
    }

    it('DSP-T-09: dispensing writes a register row with a running balance', async () => {
      const product = await controlledProduct();

      const first = await prescribed([{ productId: product, quantity: 10 }]);
      const session = await openSession(first.encounterId);
      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      const second = await prescribed([{ productId: product, quantity: 6 }]);
      const session2 = await openSession(second.encounterId);
      await request(harness.server)
        .post(`${API}/dispenses/${session2.id}/items/${session2.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({ register: { witnessName: 'Nurse on duty' } })
        .expect(200);

      const register = await request(harness.server)
        .get(`${API}/branches/${branch}/controlled-register?productId=${product}`)
        .set('Cookie', admin)
        .expect(200);

      expect(register.body.items).toHaveLength(2);
      expect(register.body.items[0]).toMatchObject({
        entryType: 'DISPENSE',
        quantityOut: 10,
        balanceAfter: -10,
      });
      expect(register.body.items[1]).toMatchObject({ quantityOut: 6, balanceAfter: -16 });
      // The patient's identity number is recorded in full, on purpose.
      expect(register.body.items[0].patientIc).toMatch(/\d/);
      expect(register.body.items[1].witnessName).toBe('Nurse on duty');
    });

    it('will not dispense a controlled drug to a patient with no identity number', async () => {
      const product = await controlledProduct();
      seq += 1;
      const patient = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send({
          name: `No Card ${seq}`,
          idType: 'NONE',
          notes: 'No identity document',
          gender: 'MALE',
          dateOfBirth: new Date(Date.UTC(1969, 0, 1 + seq)).toISOString().slice(0, 10),
          phone: `018-${String(90_000_000 + seq).slice(0, 8)}`,
        })
        .expect(201);
      const patientId = patient.body.patient.id as string;
      await request(harness.server)
        .put(`${API}/patients/${patientId}/nkda`)
        .set('Cookie', doctor)
        .send({ nkda: true })
        .expect(200);

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
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Back pain' })
        .expect(200);
      await request(harness.server)
        .put(`${API}/consultations/${created.body.id}/diagnoses`)
        .set('Cookie', doctor)
        .send({ diagnoses: [{ rank: 'PRIMARY', description: 'Lumbago', certainty: 'CONFIRMED' }] })
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/prescription/items`)
        .set('Cookie', doctor)
        .send({
          productId: product,
          doseValue: 1,
          doseUnit: 'cap',
          route: 'PO',
          frequencyCode: 'TDS',
          durationDays: 2,
          quantity: 6,
        })
        .expect(201);
      await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', doctor)
        .send({})
        .expect(200);

      const session = await openSession(encounterId);
      const refused = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(422);
      expect(refused.body.detail).toContain('identity number');
    });

    it('DSP-F-19: reconciles the register against the shelf', async () => {
      const result = await request(harness.server)
        .get(`${API}/branches/${branch}/controlled-register/reconciliation`)
        .set('Cookie', admin)
        .expect(200);
      expect(result.body.items.length).toBeGreaterThan(0);
      expect(result.body.summary).toContain('controlled products');
    });

    it('the register cannot be edited or deleted', async () => {
      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.controlledDrugRegister.findFirst(),
      );
      expect(row).toBeTruthy();

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.controlledDrugRegister.update({
            where: { id: row!.id },
            data: { quantityOut: 1 },
          }),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.controlledDrugRegister.delete({ where: { id: row!.id } }),
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ---------------------------------------------- the session and queue

  describe('The session (DSP-F-01, F-09, F-12, F-14)', () => {
    it('lists who is waiting, with the controlled flag', async () => {
      const product = await addProduct({ isControlled: true });
      await stockIn([{ productId: product, batchNo: 'U1', expiry: inMonths(12), quantity: 20 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 6 }]);

      const queue = await request(harness.server)
        .get(`${API}/branches/${branch}/pharmacy/queue`)
        .set('Cookie', dispenser)
        .expect(200);
      const row = queue.body.items.find(
        (i: { encounterId: string }) => i.encounterId === encounterId,
      );
      expect(row).toMatchObject({ items: 1, hasControlled: true });
      expect(row.patient.name).toContain('Dispense Patient');
    });

    it('DSP-F-09: flags an item the doctor changed after the session opened', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'V1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId, consultationId } = await prescribed([
        { productId: product, quantity: 15 },
      ]);

      const session = await openSession(encounterId);
      const rxItemId = session.items[0]!.prescriptionItemId;
      expect(session.items[0]?.amendedSinceOpen).toBe(false);

      await request(harness.server)
        .post(`${API}/prescription-items/${rxItemId}/amend`)
        .set('Cookie', doctor)
        .send({
          reason: 'Renal impairment noticed after signing',
          item: {
            productId: product,
            doseValue: 1,
            doseUnit: 'cap',
            route: 'PO',
            frequencyCode: 'BD',
            durationDays: 5,
          },
        })
        .expect(201);

      const reread = await request(harness.server)
        .get(`${API}/dispenses/${session.id}`)
        .set('Cookie', dispenser)
        .expect(200);
      const changed = reread.body.items.find((i: { newSinceOpen: boolean }) => i.newSinceOpen);
      expect(changed).toBeTruthy();
      expect(changed.version).toBe(2);

      void consultationId;
    });

    it('DSP-F-12: the label carries what the patient needs', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'W1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);
      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      const label = await request(harness.server)
        .post(`${API}/dispense-items/${done.body.id}/label`)
        .set('Cookie', dispenser)
        .expect(200);

      expect(label.body.patientName).toContain('Dispense Patient');
      expect(label.body.instructions).toContain('Ambil');
      expect(label.body.batches[0].batchNo).toBe('W1');
      expect(label.body.warnings.join(' ')).toContain('kanak-kanak');
      expect(label.body.printCount).toBe(1);

      const again = await request(harness.server)
        .post(`${API}/dispense-items/${done.body.id}/label`)
        .set('Cookie', dispenser)
        .expect(200);
      expect(again.body.printCount).toBe(2);
    });

    it('DSP-F-14: will not finish with an item unaccounted for', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'X1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([
        { productId: product, quantity: 15 },
        { productId: product, quantity: 10, instructions: 'second' },
      ]);
      const session = await openSession(encounterId);

      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      const blocked = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/complete`)
        .set('Cookie', dispenser)
        .send({})
        .expect(422);
      expect(blocked.body.detail).toContain('not been dealt with');

      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[1]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      const completed = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/complete`)
        .set('Cookie', dispenser)
        .send({ counselled: true })
        .expect(200);
      expect(completed.body.status).toBe('COMPLETED');
    });

    it('ENC-F-10: a visit cannot be finished with medicine still waiting', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'Y1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);

      // Opening the session is what moves the visit to DISPENSING,
      // which is the only state from which it could be finished.
      const session = await openSession(encounterId);

      const blocked = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(422);
      expect(JSON.stringify(blocked.body)).toContain('handed over');

      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/dispenses/${session.id}/complete`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      // Dispensing put a medicine line on the bill, so the visit cannot
      // close until the cashier has issued it *and taken the money* —
      // which is what happens at a counter. Neither guard is DSP's: the
      // first is BIL's, the second is PAY's.
      const bill = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/invoice`)
        .set('Cookie', cashier)
        .send({})
        .expect(201);
      await request(harness.server)
        .post(`${API}/invoices/${bill.body.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);

      await request(harness.server)
        .post(`${API}/branches/${branch}/cash-sessions`)
        .set('Cookie', cashier)
        .send({ float: 100 })
        .expect(201);
      await request(harness.server)
        .post(`${API}/invoices/${bill.body.invoice.id}/payments`)
        .set('Cookie', cashier)
        .send({ method: 'CASH', idempotencyKey: `dsp-${encounterId}` })
        .expect(201);

      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(200);
    });
  });

  describe('Returns and boundaries', () => {
    it('DSP-F-17: a return goes to quarantine, not back on the shelf', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'Z1', expiry: inMonths(12), quantity: 40 }]);
      const before = await onHand(product);

      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);
      const done = await request(harness.server)
        .post(`${API}/dispenses/${session.id}/items/${session.items[0]!.prescriptionItemId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      await request(harness.server)
        .post(`${API}/dispense-items/${done.body.id}/return`)
        .set('Cookie', doctor)
        .send({ quantity: 5, reason: 'Patient brought them back unopened' })
        .expect(200);

      // Still off the saleable shelf.
      expect(await onHand(product)).toBe(before - 15);
      const batches = await batchesOf(product);
      expect(batches.find((b) => b.batchNo === 'Z1')?.quantityQuarantined).toBe(5);
    });

    it('DSP-T-12: the dispenser view carries no clinical notes', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'AA1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      const session = await openSession(encounterId);

      const body = JSON.stringify(session);
      expect(body).not.toContain('Tonsillitis');
      expect(body).not.toContain('Sore throat');
      expect(body).not.toContain('hpi');
      expect(body).not.toContain('examination');
    });

    it('opening twice joins the same session rather than starting a rival', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'AB1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);

      const first = await openSession(encounterId);
      const second = await openSession(encounterId, doctor);
      expect(second.id).toBe(first.id);
    });

    it('reception cannot dispense', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'AC1', expiry: inMonths(12), quantity: 40 }]);
      const { encounterId } = await prescribed([{ productId: product, quantity: 15 }]);
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/dispense`)
        .set('Cookie', reception)
        .send({})
        .expect(403);
    });
  });
});
