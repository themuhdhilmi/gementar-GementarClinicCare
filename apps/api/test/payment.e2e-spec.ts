import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { newId } from '../src/shared/ids/uuid.js';
import { PaymentReconciliationJob } from '../src/modules/payment/reconciliation.job.js';

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

type Payment = {
  id: string;
  receiptNo: string;
  amountSen: string;
  roundingSen: string;
  changeSen: string | null;
  status: string;
  method: string;
};

describe('PAY — payment', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let cashier: string;
  let branch: string;

  let seq = 0;

  async function reauth(cookie: string) {
    await request(harness.server)
      .post(`${API}/auth/reauth`)
      .set('Cookie', cookie)
      .send({ password: DEFAULT_PASSWORD })
      .expect(200);
  }

  async function openSession(
    floatRinggit = 200,
    cookie = cashier,
    drawerCode?: string,
  ) {
    const response = await request(harness.server)
      .post(`${API}/branches/${branch}/cash-sessions`)
      .set('Cookie', cookie)
      .send({ float: floatRinggit, ...(drawerCode ? { drawerCode } : {}) })
      .expect(201);
    return response.body as { id: string; status: string };
  }

  async function closeAnyOpenSession() {
    const current = await request(harness.server)
      .get(`${API}/branches/${branch}/cash-sessions/current`)
      .set('Cookie', cashier)
      .expect(200);
    if (!current.body.session) return;
    const preview = await request(harness.server)
      .get(`${API}/cash-sessions/${current.body.session.id}/preview-close`)
      .set('Cookie', cashier)
      .expect(200);
    await request(harness.server)
      .post(`${API}/cash-sessions/${current.body.session.id}/close`)
      .set('Cookie', admin)
      .send({
        counted: Number(preview.body.expectedCashSen) / 100,
        note: 'Tidying up between tests',
        approve: true,
      })
      .expect(200);
  }

  /** An issued invoice for a given total, built from a manual line. */
  async function invoiceFor(
    totalRinggit: number,
  ): Promise<{ id: string; grandTotalSen: number }> {
    seq += 1;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Pay Patient ${seq}`,
        idType: 'NONE',
        notes: 'Test patient',
        gender: 'FEMALE',
        // Varied, because PAT refuses a near-identical name on the same
        // birthday as a likely duplicate — which is correct, and makes a
        // fixture of "Pay Patient 2, 3, 4…" all born on one day illegal.
        dateOfBirth: new Date(Date.UTC(1980, 0, 1 + seq))
          .toISOString()
          .slice(0, 10),
        phone: `019-${String(60_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);

    const draft = await request(harness.server)
      .post(`${API}/branches/${branch}/invoices/standalone`)
      .set('Cookie', cashier)
      .send({ patientId: patient.body.patient.id })
      .expect(201);
    const invoiceId = draft.body.invoice.id as string;

    await request(harness.server)
      .post(`${API}/invoices/${invoiceId}/lines`)
      .set('Cookie', cashier)
      .send({
        description: `Consultation ${seq}`,
        quantity: 1,
        unitPrice: totalRinggit,
      })
      .expect(201);

    const issued = await request(harness.server)
      .post(`${API}/invoices/${invoiceId}/issue`)
      .set('Cookie', cashier)
      .send({})
      .expect(200);
    return { id: invoiceId, grandTotalSen: issued.body.invoice.grandTotalSen };
  }

  function pay(
    invoiceId: string,
    body: Record<string, unknown>,
    cookie = cashier,
  ) {
    return request(harness.server)
      .post(`${API}/invoices/${invoiceId}/payments`)
      .set('Cookie', cookie)
      .send({ idempotencyKey: newId(), ...body });
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('payment');
    branch = fx.branchAId;

    const cashierUser = await harness.addUser(fx, {
      name: 'Juruwang Pay',
      roles: [{ branchId: fx.branchAId, role: Role.CASHIER }],
    });
    [doctor, reception, cashier] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, cashierUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------- no drawer

  it('PAY-T-04: without an open drawer, nothing can be taken', async () => {
    await closeAnyOpenSession();
    const invoice = await invoiceFor(40);
    const refused = await pay(invoice.id, { method: 'CASH' }).expect(409);
    expect(refused.body.code).toBe('session_required');

    const current = await request(harness.server)
      .get(`${API}/branches/${branch}/cash-sessions/current`)
      .set('Cookie', cashier)
      .expect(200);
    expect(current.body.session).toBeNull();
  });

  // ------------------------------------------------------- rounding

  describe('PAY-T-01 — Bank Negara rounding, end to end', () => {
    it.each([
      [77.43, 7_745, 2],
      [77.42, 7_740, -2],
      [77.41, 7_740, -1],
      [77.48, 7_750, 2],
      [77.4, 7_740, 0],
    ])(
      'an invoice of RM %s settles in cash at %i sen (%i rounding)',
      async (ringgit, dueSen, roundingSen) => {
        await closeAnyOpenSession();
        await openSession(200);
        const invoice = await invoiceFor(ringgit);

        // The preview and the payment have to agree, because the cashier
        // reads one and the patient hands over money for the other.
        const preview = await request(harness.server)
          .get(`${API}/invoices/${invoice.id}/payment-preview`)
          .set('Cookie', cashier)
          .query({ method: 'CASH' })
          .expect(200);
        expect(Number(preview.body.dueSen)).toBe(dueSen);
        expect(Number(preview.body.roundingSen)).toBe(roundingSen);

        const paid = await pay(invoice.id, {
          method: 'CASH',
          tendered: 100,
        }).expect(201);
        const payment = paid.body as Payment;
        expect(Number(payment.amountSen)).toBe(dueSen);
        expect(Number(payment.roundingSen)).toBe(roundingSen);
        expect(Number(payment.changeSen)).toBe(10_000 - dueSen);

        const after = await request(harness.server)
          .get(`${API}/invoices/${invoice.id}/payments`)
          .set('Cookie', cashier)
          .expect(200);
        expect(after.body.status).toBe('PAID');
        expect(Number(after.body.balanceSen)).toBe(0);
      },
    );

    it('PAY-T-03: a card payment of the whole bill does not round', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(77.43);

      const paid = await pay(invoice.id, {
        method: 'CARD',
        reference: '4242',
      }).expect(201);
      expect(Number(paid.body.amountSen)).toBe(7_743);
      expect(Number(paid.body.roundingSen)).toBe(0);

      const after = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(after.body.status).toBe('PAID');
      expect(Number(after.body.balanceSen)).toBe(0);
    });

    it('PAY-T-02: card then cash — only the cash leg rounds', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(77.43);

      const card = await pay(invoice.id, {
        method: 'CARD',
        amount: 50,
        reference: '4242',
      }).expect(201);
      expect(Number(card.body.amountSen)).toBe(5_000);
      expect(Number(card.body.roundingSen)).toBe(0);

      const mid = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(mid.body.status).toBe('PARTIAL');
      expect(Number(mid.body.balanceSen)).toBe(2_743);

      const cash = await pay(invoice.id, {
        method: 'CASH',
        tendered: 50,
      }).expect(201);
      expect(Number(cash.body.amountSen)).toBe(2_745);
      expect(Number(cash.body.roundingSen)).toBe(2);

      const end = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(end.body.status).toBe('PAID');
      expect(Number(end.body.balanceSen)).toBe(0);
      // Rounded once, not twice: the clinic collected two sen more than
      // it billed, and that is the whole adjustment.
      expect(Number(end.body.paidSen)).toBe(7_745);
    });
  });

  // ------------------------------------------------------ the basics

  describe('Taking money', () => {
    it('PAY-T-05: the same idempotency key takes the money once', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(40);
      const key = newId();

      const first = await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .send({ method: 'CASH', idempotencyKey: key, tendered: 50 })
        .expect(201);
      const second = await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .send({ method: 'CASH', idempotencyKey: key, tendered: 50 })
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.receiptNo).toBe(first.body.receiptNo);

      const all = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(all.body.items).toHaveLength(1);
      expect(Number(all.body.paidSen)).toBe(4_000);
    });

    it('PAY-T-06: thirty at once get thirty consecutive receipt numbers', async () => {
      await closeAnyOpenSession();
      await openSession(200);

      // Built one at a time. What this test is about is thirty
      // *payments* racing for a receipt number; building thirty
      // patients and thirty invoices concurrently as well would also
      // race the patient duplicate search and the invoice series, and
      // a flake there would look like a numbering bug.
      const invoices: Array<{ id: string }> = [];
      for (let i = 0; i < 30; i += 1) invoices.push(await invoiceFor(10));
      const taken = await Promise.all(
        invoices.map((invoice) =>
          request(harness.server)
            .post(`${API}/invoices/${invoice.id}/payments`)
            .set('Cookie', cashier)
            .send({ method: 'CASH', idempotencyKey: newId(), tendered: 10 }),
        ),
      );
      expect(taken.map((r) => r.status)).toEqual(Array(30).fill(201));

      const numbers = taken
        .map((r) => (r.body as Payment).receiptNo)
        .map((no) => Number(no.slice(no.lastIndexOf('-') + 1)))
        .sort((a, b) => a - b);

      expect(new Set(numbers).size).toBe(30);
      for (let i = 1; i < numbers.length; i += 1) {
        expect(numbers[i]! - numbers[i - 1]!).toBe(1);
      }
    });

    it('refuses more than is owed, and less than is tendered', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(40);

      const over = await pay(invoice.id, { method: 'CARD', amount: 50 }).expect(
        409,
      );
      expect(over.body.code).toBe('overpayment');

      const short = await pay(invoice.id, {
        method: 'CASH',
        tendered: 10,
      }).expect(400);
      expect(short.body.code).toBe('tendered_short');
    });

    it('will not take money for a draft or a voided invoice (§14)', async () => {
      await closeAnyOpenSession();
      await openSession(200);

      const draft = await request(harness.server)
        .post(`${API}/branches/${branch}/invoices/standalone`)
        .set('Cookie', cashier)
        .send({ walkupName: 'Walk-up' })
        .expect(201);
      const notIssued = await pay(draft.body.invoice.id, {
        method: 'CASH',
      }).expect(409);
      expect(notIssued.body.code).toBe('invoice_not_issued');

      const invoice = await invoiceFor(40);
      await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Charged the wrong patient at the counter' })
        .expect(200);
      const voided = await pay(invoice.id, { method: 'CASH' }).expect(409);
      expect(voided.body.code).toBe('invoice_voided');
    });

    it('is refused to anybody without payment.take', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(40);
      await pay(invoice.id, { method: 'CASH' }, doctor).expect(403);
    });
  });

  // ------------------------------------------------------- the drawer

  describe('The drawer (PAY-F-01 … F-05)', () => {
    it('PAY-T-07: expected cash is float plus cash in, less what left', async () => {
      await closeAnyOpenSession();
      const session = await openSession(200); // float 20000 sen

      // Cash payments totalling 150000 sen, one of which is the 5000
      // that gets voided below — the specification's worked example has
      // the void inside the day's takings, not on top of them.
      for (const amount of [500, 500, 450]) {
        const invoice = await invoiceFor(amount);
        await pay(invoice.id, { method: 'CASH', tendered: amount }).expect(201);
      }

      // A cash payment of 5000 sen, then voided.
      const toVoid = await invoiceFor(50);
      const voidable = await pay(toVoid.id, {
        method: 'CASH',
        tendered: 50,
      }).expect(201);
      await reauth(admin);
      await request(harness.server)
        .post(`${API}/payments/${voidable.body.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Recorded as cash when the patient paid by card' })
        .expect(200);

      // And a drop of 100000 sen to the safe.
      await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/movements`)
        .set('Cookie', cashier)
        .send({
          type: 'CASH_DROP',
          amount: 1_000,
          reason: 'To the safe at lunchtime',
        })
        .expect(200);

      const preview = await request(harness.server)
        .get(`${API}/cash-sessions/${session.id}/preview-close`)
        .set('Cookie', cashier)
        .expect(200);

      // 20000 + 150000 − 5000 − 100000 = 65000, exactly as the
      // specification's worked example says.
      expect(Number(preview.body.expectedCashSen)).toBe(65_000);
      // The method totals count what is still posted, so the voided
      // 5000 is not in them — while the drawer still nets it out
      // through its PAYMENT_IN and matching VOID_OUT.
      expect(preview.body.totalsByMethod.CASH).toBe('145000');
    });

    it('a card payment is attributed to the session but is not in the drawer', async () => {
      await closeAnyOpenSession();
      const session = await openSession(100);
      const invoice = await invoiceFor(60);
      await pay(invoice.id, { method: 'CARD', reference: '1234' }).expect(201);

      const preview = await request(harness.server)
        .get(`${API}/cash-sessions/${session.id}/preview-close`)
        .set('Cookie', cashier)
        .expect(200);
      expect(Number(preview.body.expectedCashSen)).toBe(10_000);
      expect(preview.body.totalsByMethod.CARD).toBe('6000');
    });

    it('PAY-T-08: a variance over the threshold needs an administrator', async () => {
      await closeAnyOpenSession();
      const session = await openSession(200);

      // Counted RM 15 short of the RM 200 float — over the RM 10 default.
      const refused = await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/close`)
        .set('Cookie', cashier)
        .send({ counted: 185, note: 'Short' })
        .expect(403);
      expect(
        refused.body.errors?.varianceSen ?? refused.body.varianceSen,
      ).toBeDefined();

      // An administrator saying so, deliberately, with a note.
      const noNote = await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/close`)
        .set('Cookie', admin)
        .send({ counted: 185, approve: true })
        .expect(400);
      expect(noNote.body.code).toBe('note_required');

      const closed = await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/close`)
        .set('Cookie', admin)
        .send({
          counted: 185,
          approve: true,
          note: 'Short by RM 15; investigating with the team',
        })
        .expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(Number(closed.body.varianceSen)).toBe(-1_500);
      expect(closed.body.approvedBy).toBeTruthy();
    });

    it('a variance inside the threshold closes without ceremony, and is still recorded', async () => {
      await closeAnyOpenSession();
      const session = await openSession(200);
      const closed = await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/close`)
        .set('Cookie', cashier)
        .send({ counted: 197.65, note: 'Coins' })
        .expect(200);

      // Recorded, never corrected: the expected figure is what the
      // movements say, not what makes the count balance.
      expect(Number(closed.body.expectedCashSen)).toBe(20_000);
      expect(Number(closed.body.countedCashSen)).toBe(19_765);
      expect(Number(closed.body.varianceSen)).toBe(-235);
    });

    it('one drawer is open at a time, and the database says so too', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const second = await request(harness.server)
        .post(`${API}/branches/${branch}/cash-sessions`)
        .set('Cookie', cashier)
        .send({ float: 100 })
        .expect(409);
      expect(second.body.code).toBe('session_already_open');

      // Two drawers are fine; two of the same drawer are not (§14).
      const other = await openSession(100, cashier, 'BACK');
      expect(other.status).toBe('OPEN');

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO cash_session (id, tenant_id, branch_id, drawer_code, status, opened_by, opened_at, float_amount, created_at, updated_at)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'BACK', 'OPEN', $3::uuid, now(), 0, now(), now())`,
            fx.tenantId,
            branch,
            fx.admin.id,
          ),
        ),
      ).rejects.toThrow();
    });

    it('a Z-report says what was taken, and freezes at close', async () => {
      await closeAnyOpenSession();
      const session = await openSession(200);
      const invoice = await invoiceFor(30);
      await pay(invoice.id, { method: 'CASH', tendered: 50 }).expect(201);

      const open = await request(harness.server)
        .get(`${API}/cash-sessions/${session.id}/z-report`)
        .set('Cookie', cashier)
        .expect(200);
      expect(open.body.asAtClose).toBe(false);
      expect(Number(open.body.collectedSen)).toBe(3_000);
      expect(open.body.payments).toBe(1);

      await request(harness.server)
        .post(`${API}/cash-sessions/${session.id}/close`)
        .set('Cookie', cashier)
        .send({ counted: 230 })
        .expect(200);

      const closed = await request(harness.server)
        .get(`${API}/cash-sessions/${session.id}/z-report`)
        .set('Cookie', cashier)
        .expect(200);
      expect(closed.body.asAtClose).toBe(true);
      expect(closed.body.totalsByMethod.CASH).toBe('3000');
      expect(Number(closed.body.expectedCashSen)).toBe(23_000);
    });
  });

  // -------------------------------------------------- void and refund

  describe('Putting it back (PAY-F-17, F-18)', () => {
    it('PAY-T-09: voiding reverses the invoice and the drawer', async () => {
      await closeAnyOpenSession();
      const session = await openSession(200);
      const invoice = await invoiceFor(77.43);
      const paid = await pay(invoice.id, {
        method: 'CASH',
        tendered: 100,
      }).expect(201);

      const before = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(before.body.status).toBe('PAID');

      await reauth(admin);
      await request(harness.server)
        .post(`${API}/payments/${paid.body.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Cashier recorded cash for a card payment' })
        .expect(200);

      const after = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      expect(after.body.status).toBe('ISSUED');
      expect(Number(after.body.paidSen)).toBe(0);
      // The rounding went back with it, or the invoice would keep an
      // adjustment for a payment that no longer exists.
      expect(Number(after.body.balanceSen)).toBe(7_743);

      const report = await request(harness.server)
        .get(`${API}/cash-sessions/${session.id}/z-report`)
        .set('Cookie', cashier)
        .expect(200);
      expect(
        report.body.movements.some(
          (m: { type: string }) => m.type === 'VOID_OUT',
        ),
      ).toBe(true);
      expect(Number(report.body.expectedCashSen)).toBe(20_000);
    });

    it('PAY-T-10: yesterday cannot be voided, only refunded', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(50);
      const paid = await pay(invoice.id, {
        method: 'CASH',
        tendered: 50,
      }).expect(201);

      // Aged by a day, because a test cannot wait. `received_at` is one
      // of the columns the immutability trigger protects — which is the
      // right answer and is asserted in PAY-T-11 — so this goes around
      // it deliberately, the way the consultation suite does.
      await harness.db.withPlatform('age a payment for the test', (tx) =>
        tx.$executeRawUnsafe(
          'ALTER TABLE payment DISABLE TRIGGER payment_is_immutable_trigger',
        ),
      );
      try {
        await harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE payment SET received_at = now() - interval '1 day' WHERE id = $1::uuid`,
            paid.body.id,
          ),
        );
      } finally {
        await harness.db.withPlatform('restore the trigger', (tx) =>
          tx.$executeRawUnsafe(
            'ALTER TABLE payment ENABLE TRIGGER payment_is_immutable_trigger',
          ),
        );
      }

      await reauth(admin);
      const refused = await request(harness.server)
        .post(`${API}/payments/${paid.body.id}/void`)
        .set('Cookie', admin)
        .send({ reason: 'Trying to void a payment taken yesterday' })
        .expect(409);
      expect(refused.body.code).toBe('not_same_day');

      await reauth(admin);
      const refunded = await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/refunds`)
        .set('Cookie', admin)
        .send({
          amount: 50,
          method: 'CASH',
          reason: 'Patient was charged for a procedure that was not done',
          refundOfId: paid.body.id,
          idempotencyKey: newId(),
        })
        .expect(201);

      expect(Number(refunded.body.amountSen)).toBe(-5_000);
      expect(refunded.body.refundOfId).toBe(paid.body.id);

      const after = await request(harness.server)
        .get(`${API}/invoices/${invoice.id}/payments`)
        .set('Cookie', cashier)
        .expect(200);
      // The trail reads as two events, which is what happened.
      expect(after.body.items).toHaveLength(2);
      expect(Number(after.body.paidSen)).toBe(0);
    });

    it('will not refund more than was ever paid', async () => {
      await closeAnyOpenSession();
      await openSession(200);
      const invoice = await invoiceFor(50);
      await pay(invoice.id, { method: 'CASH', tendered: 50 }).expect(201);

      await reauth(admin);
      const refused = await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/refunds`)
        .set('Cookie', admin)
        .send({
          amount: 80,
          method: 'CASH',
          reason: 'Refunding more than the patient ever handed over',
          idempotencyKey: newId(),
        })
        .expect(409);
      expect(refused.body.code).toBe('refund_exceeds_paid');
    });
  });

  // ------------------------------------------------------ immutable

  it('PAY-T-11: a posted payment cannot be edited or deleted', async () => {
    await closeAnyOpenSession();
    await openSession(200);
    const invoice = await invoiceFor(40);
    const paid = await pay(invoice.id, { method: 'CASH', tendered: 50 }).expect(
      201,
    );

    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE payment SET amount = 1 WHERE id = $1::uuid`,
          paid.body.id,
        ),
      ),
    ).rejects.toThrow(/cannot be edited/i);

    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM payment WHERE id = $1::uuid`,
          paid.body.id,
        ),
      ),
    ).rejects.toThrow(/is kept/i);

    // A drawer movement is a fact too: the correction is another movement.
    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE cash_session_movement SET amount = 1 WHERE reference_id = $1::uuid`,
          paid.body.id,
        ),
      ),
    ).rejects.toThrow(/is a fact/i);
  });

  // -------------------------------------------------------- receipt

  it('PAY-F-14: a receipt is issued once and reprints as the same one', async () => {
    await closeAnyOpenSession();
    await openSession(200);
    const invoice = await invoiceFor(77.43);
    const paid = await pay(invoice.id, {
      method: 'CASH',
      tendered: 100,
    }).expect(201);

    const receipt = await request(harness.server)
      .get(`${API}/payments/${paid.body.id}/receipt`)
      .set('Cookie', cashier)
      .expect(200);
    expect(receipt.body.reissued).toBe(false);
    expect(receipt.body.receiptNo).toBe(paid.body.receiptNo);

    // Asking again gives the same document, not a second one claiming
    // the same money was taken (§14, the power-cut case).
    const again = await request(harness.server)
      .get(`${API}/payments/${paid.body.id}/receipt`)
      .set('Cookie', cashier)
      .expect(200);
    expect(again.body.reissued).toBe(true);
    expect(again.body.document.id).toBe(receipt.body.document.id);

    const html = await request(harness.server)
      .get(`${API}/documents/${receipt.body.document.id}/file?copy=false`)
      .set('Cookie', cashier)
      .expect(200);
    expect(html.text).toContain(paid.body.receiptNo);
    expect(html.text).toContain('77.45');
    expect(html.text).toContain('Rounding');
    expect(html.text).toContain('Change');

    // PAY-F-15: the first print is the handover, the second is a copy.
    const first = await request(harness.server)
      .post(`${API}/payments/${paid.body.id}/receipt/reprint`)
      .set('Cookie', cashier)
      .expect(200);
    expect(first.body.isCopy).toBe(false);
    const second = await request(harness.server)
      .post(`${API}/payments/${paid.body.id}/receipt/reprint`)
      .set('Cookie', cashier)
      .expect(200);
    expect(second.body.isCopy).toBe(true);
  });

  // ------------------------------------------- what payment unblocks

  it('BIL-F-17: a visit cannot finish while its bill is unpaid, and can once it is', async () => {
    await closeAnyOpenSession();
    await openSession(200);

    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Pay Visit ${Date.now()}`,
        idType: 'NONE',
        notes: 'Test patient',
        gender: 'MALE',
        dateOfBirth: '1980-01-01',
        phone: '019-7000001',
      })
      .expect(201);

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', reception)
      .send({ patientId: patient.body.patient.id })
      .expect(201);
    const encounterId = encounter.body.encounter.id as string;

    const draft = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/invoice`)
      .set('Cookie', cashier)
      .send({})
      .expect(201);
    await request(harness.server)
      .post(`${API}/invoices/${draft.body.invoice.id}/lines`)
      .set('Cookie', cashier)
      .send({ description: 'Consultation', quantity: 1, unitPrice: 40 })
      .expect(201);
    await request(harness.server)
      .post(`${API}/invoices/${draft.body.invoice.id}/issue`)
      .set('Cookie', cashier)
      .send({})
      .expect(200);

    // Walk the visit to the desk, which is the only place `COMPLETED`
    // is reachable from for a patient who has been seen.
    for (const to of [
      'TRIAGE_IN_PROGRESS',
      'DOCTOR_WAITING',
      'IN_CONSULTATION',
      'PAYMENT_WAITING',
    ]) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to })
        .expect(200);
    }

    const blocked = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/transition`)
      .set('Cookie', reception)
      .send({ to: 'COMPLETED' })
      .expect(422);
    expect(JSON.stringify(blocked.body)).toContain('balance_outstanding');

    await pay(draft.body.invoice.id, { method: 'CASH', tendered: 40 }).expect(
      201,
    );

    await request(harness.server)
      .post(`${API}/encounters/${encounterId}/transition`)
      .set('Cookie', reception)
      .send({ to: 'COMPLETED' })
      .expect(200);
  });

  it('PAY-N-04: the nightly check agrees, and notices when it should not', async () => {
    await closeAnyOpenSession();
    await openSession(200);
    const invoice = await invoiceFor(40);
    await pay(invoice.id, { method: 'CASH', tendered: 40 }).expect(201);

    const job = harness.app.get(PaymentReconciliationJob);
    const clean = await harness.db.withTenant(fx.tenantId, (tx) =>
      job.verify(tx),
    );
    expect(clean.checked).toBeGreaterThan(0);
    expect(clean.mismatched).toEqual([]);

    // The invoice is not immutable in `amount_paid` — that is the column
    // payment is allowed to move — so this is exactly the drift the job
    // exists to find.
    // The invoice keeps its own `balance = total + rounding − paid`
    // CHECK, so the drift has to be introduced without breaking that —
    // which is exactly the shape a real bug would take, and exactly the
    // shape no constraint can catch.
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE invoice SET amount_paid = amount_paid + 100, balance = balance - 100
          WHERE id = $1::uuid`,
        invoice.id,
      ),
    );
    const dirty = await harness.db.withTenant(fx.tenantId, (tx) =>
      job.verify(tx),
    );
    expect(dirty.mismatched.map((row) => row.invoiceId)).toContain(invoice.id);

    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE invoice SET amount_paid = amount_paid - 100, balance = balance + 100
          WHERE id = $1::uuid`,
        invoice.id,
      ),
    );
    expect(
      (await harness.db.withTenant(fx.tenantId, (tx) => job.verify(tx)))
        .mismatched,
    ).toEqual([]);
  });

  it('RPT: collections now report what was actually taken', async () => {
    await closeAnyOpenSession();
    await openSession(200);
    const invoice = await invoiceFor(60);
    await pay(invoice.id, { method: 'CASH', tendered: 60 }).expect(201);

    const outstanding = await request(harness.server)
      .get(`${API}/branches/${branch}/outstanding`)
      .set('Cookie', cashier)
      .expect(200);
    expect(
      outstanding.body.items.some(
        (row: { invoiceId: string }) => row.invoiceId === invoice.id,
      ),
    ).toBe(false);
  });
});
