import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { ringgitToSen } from '../src/modules/billing/money.js';
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

/** The consultation fee this suite seeds, in sen. */
const FEE_SEN = 4_000n;

describe('RPT — reporting', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let cashier: string;
  let branch: string;

  let seq = 0;

  /** What this suite issued, computed here rather than read back. */
  const expected = {
    issuedInvoices: 0,
    grandTotalSen: 0n,
    voidedInvoices: 0,
    voidedSen: 0n,
    discountSen: 0n,
  };

  async function newPatient(): Promise<string> {
    seq += 1;
    const day = String((seq % 28) + 1).padStart(2, '0');
    const response = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Report Patient ${seq}`,
        idType: 'MYKAD',
        idNumber: `9003${day}-10-${String(6000 + seq).slice(0, 4)}`,
        gender: seq % 2 === 0 ? 'MALE' : 'FEMALE',
        dateOfBirth: `1990-03-${day}`,
        phone: `019-${String(50_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    return response.body.patient.id as string;
  }

  /** A visit that reaches a signed consultation, so it carries the fee. */
  async function visit(patientId?: string) {
    const id = patientId ?? (await newPatient());
    await request(harness.server)
      .put(`${API}/patients/${id}/nkda`)
      .set('Cookie', doctor)
      .send({ nkda: true })
      .expect(200);

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', reception)
      .send({ patientId: id })
      .expect(201);
    const encounterId = encounter.body.encounter.id as string;

    for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING']) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to })
        .expect(200);
    }
    // Called, then seen. The wait the queue report measures is from
    // check-in to this moment, and it comes from the event log rather
    // than from a column — so it only exists if somebody was called.
    await request(harness.server)
      .post(`${API}/encounters/${encounterId}/call`)
      .set('Cookie', doctor)
      .expect(200);
    await request(harness.server)
      .post(`${API}/encounters/${encounterId}/transition`)
      .set('Cookie', doctor)
      .send({ to: 'IN_CONSULTATION' })
      .expect(200);

    const created = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/consultations`)
      .set('Cookie', doctor)
      .send({})
      .expect(201);
    const consultationId = created.body.id as string;
    await request(harness.server)
      .patch(`${API}/consultations/${consultationId}`)
      .set('Cookie', doctor)
      .send({ chiefComplaint: 'Batuk' })
      .expect(200);
    await request(harness.server)
      .put(`${API}/consultations/${consultationId}/diagnoses`)
      .set('Cookie', doctor)
      .send({
        diagnoses: [
          {
            rank: 'PRIMARY',
            description: 'Acute bronchitis',
            certainty: 'CONFIRMED',
          },
        ],
      })
      .expect(200);
    await request(harness.server)
      .post(`${API}/consultations/${consultationId}/sign`)
      .set('Cookie', doctor)
      .send({})
      .expect(200);

    return { patientId: id, encounterId, consultationId };
  }

  /**
   * Bill it, settle it and close it, so the patient can come back.
   *
   * Settling is not optional any more: `PAY` registers the
   * outstanding-balance guard `BIL` left unregistered, so a visit with
   * an unpaid bill cannot be completed. That is the intended behaviour
   * and this fixture has to live with it like the clinic will.
   */
  async function finishVisit(encounterId: string) {
    const invoice = await issueInvoiceFor(encounterId);
    await request(harness.server)
      .post(`${API}/invoices/${invoice.id}/payments`)
      .set('Cookie', cashier)
      .send({ method: 'CASH', idempotencyKey: newId() })
      .expect(201);

    for (const to of ['PAYMENT_WAITING', 'COMPLETED']) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', reception)
        .send({ to })
        .expect(200);
    }
  }

  async function issueInvoiceFor(encounterId: string) {
    const draft = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/invoice`)
      .set('Cookie', cashier)
      .send({})
      .expect(201);
    const invoiceId = draft.body.invoice.id as string;
    const issued = await request(harness.server)
      .post(`${API}/invoices/${invoiceId}/issue`)
      .set('Cookie', cashier)
      .send({})
      .expect(200);
    return issued.body.invoice as {
      id: string;
      invoiceNo: string;
      grandTotalSen: number;
    };
  }

  function report(
    path: string,
    cookie = admin,
    query: Record<string, unknown> = {},
  ) {
    return request(harness.server)
      .get(`${API}/branches/${branch}/reports/${path}`)
      .set('Cookie', cookie)
      .query(query);
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('reports');
    branch = fx.branchAId;

    const cashierUser = await harness.addUser(fx, {
      name: 'Juruwang Report',
      roles: [{ branchId: fx.branchAId, role: Role.CASHIER }],
    });
    [doctor, reception, cashier] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, cashierUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);

    await request(harness.server)
      .post(`${API}/fee-schedule`)
      .set('Cookie', admin)
      .send({ fee: Number(FEE_SEN) / 100 })
      .expect(201);

    // A drawer, because nothing can be paid without one and a visit
    // cannot be completed without being paid.
    await request(harness.server)
      .post(`${API}/branches/${branch}/cash-sessions`)
      .set('Cookie', cashier)
      .send({ float: 100 })
      .expect(201);

    // ---- The seeded day (RPT-T-01), computed by hand as it is built.
    //
    // Four visits that become invoices, one of them discounted, one of
    // them voided afterwards. Two more visits that end without a bill:
    // one cancelled, one no-show.

    // 1 and 2: the plain ones. Fee only.
    for (let i = 0; i < 2; i += 1) {
      const made = await visit();
      const invoice = await issueInvoiceFor(made.encounterId);
      expected.issuedInvoices += 1;
      expected.grandTotalSen += BigInt(invoice.grandTotalSen);
    }

    // 3: a fee plus a manual line of RM 25.50, then 10% off the invoice.
    {
      const made = await visit();
      const draft = await request(harness.server)
        .post(`${API}/encounters/${made.encounterId}/invoice`)
        .set('Cookie', cashier)
        .send({})
        .expect(201);
      const invoiceId = draft.body.invoice.id as string;
      await request(harness.server)
        .post(`${API}/invoices/${invoiceId}/lines`)
        .set('Cookie', cashier)
        .send({ description: 'Dressing', quantity: 1, unitPrice: 25.5 })
        .expect(201);
      const discounted = await request(harness.server)
        .put(`${API}/invoices/${invoiceId}/discount`)
        .set('Cookie', cashier)
        .send({
          pct: 10,
          source: 'STAFF',
          reason: 'Staff family, approved by the owner',
        })
        .expect(200);
      const issued = await request(harness.server)
        .post(`${API}/invoices/${invoiceId}/issue`)
        .set('Cookie', cashier)
        .send({})
        .expect(200);

      expected.issuedInvoices += 1;
      expected.grandTotalSen += BigInt(issued.body.invoice.grandTotalSen);
      expected.discountSen += BigInt(
        ringgitToSen(discounted.body.invoice.discountTotal),
      );
      // RM 40.00 + RM 25.50 = RM 65.50, less 10% = RM 58.95.
      expect(issued.body.invoice.grandTotalSen).toBe(5_895);
    }

    // 4: issued and then voided. It is not a sale; it is a void.
    {
      const made = await visit();
      const invoice = await issueInvoiceFor(made.encounterId);
      await request(harness.server)
        .post(`${API}/invoices/${invoice.id}/void`)
        // Voiding is the administrator's, not the counter's (BIL §16).
        .set('Cookie', admin)
        .send({ reason: 'Wrong patient charged at the counter' })
        .expect(200);
      expected.voidedInvoices += 1;
      expected.voidedSen += BigInt(invoice.grandTotalSen);
    }

    // 5 and 6: a cancellation and a no-show, neither billed.
    {
      const patientId = await newPatient();
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);
      await request(harness.server)
        .post(`${API}/encounters/${encounter.body.encounter.id}/cancel`)
        .set('Cookie', reception)
        .send({ reason: 'Patient left before being seen' })
        .expect(200);
    }
    {
      const patientId = await newPatient();
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);
      await request(harness.server)
        .post(`${API}/encounters/${encounter.body.encounter.id}/no-show`)
        .set('Cookie', reception)
        .send({ reason: 'Called three times' })
        .expect(200);
    }
  }, 360_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------------- money

  describe('RPT-T-01: the figures equal the hand-computed totals, to the sen', () => {
    it('daily sales counts issued invoices and excludes voided ones', async () => {
      const response = await report('daily-sales').expect(200);
      const days = response.body.data as Array<{
        day: string;
        invoices: string;
        grand_total: string;
        discount_total: string;
      }>;
      expect(days).toHaveLength(1);

      const today = days[0]!;
      expect(Number(today.invoices)).toBe(expected.issuedInvoices);
      expect(BigInt(today.grand_total)).toBe(expected.grandTotalSen);
      expect(BigInt(today.discount_total)).toBe(expected.discountSen);
      // Three invoices: two at RM 40 and one at RM 58.95.
      expect(expected.grandTotalSen).toBe(4_000n + 4_000n + 5_895n);
    });

    it('voids are listed separately, with a reason, and are not sales', async () => {
      const response = await report('voids').expect(200);
      const rows = response.body.data as Array<{
        grand_total: string;
        reason: string;
      }>;
      expect(rows).toHaveLength(expected.voidedInvoices);
      expect(BigInt(rows[0]!.grand_total)).toBe(expected.voidedSen);
      expect(rows[0]!.reason).toContain('Wrong patient');
    });

    it('discounts name the invoice, the reason and who allowed it', async () => {
      const response = await report('discounts').expect(200);
      const data = response.body.data as {
        invoices: Array<{ amount: string; reason: string; pct: string }>;
        totals: { discount_total: string };
      };
      expect(data.invoices).toHaveLength(1);
      expect(data.invoices[0]!.reason).toContain('Staff family');
      // RM 65.50 at 10% is RM 6.55, and it is stored, not recomputed.
      expect(BigInt(data.invoices[0]!.amount)).toBe(655n);
      expect(BigInt(data.totals.discount_total)).toBe(expected.discountSen);
    });

    it('everything issued is still outstanding, in the newest bucket', async () => {
      const response = await report('outstanding').expect(200);
      const data = response.body.data as {
        rows: Array<{ bucket: string; balance: string }>;
        buckets: Record<string, { invoices: number; balance: string }>;
        total: string;
      };
      expect(data.rows).toHaveLength(expected.issuedInvoices);
      expect(BigInt(data.total)).toBe(expected.grandTotalSen);
      expect(data.buckets['0-7']!.invoices).toBe(expected.issuedInvoices);
      expect(data.buckets['60+']!.invoices).toBe(0);
    });

    it('RPT-F-18: issued equals collected plus outstanding, to the sen', async () => {
      const response = await report('reconciliation').expect(200);
      const data = response.body.data as {
        issuedSen: string;
        collectedSen: string;
        outstandingSen: string;
        voidedSen: string;
        differenceSen: string;
        balanced: boolean;
        paymentsAgreeWithInvoices: boolean;
        collectionsAvailable: boolean;
      };

      expect(BigInt(data.issuedSen)).toBe(expected.grandTotalSen);
      expect(BigInt(data.voidedSen)).toBe(expected.voidedSen);
      // Nothing was paid in this suite, so it is all still outstanding —
      // but the term is real now rather than structurally zero.
      expect(BigInt(data.collectedSen)).toBe(0n);
      expect(BigInt(data.outstandingSen)).toBe(expected.grandTotalSen);
      expect(BigInt(data.differenceSen)).toBe(0n);
      expect(data.balanced).toBe(true);
      // The two ways of knowing what was collected agree, which is the
      // assertion that would catch a payment the invoice never heard of.
      expect(data.paymentsAgreeWithInvoices).toBe(true);
      expect(data.collectionsAvailable).toBe(true);
    });

    it('RPT-F-13: collections exist, and are empty because nothing was paid', async () => {
      const response = await report('collections', admin, {
        by: 'method',
      }).expect(200);
      expect(response.body.data).toEqual([]);

      const catalogue = await request(harness.server)
        .get(`${API}/reports`)
        .set('Cookie', admin)
        .expect(200);
      const keys = catalogue.body.items.map((r: { key: string }) => r.key);
      expect(keys).toContain('collections');
      expect(keys).toContain('reconciliation');
      // Nothing is listed as unavailable any more: `PAY` was the last
      // thing V0 was waiting for.
      expect(catalogue.body.unavailable).toEqual([]);
    });

    it('RPT-F-14: the end-of-day pack assembles from the same reports', async () => {
      const pack = await request(harness.server)
        .get(`${API}/branches/${branch}/reports/eod-pack`)
        .set('Cookie', admin)
        .expect(200);

      expect(pack.body).toHaveProperty('sessions');
      expect(pack.body).toHaveProperty('reconciliation');
      expect(pack.body).toHaveProperty('stockAlerts');
      // The pack's sales figure is the sales report's figure, because it
      // is the sales report — not a second query that could drift.
      const onScreen = await report('daily-sales').expect(200);
      expect(pack.body.sales).toEqual(onScreen.body.data);
    });

    it('the breakdown by line type sums to subtotal less discounts', async () => {
      const [sales, breakdown] = await Promise.all([
        report('daily-sales').expect(200),
        report('sales-breakdown', admin, { by: 'lineType' }).expect(200),
      ]);
      const day = (
        sales.body.data as Array<{ subtotal: string; discount_total: string }>
      )[0]!;
      const lines = breakdown.body.data as Array<{ total: string }>;
      const lineTotal = lines.reduce((sum, row) => sum + BigInt(row.total), 0n);
      // Tax and rounding belong to the invoice, not to any line, and
      // both are zero here — so the lines meet the invoice exactly.
      expect(lineTotal).toBe(BigInt(day.subtotal) - BigInt(day.discount_total));
    });
  });

  // ------------------------------------------------------- who may see

  it('RPT-T-03: the front desk is refused the money, and the dashboard omits it', async () => {
    await report('daily-sales', reception).expect(403);
    await report('discounts', reception).expect(403);
    await report('outstanding', reception).expect(403);

    const theirs = await request(harness.server)
      .get(`${API}/branches/${branch}/dashboard`)
      .set('Cookie', reception)
      .expect(200);
    // Not zero, and not hidden by the browser: absent.
    expect(theirs.body.money).toBeNull();
    expect(theirs.body.patients.registered).toBeGreaterThan(0);

    const owners = await request(harness.server)
      .get(`${API}/branches/${branch}/dashboard`)
      .set('Cookie', admin)
      .expect(200);
    expect(BigInt(owners.body.money.billedSen)).toBe(expected.grandTotalSen);

    // And the catalogue only lists what the caller may run.
    const theirList = await request(harness.server)
      .get(`${API}/reports`)
      .set('Cookie', reception)
      .expect(200);
    const keys = theirList.body.items.map((r: { key: string }) => r.key);
    expect(keys).toContain('patient-register');
    expect(keys).not.toContain('daily-sales');
  });

  // ----------------------------------------------------- operational

  it('RPT-T-04: the median wait equals the hand-computed value', async () => {
    const response = await report('queue-performance').expect(200);
    const days = response.body.data as Array<{
      seen: string;
      median_wait_seconds: number;
      p90_wait_seconds: number;
      longest_wait_seconds: number;
    }>;
    expect(days).toHaveLength(1);

    // Four visits reached the doctor. Every one was called within the
    // same second in a test, so every percentile is the same small
    // number — what is being proved is that the arithmetic runs over the
    // event log and orders correctly, not that the clinic is fast.
    const today = days[0]!;
    expect(Number(today.seen)).toBe(4);
    expect(today.median_wait_seconds).toBeGreaterThanOrEqual(0);
    expect(today.median_wait_seconds).toBeLessThanOrEqual(
      today.p90_wait_seconds,
    );
    expect(today.p90_wait_seconds).toBeLessThanOrEqual(
      today.longest_wait_seconds,
    );
  });

  it('RPT-T-05: a first-ever visit is new today and returning next time', async () => {
    const before = await report('patients-summary', admin, {
      groupBy: 'day',
    }).expect(200);
    const first = (
      before.body.data as Array<{ new_patients: string; returning: string }>
    )[0]!;

    // A patient who has been before, coming again.
    const patientId = await newPatient();
    const firstVisit = await visit(patientId);
    const middle = await report('patients-summary', admin, {
      groupBy: 'day',
    }).expect(200);
    const second = (
      middle.body.data as Array<{ new_patients: string; returning: string }>
    )[0]!;
    expect(Number(second.new_patients)).toBe(Number(first.new_patients) + 1);
    expect(Number(second.returning)).toBe(Number(first.returning));

    await finishVisit(firstVisit.encounterId);
    const secondVisit = await visit(patientId);
    const after = await report('patients-summary', admin, {
      groupBy: 'day',
    }).expect(200);
    const third = (
      after.body.data as Array<{ new_patients: string; returning: string }>
    )[0]!;
    // The same person again: still one "new" for their first visit ever,
    // and now one "returning". "New" does not creep upward.
    expect(Number(third.new_patients)).toBe(Number(second.new_patients));
    expect(Number(third.returning)).toBe(Number(second.returning) + 1);
    await finishVisit(secondVisit.encounterId);
  });

  it('counts no-shows and cancellations, and the register lists every visit', async () => {
    const attendance = await report('attendance').expect(200);
    expect(attendance.body.data.noShow).toBe(1);
    expect(attendance.body.data.cancelled).toBe(1);
    expect(attendance.body.data.noShowRate).toBeGreaterThan(0);

    const register = await report('patient-register').expect(200);
    const rows = register.body.data as Array<{
      patient_name: string;
      billed_sen: string;
    }>;
    expect(rows.length).toBe(attendance.body.data.registered);
    expect(rows.some((r) => BigInt(r.billed_sen) === 5_895n)).toBe(true);
    // A cancelled visit has no bill, and shows zero rather than nothing.
    expect(rows.some((r) => BigInt(r.billed_sen) === 0n)).toBe(true);
  });

  it('groups diagnoses however they were typed', async () => {
    const response = await report('diagnoses', admin, { top: 10 }).expect(200);
    const rows = response.body.data as Array<{
      label: string;
      occurrences: string;
    }>;
    const bronchitis = rows.find((r) =>
      r.label.toLowerCase().includes('bronchitis'),
    );
    expect(bronchitis).toBeTruthy();
    expect(Number(bronchitis!.occurrences)).toBeGreaterThanOrEqual(4);
  });

  it('reports the prescribing rate next to its own uncertainty', async () => {
    const response = await report('prescribing', admin, { top: 10 }).expect(
      200,
    );
    const totals = response.body.data.totals as {
      items: number;
      antibiotics: number;
      antibioticRate: number;
      unclassified: number;
    };
    // Nothing was prescribed in this suite, so the honest answer is zero
    // of zero — and specifically not NaN, which is what dividing by the
    // count would give.
    expect(totals.items).toBe(0);
    expect(totals.antibioticRate).toBe(0);
    expect(totals.unclassified).toBe(0);
  });

  it('a doctor sees their own numbers without the operational report', async () => {
    const mine = await request(harness.server)
      .get(`${API}/me/stats`)
      .set('Cookie', doctor)
      .expect(200);
    expect(mine.body.consultations).toBeGreaterThanOrEqual(4);

    await request(harness.server)
      .get(`${API}/me/stats`)
      .set('Cookie', reception)
      .expect(403);
  });

  // ------------------------------------------------------------- stock

  it('values the shelves at cost and lists what INV is shouting about', async () => {
    const valuation = await report('stock/valuation', admin).expect(200);
    expect(valuation.body.data).toHaveProperty('totalCostSen');

    const alerts = await report('stock/alerts', admin).expect(200);
    expect(Array.isArray(alerts.body.data)).toBe(true);

    const movements = await report('stock/movements', admin).expect(200);
    expect(movements.body.data).toHaveProperty('shrinkageSen');
  });

  // ------------------------------------------------------------ ranges

  it('RPT-F-19, §12: a range is a branch day, and it is bounded', async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const empty = await report('daily-sales', admin, {
      from: yesterday,
      to: yesterday,
    }).expect(200);
    expect(empty.body.data).toEqual([]);

    await report('daily-sales', admin, { from: '2020-01-01' }).expect(400);
    const backwards = await report('daily-sales', admin, {
      from: '2026-09-30',
      to: '2026-09-01',
    }).expect(400);
    expect(backwards.body.code).toBe('range_backwards');
    await report('daily-sales', admin, { from: '30/09/2026' }).expect(400);
  });

  // ------------------------------------------------------------ export

  describe('RPT-T-07 / RPT-F-20: exports', () => {
    it('records what was taken and by whom', async () => {
      const exported = await request(harness.server)
        .post(`${API}/reports/patient-register/export`)
        .set('Cookie', admin)
        .expect(200);

      expect(exported.headers['content-type']).toMatch(/text\/csv/);
      expect(exported.headers['content-disposition']).toMatch(
        /patient-register-/,
      );
      expect(exported.text).toContain('registered_at,queue_no');
      expect(exported.text).toContain('Report Patient');
      // Both forms of every amount: sen that add up, ringgit that read.
      expect(exported.text).toContain('5895');
      expect(exported.text).toContain('58.95');

      const audit = await request(harness.server)
        .get(`${API}/audit`)
        .set('Cookie', admin)
        .query({ action: 'report.exported' })
        .expect(200);
      expect(audit.body.items.length).toBeGreaterThan(0);

      const entry = await request(harness.server)
        .get(`${API}/audit/${audit.body.items[0].id}`)
        .set('Cookie', admin)
        .expect(200);
      expect(entry.body.after.report).toBe('patient-register');
      // §15: an export naming patients is worth knowing about.
      expect(entry.body.after.patientLevel).toBe(true);
    });

    it('refuses a report the caller could not have run', async () => {
      await request(harness.server)
        .post(`${API}/reports/daily-sales/export`)
        .set('Cookie', reception)
        .expect(403);
      await request(harness.server)
        .post(`${API}/reports/not-a-report/export`)
        .set('Cookie', admin)
        .expect(404);
    });

    it('the CSV and the screen cannot disagree, because they are the same rows', async () => {
      const [screen, file] = await Promise.all([
        report('daily-sales').expect(200),
        request(harness.server)
          .post(`${API}/reports/daily-sales/export`)
          .set('Cookie', admin)
          .expect(200),
      ]);
      const day = (screen.body.data as Array<{ grand_total: string }>)[0]!;
      expect(file.text).toContain(day.grand_total);
    });
  });
});
