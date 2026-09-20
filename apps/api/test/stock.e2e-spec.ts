import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { StockReconciliationJob } from '../src/modules/stock/reconciliation.job.js';

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

/** A date far enough out that no test accidentally writes it off. */
function inYears(years: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), 15))
    .toISOString()
    .slice(0, 10);
}

describe('INV — stock', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
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
        sellingPrice: 0.45,
        ...over,
      })
      .expect(201);
    return response.body.id as string;
  }

  async function stockIn(lines: Record<string, unknown>[], cookie = admin, status = 201) {
    return request(harness.server)
      .post(`${API}/branches/${branch}/stock-in`)
      .set('Cookie', cookie)
      .send({ lines })
      .expect(status);
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
      status: string;
      expiryDate: string | null;
    }>;
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('stock');
    branch = fx.branchAId;
    doctor = await signIn(harness, fx.doctor.email);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------- receiving

  describe('Getting stock in (INV-F-08, INV-F-12)', () => {
    it('creates the batch and posts a RECEIVE that balances', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'A-100', expiry: inYears(2), quantity: 240, costPrice: 0.3 },
      ]);

      const [batch] = await batchesOf(product);
      expect(batch?.quantityOnHand).toBe(240);
      expect(batch?.status).toBe('ACTIVE');

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      expect(movements.body.items).toHaveLength(1);
      expect(movements.body.items[0]).toMatchObject({
        type: 'RECEIVE',
        quantity: 240,
        balanceAfter: 240,
      });
    });

    it('adds a second delivery of the same lot to the same batch', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'B-1', expiry: inYears(2), quantity: 100 },
      ]);
      await stockIn([
        { productId: product, batchNo: 'B-1', expiry: inYears(2), quantity: 50 },
      ]);

      const batches = await batchesOf(product);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.quantityOnHand).toBe(150);
    });

    it('reads a month-stamped expiry as the end of that month', async () => {
      const product = await addProduct();
      const year = new Date().getUTCFullYear() + 2;
      await stockIn([
        { productId: product, batchNo: 'M-1', expiry: `${year}-03`, quantity: 10 },
      ]);
      const [batch] = await batchesOf(product);
      expect(batch?.expiryDate?.slice(0, 10)).toBe(`${year}-03-31`);
    });

    it('refuses a batched product with no batch number or no expiry', async () => {
      const product = await addProduct();
      const noNumber = await stockIn(
        [{ productId: product, expiry: inYears(2), quantity: 10 }],
        admin,
        400,
      );
      expect(noNumber.body.detail).toContain('batch number');

      const noExpiry = await stockIn(
        [{ productId: product, batchNo: 'X-1', quantity: 10 }],
        admin,
        400,
      );
      expect(noExpiry.body.detail).toContain('expiry date');
    });

    it('refuses stock that is already expired', async () => {
      const product = await addProduct();
      const response = await stockIn(
        [{ productId: product, batchNo: 'OLD', expiry: '2020-01-01', quantity: 10 }],
        admin,
        400,
      );
      expect(response.body.detail).toContain('cannot be received');
    });

    it('will not let the same lot claim two different expiry dates', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'C-1', expiry: inYears(2), quantity: 10 }]);
      const clash = await stockIn(
        [{ productId: product, batchNo: 'C-1', expiry: inYears(3), quantity: 10 }],
        admin,
        409,
      );
      expect(clash.body.detail).toContain('One of the two is wrong');
    });

    it('INV-F-09: gives an unbatched product one synthetic batch per branch', async () => {
      const gauze = await addProduct({
        name: `Gauze ${seq + 100}`,
        type: 'CONSUMABLE',
        genericName: undefined,
        drugClass: undefined,
        strengthText: undefined,
        strengthValue: undefined,
        strengthUnit: undefined,
        dispenseUnit: 'pcs',
        isBatched: false,
      });
      await stockIn([{ productId: gauze, quantity: 500 }]);
      await stockIn([{ productId: gauze, quantity: 100 }]);

      const batches = await batchesOf(gauze);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.batchNo).toBe('NB');
      expect(batches[0]?.expiryDate).toBeNull();
      expect(batches[0]?.quantityOnHand).toBe(600);
    });

    it('records the whole delivery or none of it', async () => {
      const good = await addProduct();
      const bad = await addProduct();
      await stockIn(
        [
          { productId: good, batchNo: 'T-1', expiry: inYears(2), quantity: 10 },
          // No expiry: the second line fails, so the first must not stand.
          { productId: bad, batchNo: 'T-2', quantity: 10 },
        ],
        admin,
        400,
      );
      expect(await batchesOf(good)).toEqual([]);
    });
  });

  // ------------------------------------------------------ the ledger

  describe('The ledger (INV-R-01 … R-06)', () => {
    it('INV-R-04: refuses to take more than is on the shelf', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'D-1', expiry: inYears(2), quantity: 5 }]);
      const [batch] = await batchesOf(product);

      const refused = await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 6, reasonCode: 'lost' })
        .expect(422);
      expect(refused.body.detail).toContain('5');
      expect((await batchesOf(product))[0]?.quantityOnHand).toBe(5);
    });

    it('INV-R-05: every movement carries the balance it left behind', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'E-1', expiry: inYears(2), quantity: 100 }]);
      const [batch] = await batchesOf(product);

      for (const quantity of [10, 20, 5]) {
        await request(harness.server)
          .post(`${API}/branches/${branch}/adjustments`)
          .set('Cookie', admin)
          .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity, reasonCode: 'damaged' })
          .expect(200);
      }

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?batchId=${batch!.id}`)
        .set('Cookie', admin)
        .expect(200);
      // Newest first.
      expect(
        movements.body.items.map((m: { balanceAfter: number }) => m.balanceAfter),
      ).toEqual([65, 70, 90, 100]);
    });

    it('INV-R-06: a movement cannot be edited or deleted, whatever asks', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'F-1', expiry: inYears(2), quantity: 10 }]);

      const movement = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.stockMovement.findFirstOrThrow({ where: { branchId: branch, productId: product } }),
      );

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.stockMovement.update({ where: { id: movement.id }, data: { quantity: 999 } }),
        ),
      ).rejects.toThrow(/append-only/);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.stockMovement.delete({ where: { id: movement.id } }),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('INV-R-03: two people taking the last of something do not both succeed', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'G-1', expiry: inYears(2), quantity: 10 }]);
      const [batch] = await batchesOf(product);

      // Six at once, six each, ten on the shelf: exactly one can win.
      const attempts = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(harness.server)
            .post(`${API}/branches/${branch}/adjustments`)
            .set('Cookie', admin)
            .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 6, reasonCode: 'lost' }),
        ),
      );

      expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await batchesOf(product))[0]?.quantityOnHand).toBe(4);
    });

    it('derives the batch status from what is left', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'H-1', expiry: inYears(2), quantity: 3 }]);
      const [batch] = await batchesOf(product);

      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 3, reasonCode: 'lost' })
        .expect(200);

      expect((await batchesOf(product))[0]?.status).toBe('DEPLETED');
    });

    it('INV-F-13: an adjustment without a reason is refused', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'I-1', expiry: inYears(2), quantity: 10 }]);
      const [batch] = await batchesOf(product);

      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 1 })
        .expect(400);

      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 1, reasonCode: 'nonsense' })
        .expect(400);
    });
  });

  // ----------------------------------------------------------- FEFO

  describe('FEFO (INV-R-07)', () => {
    it('takes from the batch that expires first, not the one received first', async () => {
      const product = await addProduct();
      // Received first, expires later.
      await stockIn([{ productId: product, batchNo: 'LONG', expiry: inYears(3), quantity: 100 }]);
      // Received second, expires sooner: this one should go first.
      await stockIn([{ productId: product, batchNo: 'SHORT', expiry: inYears(1), quantity: 30 }]);

      const plan = await request(harness.server)
        .get(`${API}/branches/${branch}/fefo?productId=${product}&quantity=50`)
        .set('Cookie', doctor)
        .expect(200);

      expect(plan.body.picks).toHaveLength(2);
      expect(plan.body.picks[0]).toMatchObject({ batchNo: 'SHORT', quantity: 30 });
      expect(plan.body.picks[1]).toMatchObject({ batchNo: 'LONG', quantity: 20 });
      expect(plan.body.shortfall).toBe(0);
    });

    it('reports a shortfall rather than a half-made plan', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'J-1', expiry: inYears(2), quantity: 8 }]);

      const plan = await request(harness.server)
        .get(`${API}/branches/${branch}/fefo?productId=${product}&quantity=20`)
        .set('Cookie', doctor)
        .expect(200);
      expect(plan.body.shortfall).toBe(12);
    });

    it('never offers a blocked batch', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'K-1', expiry: inYears(2), quantity: 50 }]);
      const [batch] = await batchesOf(product);

      await request(harness.server)
        .post(`${API}/batches/${batch!.id}/block`)
        .set('Cookie', admin)
        .send({ reason: 'Manufacturer recall notice 2026/114' })
        .expect(200);

      const plan = await request(harness.server)
        .get(`${API}/branches/${branch}/fefo?productId=${product}&quantity=5`)
        .set('Cookie', doctor)
        .expect(200);
      expect(plan.body.picks).toEqual([]);
      expect(plan.body.shortfall).toBe(5);
    });
  });

  // ------------------------------------------------------- the views

  describe('Looking at it (INV-F-06, INV-F-18)', () => {
    it('RX-F-04: a product search says how many are on the shelf', async () => {
      const product = await addProduct({ name: `Findable Zyxwv ${seq + 200}` });
      await stockIn([{ productId: product, batchNo: 'L-1', expiry: inYears(2), quantity: 42 }]);

      const found = await request(harness.server)
        .get(`${API}/products?q=zyxwv`)
        .set('Cookie', doctor)
        .expect(200);
      const hit = found.body.items.find((i: { id: string }) => i.id === product);
      expect(hit.onHand).toBe(42);
      expect(found.body.stockKnown).toBe(true);
    });

    it('says nothing on hand for a product nobody has stocked', async () => {
      const product = await addProduct({ name: `Unstocked Qqqzz ${seq + 300}` });
      const found = await request(harness.server)
        .get(`${API}/products?q=qqqzz`)
        .set('Cookie', doctor)
        .expect(200);
      expect(found.body.items.find((i: { id: string }) => i.id === product).onHand).toBe(0);
    });

    it('shows the on-hand view with its batches and nearest expiry', async () => {
      const product = await addProduct({ name: `Viewable Pplmn ${seq + 400}` });
      await stockIn([{ productId: product, batchNo: 'N-1', expiry: inYears(3), quantity: 10 }]);
      await stockIn([{ productId: product, batchNo: 'N-2', expiry: inYears(1), quantity: 5 }]);

      const view = await request(harness.server)
        .get(`${API}/branches/${branch}/stock?q=pplmn`)
        .set('Cookie', admin)
        .expect(200);
      const row = view.body.items.find((i: { product: { id: string } }) => i.product.id === product);
      expect(row.onHand).toBe(15);
      expect(row.batches).toHaveLength(2);
      expect(row.nearestExpiry.slice(0, 4)).toBe(String(new Date().getUTCFullYear() + 1));
    });
  });

  // ------------------------------------------------------- the rules

  describe('Where stock meets the catalogue', () => {
    it('INV-F-05: a product with stock on the shelf cannot be withdrawn', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'O-1', expiry: inYears(2), quantity: 7 }]);

      const refused = await request(harness.server)
        .post(`${API}/products/${product}/retire`)
        .set('Cookie', admin)
        .send({ reason: 'No longer stocked' })
        .expect(409);
      expect(refused.body.detail).toContain('on the shelf');
    });

    it('lets it go once the shelf is empty', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'P-1', expiry: inYears(2), quantity: 2 }]);
      const [batch] = await batchesOf(product);
      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 2, reasonCode: 'lost' })
        .expect(200);

      await request(harness.server)
        .post(`${API}/products/${product}/retire`)
        .set('Cookie', admin)
        .send({ reason: 'No longer stocked' })
        .expect(200);
    });
  });

  // --------------------------------------------------- reconciliation

  describe('Reconciliation (INV-F-21, INV-R-10)', () => {
    it('balances when nothing is wrong', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'Q-1', expiry: inYears(2), quantity: 30 }]);

      const run = await request(harness.server)
        .post(`${API}/admin/stock-reconciliation`)
        .set('Cookie', admin)
        .expect(200);
      expect(run.body.mismatches).toEqual([]);
      expect(run.body.summary).toContain('every one balanced');
    });

    it('notices a quantity changed behind the ledger, and corrects nothing', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'R-1', expiry: inYears(2), quantity: 30 }]);
      const [batch] = await batchesOf(product);

      // Exactly what the job exists to catch: a write that did not go
      // through the ledger.
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.productBatch.update({ where: { id: batch!.id }, data: { quantityOnHand: 12 } }),
      );

      const job = harness.app.get(StockReconciliationJob);
      const result = await harness.db.withTenant(fx.tenantId, (tx) => job.verify(tx));

      const found = result.mismatches.find((m) => m.batchId === batch!.id);
      expect(found).toMatchObject({ cached: 12, ledger: 30, difference: -18 });

      // And it did not put it back.
      expect((await batchesOf(product))[0]?.quantityOnHand).toBe(12);
    });
  });

  describe('Who may do what', () => {
    it('a doctor can look but not receive or adjust', async () => {
      const product = await addProduct();
      await request(harness.server)
        .get(`${API}/branches/${branch}/stock`)
        .set('Cookie', doctor)
        .expect(200);
      await stockIn(
        [{ productId: product, batchNo: 'S-1', expiry: inYears(2), quantity: 1 }],
        doctor,
        403,
      );
    });

    it('a branch the caller does not work at is not found', async () => {
      await request(harness.server)
        .get(`${API}/branches/${fx.branchBId}/stock`)
        .set('Cookie', doctor)
        .expect(404);
    });
  });
});
