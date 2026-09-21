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

function inMonths(months: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 15))
    .toISOString()
    .slice(0, 10);
}

type Invoice = {
  invoice: {
    id: string;
    invoiceNo: string | null;
    status: string;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    grandTotal: string;
    grandTotalSen: number;
    reissuedAsId: string | null;
    reissuedFromId: string | null;
  };
  lines: Array<{
    id: string;
    lineNo: number;
    lineType: string;
    description: string;
    quantity: number;
    unitPrice: string;
    gross: string;
    grossSen: number;
    discountAmount: string;
    discountAmountSen: number;
    lineTotal: string;
    lineTotalSen: number;
    isAuto: boolean;
    feeRule: string | null;
  }>;
};

describe('BIL — billing', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let dispenser: string;
  let cashier: string;
  let branch: string;

  let seq = 0;

  async function addProduct(over: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const response = await request(harness.server)
      .post(`${API}/products`)
      .set('Cookie', admin)
      .send({
        name: `Bill Medicine ${seq}`,
        type: 'MEDICINE',
        genericName: `Bill Generic ${seq}`,
        dispenseUnit: 'cap',
        sellingPrice: 1.2,
        ...over,
      })
      .expect(201);
    return response.body.id as string;
  }

  async function stockIn(productId: string, quantity: number) {
    await request(harness.server)
      .post(`${API}/branches/${branch}/stock-in`)
      .set('Cookie', admin)
      .send({
        lines: [{ productId, batchNo: `B${seq}`, expiry: inMonths(18), quantity }],
      })
      .expect(201);
  }

  /** A patient seen and signed for, so the invoice has a fee on it. */
  async function visit(options: { prescribe?: { productId: string; quantity: number } } = {}) {
    seq += 1;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Bill Patient ${seq}`,
        idType: 'NONE',
        notes: 'Test patient',
        gender: 'MALE',
        dateOfBirth: new Date(Date.UTC(1970, 0, 1 + seq)).toISOString().slice(0, 10),
        phone: `019-${String(20_000_000 + seq).slice(0, 8)}`,
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
      .send({ chiefComplaint: 'Fever' })
      .expect(200);
    await request(harness.server)
      .put(`${API}/consultations/${consultationId}/diagnoses`)
      .set('Cookie', doctor)
      .send({ diagnoses: [{ rank: 'PRIMARY', description: 'Viral fever', certainty: 'CONFIRMED' }] })
      .expect(200);

    if (options.prescribe) {
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/prescription/items`)
        .set('Cookie', doctor)
        .send({
          productId: options.prescribe.productId,
          doseValue: 1,
          doseUnit: 'cap',
          route: 'PO',
          frequencyCode: 'TDS',
          durationDays: 5,
          quantity: options.prescribe.quantity,
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

  async function invoiceFor(encounterId: string, cookie = cashier): Promise<Invoice> {
    const response = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/invoice`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    return response.body as Invoice;
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('billing');
    branch = fx.branchAId;

    const dispenserUser = await harness.addUser(fx, {
      name: 'Kaunter Lim',
      roles: [{ branchId: fx.branchAId, role: Role.DISPENSER }],
    });
    const cashierUser = await harness.addUser(fx, {
      name: 'Juruwang Aina',
      roles: [{ branchId: fx.branchAId, role: Role.CASHIER }],
    });
    [doctor, reception, dispenser, cashier] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, dispenserUser.email),
      signIn(harness, cashierUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);

    // A base consultation fee, so every visit has something on it.
    await request(harness.server)
      .post(`${API}/fee-schedule`)
      .set('Cookie', admin)
      .send({ fee: 40 })
      .expect(201);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------- automatic lines

  describe('Assembling the draft (BIL-F-02)', () => {
    it('puts the consultation fee on when the note is signed', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);

      const fee = draft.lines.find((l) => l.lineType === 'CONSULTATION');
      expect(fee).toBeTruthy();
      expect(fee!.gross).toBe('40.00');
      expect(fee!.isAuto).toBe(true);
      expect(fee!.feeRule).toContain('CONSULT');
      expect(draft.invoice.grandTotal).toBe('40.00');
    });

    it('BIL-T-01: a dispense of 15 at RM 1.20 is a line of RM 18.00', async () => {
      const product = await addProduct({ sellingPrice: 1.2 });
      await stockIn(product, 100);
      const { encounterId } = await visit({ prescribe: { productId: product, quantity: 15 } });

      const session = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(201);
      await request(harness.server)
        .post(
          `${API}/dispenses/${session.body.id}/items/${session.body.items[0].prescriptionItemId}/dispense`,
        )
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      const draft = await invoiceFor(encounterId);
      const medicine = draft.lines.find((l) => l.lineType === 'MEDICINE');
      expect(medicine).toBeTruthy();
      expect(medicine!.grossSen).toBe(1800);
      expect(medicine!.gross).toBe('18.00');
      // The consultation fee is on it too.
      expect(draft.invoice.grandTotal).toBe('58.00');
    });

    it('BIL-R-11: the medicine price is the dispensed one, not today’s', async () => {
      const product = await addProduct({ sellingPrice: 2 });
      await stockIn(product, 50);
      const { encounterId } = await visit({ prescribe: { productId: product, quantity: 10 } });

      const session = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(201);
      await request(harness.server)
        .post(
          `${API}/dispenses/${session.body.id}/items/${session.body.items[0].prescriptionItemId}/dispense`,
        )
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      await request(harness.server)
        .patch(`${API}/products/${product}`)
        .set('Cookie', admin)
        .send({ sellingPrice: 99, priceReason: 'Supplier increase' })
        .expect(200);

      const draft = await invoiceFor(encounterId);
      expect(draft.lines.find((l) => l.lineType === 'MEDICINE')!.gross).toBe('20.00');
    });

    it('takes the line off again when the dispense is undone', async () => {
      const product = await addProduct({ sellingPrice: 3 });
      await stockIn(product, 50);
      const { encounterId } = await visit({ prescribe: { productId: product, quantity: 5 } });

      const session = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/dispense`)
        .set('Cookie', dispenser)
        .send({})
        .expect(201);
      const done = await request(harness.server)
        .post(
          `${API}/dispenses/${session.body.id}/items/${session.body.items[0].prescriptionItemId}/dispense`,
        )
        .set('Cookie', dispenser)
        .send({})
        .expect(200);

      expect((await invoiceFor(encounterId)).invoice.grandTotal).toBe('55.00');

      await request(harness.server)
        .post(`${API}/dispense-items/${done.body.id}/undo`)
        .set('Cookie', doctor)
        .send({ reason: 'Wrong batch' })
        .expect(200);

      expect((await invoiceFor(encounterId)).invoice.grandTotal).toBe('40.00');
    });

    it('BIL-R-08: an automatic line cannot be edited or removed by hand', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      const fee = draft.lines[0]!;

      const patched = await request(harness.server)
        .patch(`${API}/invoices/${draft.invoice.id}/lines/${fee.id}`)
        .set('Cookie', cashier)
        .send({ unitPrice: 5 })
        .expect(409);
      expect(patched.body.detail).toContain('added by the system');

      await request(harness.server)
        .delete(`${API}/invoices/${draft.invoice.id}/lines/${fee.id}`)
        .set('Cookie', cashier)
        .expect(409);
    });
  });

  // ---------------------------------------------------- manual lines

  describe('Lines added by hand (BIL-F-03)', () => {
    it('adds one from the catalogue, and one typed out', async () => {
      await request(harness.server)
        .post(`${API}/billable-items`)
        .set('Cookie', admin)
        .send({ name: 'Medical report fee', defaultPrice: 50 })
        .expect(201);
      const items = await request(harness.server)
        .get(`${API}/billable-items`)
        .set('Cookie', cashier)
        .expect(200);
      const report = items.body.items.find((i: { name: string }) => i.name === 'Medical report fee');

      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);

      const withItem = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/lines`)
        .set('Cookie', cashier)
        .send({ billableItemId: report.id, quantity: 1 })
        .expect(201);
      expect(withItem.body.invoice.grandTotal).toBe('90.00');

      const withFree = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Crutches, deposit', quantity: 1, unitPrice: 25.5 })
        .expect(201);
      expect(withFree.body.invoice.grandTotal).toBe('115.50');
    });

    it('wants a price for something typed out', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Something', quantity: 1 })
        .expect(400);
    });
  });

  // ------------------------------------------------------- discounts

  describe('Discounts (BIL-F-07 … F-10)', () => {
    it('BIL-T-02: 33.33% across three RM 10 lines is 334/333/333', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);

      // Remove the fee from the picture by discounting only the three
      // lines we add: a standalone invoice keeps the arithmetic clean.
      const standalone = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Counter Sale' })
        .expect(201);
      const id = standalone.body.invoice.id as string;

      for (let i = 0; i < 3; i += 1) {
        await request(harness.server)
          .post(`${API}/invoices/${id}/lines`)
          .set('Cookie', cashier)
          .send({ description: `Item ${i + 1}`, quantity: 1, unitPrice: 10 })
          .expect(201);
      }

      const discounted = await request(harness.server)
        .put(`${API}/invoices/${id}/discount`)
        .set('Cookie', admin)
        .send({ pct: 33.33, source: 'GOODWILL', reason: 'Long-standing patient' })
        .expect(200);

      const amounts = (discounted.body as Invoice).lines.map((l) => l.discountAmountSen);
      expect(amounts).toEqual([334, 333, 333]);
      expect(discounted.body.invoice.discountTotal).toBe('10.00');
      expect(discounted.body.invoice.grandTotal).toBe('20.00');
      void draft;
    });

    it('BIL-R-03: the lines always add up to the invoice', async () => {
      const standalone = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Odd Amounts' })
        .expect(201);
      const id = standalone.body.invoice.id as string;

      for (const price of [3.33, 7.77, 0.05, 12.01]) {
        await request(harness.server)
          .post(`${API}/invoices/${id}/lines`)
          .set('Cookie', cashier)
          .send({ description: `RM ${price}`, quantity: 1, unitPrice: price })
          .expect(201);
      }
      const out = await request(harness.server)
        .put(`${API}/invoices/${id}/discount`)
        .set('Cookie', admin)
        .send({ pct: 17.5, source: 'STAFF', reason: 'Staff member' })
        .expect(200);

      const body = out.body as Invoice;
      const lineSum = body.lines.reduce((sum, l) => sum + l.lineTotalSen, 0);
      expect(lineSum).toBe(body.invoice.grandTotalSen);
      const discountSum = body.lines.reduce((sum, l) => sum + l.discountAmountSen, 0);
      expect(discountSum).toBe(Math.round(Number(body.invoice.discountTotal) * 100));
    });

    it('BIL-T-03: above the cap needs an administrator', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);

      const refused = await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', cashier)
        .send({ pct: 15, source: 'GOODWILL', reason: 'Regular patient' })
        .expect(403);
      expect(refused.body.detail).toContain('administrator');
      expect(refused.body.errors.elevationRequired).toBe(true);

      // With an administrator's approval it goes through, recorded
      // against the administrator rather than the cashier.
      const allowed = await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', cashier)
        .send({ pct: 15, source: 'GOODWILL', reason: 'Regular patient', elevatedBy: fx.admin.id })
        .expect(200);
      expect(allowed.body.invoice.grandTotal).toBe('34.00');

      // And an administrator needs no approval of their own.
      await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', admin)
        .send({ pct: 20, source: 'GOODWILL', reason: 'Approved directly' })
        .expect(200);
    });

    it('asks for a reason once the discount is worth explaining', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', cashier)
        .send({ pct: 8, source: 'GOODWILL' })
        .expect(400);
      await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', cashier)
        .send({ pct: 2, source: 'GOODWILL' })
        .expect(200);
    });

    it('refuses a discount larger than the bill', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      await request(harness.server)
        .put(`${API}/invoices/${draft.invoice.id}/discount`)
        .set('Cookie', admin)
        .send({ amount: 500, source: 'GOODWILL', reason: 'Far too much' })
        .expect(400);
    });

    it('keeps a percentage discount honest when a line is added after it', async () => {
      const standalone = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Growing Bill' })
        .expect(201);
      const id = standalone.body.invoice.id as string;

      await request(harness.server)
        .post(`${API}/invoices/${id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'First', quantity: 1, unitPrice: 100 })
        .expect(201);
      await request(harness.server)
        .put(`${API}/invoices/${id}/discount`)
        .set('Cookie', cashier)
        .send({ pct: 10, source: 'SENIOR', reason: 'Senior citizen' })
        .expect(200);

      const after = await request(harness.server)
        .post(`${API}/invoices/${id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Second', quantity: 1, unitPrice: 100 })
        .expect(201);

      // 10% of the bill, not 10% of what it was when the cashier said it.
      expect(after.body.invoice.discountTotal).toBe('20.00');
      expect(after.body.invoice.grandTotal).toBe('180.00');
    });
  });

  // ----------------------------------------------------------- issue

  describe('Issuing (BIL-F-13, BIL-R-06)', () => {
    it('numbers it per branch per year', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      const issued = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);

      expect(issued.body.invoice.status).toBe('ISSUED');
      expect(issued.body.invoice.invoiceNo).toMatch(
        new RegExp(`^TA-INV-${new Date().getUTCFullYear()}-\\d{6}$`),
      );
    });

    it('BIL-T-04: fifty at once get fifty consecutive numbers', async () => {
      const drafts: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const { encounterId } = await visit();
        drafts.push((await invoiceFor(encounterId)).invoice.id);
      }

      const results = await Promise.all(
        drafts.map((id) =>
          request(harness.server)
            .post(`${API}/invoices/${id}/issue`)
            .set('Cookie', cashier)
            .send({}),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);

      const numbers = results
        .map((r) => Number(String(r.body.invoice.invoiceNo).split('-').pop()))
        .sort((a, b) => a - b);
      // Consecutive, no gaps, no duplicates.
      expect(new Set(numbers).size).toBe(50);
      for (let i = 1; i < numbers.length; i += 1) {
        expect(numbers[i]! - numbers[i - 1]!).toBe(1);
      }
    }, 180_000);

    it('replays a retried issue rather than allocating a second number', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      const key = `issue-${newId()}`;

      const first = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({ idempotencyKey: key })
        .expect(200);
      const second = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({ idempotencyKey: key })
        .expect(200);

      expect(second.body.invoice.invoiceNo).toBe(first.body.invoice.invoiceNo);
    });

    it('will not issue an empty invoice', async () => {
      const standalone = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Nothing Bought' })
        .expect(201);
      await request(harness.server)
        .post(`${API}/invoices/${standalone.body.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(422);
    });

    it('BIL-T-05: an issued invoice cannot be changed, by the API or by SQL', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Extra', quantity: 1, unitPrice: 10 })
        .expect(201);
      const issued = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);

      const lineId = (issued.body as Invoice).lines.find((l) => !l.isAuto)!.id;
      await request(harness.server)
        .patch(`${API}/invoices/${draft.invoice.id}/lines/${lineId}`)
        .set('Cookie', cashier)
        .send({ unitPrice: 1 })
        .expect(409);

      // BIL-N-05: the trigger holds even against direct SQL.
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.invoiceLine.update({ where: { id: lineId }, data: { description: 'Tampered' } }),
        ),
      ).rejects.toThrow(/has been issued/);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.invoice.update({
            where: { id: draft.invoice.id },
            data: { grandTotal: 1n },
          }),
        ),
      ).rejects.toThrow(/cannot be changed/);
    });
  });

  // -------------------------------------------------- void & reissue

  describe('Void and reissue (BIL-F-15, F-16)', () => {
    async function issued() {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      const out = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);
      return { encounterId, invoice: out.body as Invoice };
    }

    it('BIL-T-06: voids an unpaid invoice and keeps the number in the series', async () => {
      const { invoice } = await issued();
      const number = invoice.invoice.invoiceNo;

      const voided = await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Billed against the wrong patient at the counter' })
        .expect(200);
      expect(voided.body.invoice.status).toBe('VOID');
      // The number is not reused or blanked: the series stays gapless
      // with a void in it.
      expect(voided.body.invoice.invoiceNo).toBe(number);
    });

    it('wants a sentence before voiding', async () => {
      const { invoice } = await issued();
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'oops' })
        .expect(400);
    });

    it('a cashier may issue and may not void', async () => {
      const { invoice } = await issued();
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/void`)
        .set('Cookie', cashier)
        .send({ reason: 'Should not be allowed to do this' })
        .expect(403);
    });

    it('BIL-T-07: reissues with the same lines and a new number, cross-referenced', async () => {
      const { invoice } = await issued();
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Wrong consultation fee band applied' })
        .expect(200);

      const reissued = await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/reissue`)
        .set('Cookie', cashier)
        .expect(201);

      const draft = reissued.body as Invoice;
      expect(draft.invoice.status).toBe('DRAFT');
      expect(draft.invoice.reissuedFromId).toBe(invoice.invoice.id);
      expect(draft.lines).toHaveLength(invoice.lines.length);

      const out = await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);
      expect(out.body.invoice.invoiceNo).not.toBe(invoice.invoice.invoiceNo);

      const original = await request(harness.server)
        .get(`${API}/invoices/${invoice.invoice.id}`)
        .set('Cookie', cashier)
        .expect(200);
      expect(original.body.invoice.reissuedAsId).toBe(draft.invoice.id);
    });

    it('will not reissue twice', async () => {
      const { invoice } = await issued();
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Duplicate of another invoice entirely' })
        .expect(200);
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/reissue`)
        .set('Cookie', cashier)
        .expect(201);
      await request(harness.server)
        .post(`${API}/invoices/${invoice.invoice.id}/reissue`)
        .set('Cookie', cashier)
        .expect(409);
    });
  });

  // ------------------------------------------------- the fee schedule

  describe('The fee schedule (BIL-F-05, BIL-T-08)', () => {
    it('BIL-T-08: the most specific rule wins', async () => {
      // A doctor-specific after-hours rule, on top of the base RM 40.
      await request(harness.server)
        .post(`${API}/fee-schedule`)
        .set('Cookie', admin)
        .send({ doctorId: fx.doctor.id, timeBand: 'AFTER_HOURS', fee: 75 })
        .expect(201);

      const rules = await request(harness.server)
        .get(`${API}/fee-schedule`)
        .set('Cookie', admin)
        .expect(200);
      const specific = rules.body.items.find((r: { fee: string }) => r.fee === '75.00');
      const base = rules.body.items.find((r: { fee: string }) => r.fee === '40.00');
      // Specificity is counted, not ordered.
      expect(specific.specificity).toBeGreaterThan(base.specificity);
    });

    it('leaves the line off entirely when no rule matches', async () => {
      // A branch with no rule of its own still matches the global one,
      // so this checks the honest case: a clinic that has set nothing.
      const other = await harness.seedTenant('billing-nofees');
      const otherDoctor = await signIn(harness, other.doctor.email);
      const otherReception = await signIn(harness, other.frontdesk.email);

      const patient = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', otherReception)
        .send({
          name: 'No Fee Patient',
          idType: 'NONE',
          notes: 'x',
          gender: 'MALE',
          dateOfBirth: '1980-05-05',
          phone: '011-55667788',
        })
        .expect(201);
      const encounter = await request(harness.server)
        .post(`${API}/branches/${other.branchAId}/encounters`)
        .set('Cookie', otherReception)
        .send({ patientId: patient.body.patient.id })
        .expect(201);
      const encounterId = encounter.body.encounter.id as string;
      for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
        await request(harness.server)
          .post(`${API}/encounters/${encounterId}/transition`)
          .set('Cookie', otherDoctor)
          .send({ to })
          .expect(200);
      }
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', otherDoctor)
        .send({})
        .expect(201);
      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', otherDoctor)
        .send({ chiefComplaint: 'Cough' })
        .expect(200);
      await request(harness.server)
        .put(`${API}/consultations/${created.body.id}/diagnoses`)
        .set('Cookie', otherDoctor)
        .send({ diagnoses: [{ rank: 'PRIMARY', description: 'URTI', certainty: 'CONFIRMED' }] })
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', otherDoctor)
        .send({})
        .expect(200);

      const invoice = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/invoice`)
        .set('Cookie', otherReception)
        .expect(200);
      // No rule, so no line — visible, rather than a bill saying free.
      expect(invoice.body.invoice).toBeNull();
    });
  });

  describe('Completion and boundaries', () => {
    it('BIL-F-17: an issued bill is not enough — it has to be paid', async () => {
      const { encounterId } = await visit();
      const draft = await invoiceFor(encounterId);
      await request(harness.server)
        .post(`${API}/invoices/${draft.invoice.id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);

      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'PAYMENT_WAITING' })
        .expect(200);

      // Billing's half of BIL-F-17 is satisfied: the bill is issued.
      // The other half is `PAY`'s, and it is registered now — so an
      // issued bill that nobody has paid still blocks the visit.
      // `BIL-OPEN-16` tracked this gap until payment could close it.
      const blocked = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(422);
      expect(JSON.stringify(blocked.body)).toContain('balance_outstanding');
      expect(JSON.stringify(blocked.body)).not.toContain('invoice_not_issued');
    });

    it('blocks completion when the invoice was never issued', async () => {
      const { encounterId } = await visit();
      await invoiceFor(encounterId);
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'PAYMENT_WAITING' })
        .expect(200);
      const blocked = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED' })
        .expect(422);
      expect(JSON.stringify(blocked.body)).toContain('not been issued');
    });

    it('BIL-F-18: sells something to a walk-up with no record', async () => {
      const standalone = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Encik Rahman' })
        .expect(201);
      const id = standalone.body.invoice.id as string;

      await request(harness.server)
        .post(`${API}/invoices/${id}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Plasters, box', quantity: 1, unitPrice: 8.5 })
        .expect(201);

      const issued = await request(harness.server)
        .post(`${API}/invoices/${id}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);
      expect(issued.body.invoice.grandTotal).toBe('8.50');
      expect(issued.body.invoice.patientNameSnapshot).toBe('Encik Rahman');
    });

    it('a doctor may read a bill and not issue one', async () => {
      const { encounterId } = await visit();
      await request(harness.server)
        .get(`${API}/encounters/${encounterId}/invoice`)
        .set('Cookie', doctor)
        .expect(200);
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/invoice`)
        .set('Cookie', doctor)
        .send({})
        .expect(403);
    });
  });
});
