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

  async function onHandOf(productId: string): Promise<number> {
    return (await batchesOf(productId))
      .filter((b) => b.status === 'ACTIVE')
      .reduce((sum, b) => sum + b.quantityOnHand, 0);
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

    it('TEN-F-07: a branch with stock on its shelves cannot be closed', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'BR-1', expiry: inYears(2), quantity: 4 }]);

      const refused = await request(harness.server)
        .post(`${API}/branches/${branch}/deactivate`)
        .set('Cookie', admin)
        .send({ reason: 'Closing this branch' })
        .expect(422);
      expect(refused.body.detail).toContain('batches of stock on the shelves');
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

  // ---------------------------------------------------- counts

  describe('Physical counts (INV-F-16, INV-T-08)', () => {
    it('INV-T-08: expected 30, counted 27 posts a COUNT_ADJUST of −3', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'CNT-1', expiry: inYears(2), quantity: 30 }]);
      const [batch] = await batchesOf(product);

      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(201);
      const countId = opened.body.count.id as string;
      const line = opened.body.lines.find((l: { batchId: string }) => l.batchId === batch!.id);
      expect(line.expected).toBe(30);

      await request(harness.server)
        .put(`${API}/counts/${countId}/lines`)
        .set('Cookie', admin)
        .send({ lines: [{ batchId: batch!.id, counted: 27, note: 'Three missing from the box' }] })
        .expect(200);

      const submitted = await request(harness.server)
        .post(`${API}/counts/${countId}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      expect(submitted.body.summary).toMatchObject({ under: 1, netUnits: -3 });

      await request(harness.server)
        .post(`${API}/counts/${countId}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);

      expect(await onHandOf(product)).toBe(27);

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=COUNT_ADJUST&productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      expect(movements.body.items).toHaveLength(1);
      expect(movements.body.items[0]).toMatchObject({
        quantity: -3,
        referenceType: 'stock_count',
        referenceId: countId,
      });
    });

    it('posts nothing for a line that agrees', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'CNT-2', expiry: inYears(2), quantity: 12 }]);
      const [batch] = await batchesOf(product);

      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(201);
      await request(harness.server)
        .put(`${API}/counts/${opened.body.count.id}/lines`)
        .set('Cookie', admin)
        .send({ lines: [{ batchId: batch!.id, counted: 12 }] })
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);

      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=COUNT_ADJUST&productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      // A movement of nothing is not a movement.
      expect(movements.body.items).toEqual([]);
    });

    it('records a batch found on the shelf that nobody had entered', async () => {
      const product = await addProduct();
      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'ADHOC', productIds: [product] })
        .expect(201);
      const countId = opened.body.count.id as string;

      await request(harness.server)
        .put(`${API}/counts/${countId}/lines`)
        .set('Cookie', admin)
        .send({
          lines: [
            {
              productId: product,
              newBatchNo: 'FOUND-1',
              newExpiry: inYears(2),
              newCost: 0.5,
              counted: 18,
              note: 'On the bottom shelf',
            },
          ],
        })
        .expect(200);

      await request(harness.server)
        .post(`${API}/counts/${countId}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${countId}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);

      const batches = await batchesOf(product);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ batchNo: 'FOUND-1', quantityOnHand: 18 });
    });

    it('INV §14: an opening count expects nothing and sets everything', async () => {
      const product = await addProduct();
      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'OPENING' })
        .expect(201);
      // Nothing is frozen, because the system has no opinion yet.
      expect(opened.body.lines).toEqual([]);

      await request(harness.server)
        .put(`${API}/counts/${opened.body.count.id}/lines`)
        .set('Cookie', admin)
        .send({
          lines: [
            { productId: product, newBatchNo: 'OPEN-1', newExpiry: inYears(2), counted: 100 },
          ],
        })
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);

      expect(await onHandOf(product)).toBe(100);
      const movements = await request(harness.server)
        .get(`${API}/branches/${branch}/movements?type=OPENING&productId=${product}`)
        .set('Cookie', admin)
        .expect(200);
      expect(movements.body.items[0]).toMatchObject({ quantity: 100 });
    });

    it('will not submit with a line left blank, because a blank is not a zero', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'CNT-3', expiry: inYears(2), quantity: 5 }]);
      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(201);

      const refused = await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(409);
      expect(refused.body.detail).toContain('blank is not a zero');

      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/cancel`)
        .set('Cookie', admin)
        .send({ reason: 'Test fixture: releasing the branch' })
        .expect(200);
    });

    it('allows only one count at a time per branch', async () => {
      const product = await addProduct();
      const first = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(201);
      const second = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(409);
      expect(second.body.detail).toContain('already open');

      // Leave the branch countable for the tests after this one — which
      // is the same tidiness the rule itself is asking for.
      await request(harness.server)
        .post(`${API}/counts/${first.body.count.id}/cancel`)
        .set('Cookie', admin)
        .send({ reason: 'Test fixture: releasing the branch' })
        .expect(200);
    });

    it('hides the expected quantity during a blind count', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'CNT-4', expiry: inYears(2), quantity: 42 }]);
      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product], blind: true })
        .expect(201);

      expect(opened.body.lines[0].expected).toBeNull();
      expect(opened.body.summary).toBeNull();

      await request(harness.server)
        .put(`${API}/counts/${opened.body.count.id}/lines`)
        .set('Cookie', admin)
        .send({ lines: [{ batchId: opened.body.lines[0].batchId, counted: 40 }] })
        .expect(200);

      // Once submitted, the variance is the point.
      const submitted = await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      expect(submitted.body.lines[0].expected).toBe(42);
      expect(submitted.body.lines[0].variance).toBe(-2);

      // A submitted count still holds the branch, so release it.
      await request(harness.server)
        .post(`${API}/counts/${opened.body.count.id}/cancel`)
        .set('Cookie', admin)
        .send({ reason: 'Test fixture: releasing the branch' })
        .expect(200);
    });

    it('an approved count cannot be edited, by the API or by SQL', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'CNT-5', expiry: inYears(2), quantity: 9 }]);
      const [batch] = await batchesOf(product);
      const opened = await request(harness.server)
        .post(`${API}/branches/${branch}/counts`)
        .set('Cookie', admin)
        .send({ type: 'CYCLE', productIds: [product] })
        .expect(201);
      const countId = opened.body.count.id as string;

      await request(harness.server)
        .put(`${API}/counts/${countId}/lines`)
        .set('Cookie', admin)
        .send({ lines: [{ batchId: batch!.id, counted: 8 }] })
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${countId}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${countId}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);

      await request(harness.server)
        .put(`${API}/counts/${countId}/lines`)
        .set('Cookie', admin)
        .send({ lines: [{ batchId: batch!.id, counted: 99 }] })
        .expect(409);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.stockCount.update({ where: { id: countId }, data: { notes: 'Tampered' } }),
        ),
      ).rejects.toThrow(/approved/);
    });
  });

  // ---------------------------------------------------- alerts

  describe('Alerts (INV-F-19, F-20, INV-T-11)', () => {
    async function withLevels(min: number, reorder: number) {
      const product = await addProduct();
      await request(harness.server)
        .put(`${API}/products/${product}/branches/${branch}`)
        .set('Cookie', admin)
        .send({ minStock: min, reorderLevel: reorder, reorderQty: 100 })
        .expect(200);
      return product;
    }

    it('INV-T-11: fires once on the way down, not on every movement', async () => {
      const product = await withLevels(5, 20);
      await stockIn([{ productId: product, batchNo: 'AL-1', expiry: inYears(2), quantity: 50 }]);
      const [batch] = await batchesOf(product);

      // Above the reorder level: nothing to say.
      let alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      expect(alerts.body.items.filter((a: { productId: string }) => a.productId === product)).toEqual([]);

      // Crossing it is news.
      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 35, reasonCode: 'lost' })
        .expect(200);

      alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      const low = alerts.body.items.find((a: { productId: string }) => a.productId === product);
      expect(low).toMatchObject({ kind: 'LOW', observed: 15 });
      const firstSeen = low.firstSeen;

      // Still low after another movement: the same alert, not a second.
      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 2, reasonCode: 'lost' })
        .expect(200);

      alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      const still = alerts.body.items.filter(
        (a: { productId: string; kind: string }) => a.productId === product && a.kind === 'LOW',
      );
      expect(still).toHaveLength(1);
      expect(still[0].firstSeen).toBe(firstSeen);
      expect(still[0].observed).toBe(13);
    });

    it('becomes critical below the minimum, and says so once', async () => {
      const product = await withLevels(5, 20);
      await stockIn([{ productId: product, batchNo: 'AL-2', expiry: inYears(2), quantity: 50 }]);
      const [batch] = await batchesOf(product);

      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'ADJUST_OUT', quantity: 46, reasonCode: 'lost' })
        .expect(200);

      const alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      const mine = alerts.body.items.filter((a: { productId: string }) => a.productId === product);
      // Critical supersedes low: saying both is saying it twice.
      expect(mine.map((a: { kind: string }) => a.kind)).toEqual(['CRITICAL']);
    });

    it('clears when the shelf is restocked, so a recurrence is news again', async () => {
      const product = await withLevels(5, 20);
      await stockIn([{ productId: product, batchNo: 'AL-3', expiry: inYears(2), quantity: 10 }]);

      let alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      expect(
        alerts.body.items.filter((a: { productId: string }) => a.productId === product).length,
      ).toBeGreaterThan(0);

      await stockIn([{ productId: product, batchNo: 'AL-3', expiry: inYears(2), quantity: 100 }]);

      alerts = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      expect(alerts.body.items.filter((a: { productId: string }) => a.productId === product)).toEqual([]);
    });

    it('can be acknowledged without pretending the shelf is full', async () => {
      const product = await withLevels(5, 20);
      await stockIn([{ productId: product, batchNo: 'AL-4', expiry: inYears(2), quantity: 8 }]);

      await request(harness.server)
        .post(`${API}/branches/${branch}/alerts/acknowledge`)
        .set('Cookie', admin)
        .send({ productId: product, kind: 'LOW' })
        .expect(200);

      const open = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts`)
        .set('Cookie', admin)
        .expect(200);
      expect(open.body.items.filter((a: { productId: string }) => a.productId === product)).toEqual([]);

      const all = await request(harness.server)
        .get(`${API}/branches/${branch}/alerts?includeAcknowledged=true`)
        .set('Cookie', admin)
        .expect(200);
      const mine = all.body.items.find((a: { productId: string }) => a.productId === product);
      expect(mine.acknowledgedAt).toBeTruthy();
    });
  });

  // ------------------------------------------- quarantine and reorder

  describe('Quarantine (INV-F-15) and reordering (INV-F-22)', () => {
    it('releases held stock back to the shelf, or out of the building', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'Q-1', expiry: inYears(2), quantity: 20 }]);
      const [batch] = await batchesOf(product);

      // Something was set aside. DSP does this on a patient return;
      // here it is planted directly.
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.productBatch.update({ where: { id: batch!.id }, data: { quantityQuarantined: 6 } }),
      );

      const held = await request(harness.server)
        .get(`${API}/branches/${branch}/quarantine`)
        .set('Cookie', admin)
        .expect(200);
      expect(held.body.items.find((i: { id: string }) => i.id === batch!.id).quantityQuarantined).toBe(6);

      const before = await onHandOf(product);
      await request(harness.server)
        .post(`${API}/branches/${branch}/quarantine/${batch!.id}/release`)
        .set('Cookie', admin)
        .send({ quantity: 2, to: 'STOCK', reason: 'Sealed and in date, checked by the pharmacist' })
        .expect(200);
      expect(await onHandOf(product)).toBe(before + 2);

      // Destroyed: it leaves quarantine and does not come back on the shelf.
      await request(harness.server)
        .post(`${API}/branches/${branch}/quarantine/${batch!.id}/release`)
        .set('Cookie', admin)
        .send({ quantity: 4, to: 'DAMAGE', reason: 'Blister pack punctured' })
        .expect(200);
      expect(await onHandOf(product)).toBe(before + 2);

      const empty = await request(harness.server)
        .get(`${API}/branches/${branch}/quarantine`)
        .set('Cookie', admin)
        .expect(200);
      expect(empty.body.items.find((i: { id: string }) => i.id === batch!.id)).toBeUndefined();
    });

    it('will not release more than is being held', async () => {
      const product = await addProduct();
      await stockIn([{ productId: product, batchNo: 'Q-2', expiry: inYears(2), quantity: 5 }]);
      const [batch] = await batchesOf(product);
      await request(harness.server)
        .post(`${API}/branches/${branch}/quarantine/${batch!.id}/release`)
        .set('Cookie', admin)
        .send({ quantity: 1, to: 'STOCK', reason: 'Nothing is being held' })
        .expect(400);
    });

    it('INV-F-22: works out days of cover from what actually left', async () => {
      const product = await addProduct();
      await request(harness.server)
        .put(`${API}/products/${product}/branches/${branch}`)
        .set('Cookie', admin)
        .send({ minStock: 5, reorderLevel: 40, reorderQty: 200 })
        .expect(200);
      await stockIn([{ productId: product, batchNo: 'R-1', expiry: inYears(2), quantity: 30 }]);

      const suggestions = await request(harness.server)
        .get(`${API}/branches/${branch}/reorder-suggestions`)
        .set('Cookie', admin)
        .expect(200);

      const mine = suggestions.body.items.find(
        (i: { product: { id: string } }) => i.product.id === product,
      );
      expect(mine).toMatchObject({ onHand: 30, belowReorder: true, suggestedQty: 200 });
      // Nothing has been dispensed, so there is no usage to divide by —
      // and saying "forever" would be a lie.
      expect(mine.daysOfCover).toBeNull();
    });
  });

  describe('Opening stock from a spreadsheet (INV-OPEN-02)', () => {
    function csv(lines: string[]): Buffer {
      return Buffer.from(['sku,batch_no,expiry,quantity,cost', ...lines].join('\n'), 'utf8');
    }

    async function skuOf(productId: string): Promise<string> {
      const response = await request(harness.server)
        .get(`${API}/products/${productId}`)
        .set('Cookie', admin)
        .expect(200);
      return response.body.product.sku as string;
    }

    it('reads a file, fills in a count, and waits to be approved', async () => {
      const product = await addProduct();
      const sku = await skuOf(product);

      const dry = await request(harness.server)
        .post(`${API}/branches/${branch}/counts/import`)
        .set('Cookie', admin)
        .attach('file', csv([`${sku},IMP-1,${inYears(2)},250,0.40`]), 'opening.csv')
        .expect(200);
      expect(dry.body).toMatchObject({ rows: 1, usable: 1, problems: [] });

      // Nothing was written.
      expect(await batchesOf(product)).toEqual([]);

      const applied = await request(harness.server)
        .post(`${API}/branches/${branch}/counts/import?dryRun=false`)
        .set('Cookie', admin)
        .attach('file', csv([`${sku},IMP-1,${inYears(2)},250,0.40`]), 'opening.csv')
        .expect(200);
      expect(applied.body.count.type).toBe('OPENING');
      expect(applied.body.lines).toHaveLength(1);
      expect(applied.body.lines[0].counted).toBe(250);

      // Still nothing on the shelf: a person approves it.
      expect(await onHandOf(product)).toBe(0);

      await request(harness.server)
        .post(`${API}/counts/${applied.body.count.id}/submit`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      await request(harness.server)
        .post(`${API}/counts/${applied.body.count.id}/approve`)
        .set('Cookie', admin)
        .send({})
        .expect(200);
      expect(await onHandOf(product)).toBe(250);
    });

    it('refuses the whole file rather than importing half of it', async () => {
      const product = await addProduct();
      const sku = await skuOf(product);

      const refused = await request(harness.server)
        .post(`${API}/branches/${branch}/counts/import?dryRun=false`)
        .set('Cookie', admin)
        .attach(
          'file',
          csv([`${sku},IMP-2,${inYears(2)},10,0.40`, 'NOSUCHSKU,X,2030-01-01,5,1.00']),
          'opening.csv',
        )
        .expect(400);
      expect(refused.body.detail).toContain('cannot be told from a complete one');
      expect(await batchesOf(product)).toEqual([]);
    });

    it('names every problem before writing anything', async () => {
      const product = await addProduct();
      const sku = await skuOf(product);

      const dry = await request(harness.server)
        .post(`${API}/branches/${branch}/counts/import`)
        .set('Cookie', admin)
        .attach(
          'file',
          csv([
            `${sku},,${inYears(2)},10,`,
            `${sku},IMP-3,,10,`,
            `${sku},IMP-4,${inYears(2)},notanumber,`,
            `${sku},IMP-5,${inYears(2)},5,`,
            `${sku},IMP-5,${inYears(2)},5,`,
          ]),
          'opening.csv',
        )
        .expect(200);

      const said = dry.body.problems.map((p: { problem: string }) => p.problem).join(' | ');
      expect(said).toContain('no batch number');
      expect(said).toContain('no usable expiry');
      expect(said).toContain('quantity is not a number');
      expect(said).toContain('appears twice');
      expect(dry.body.usable).toBe(1);
    });

    it('refuses a column nobody can do anything with', async () => {
      const bad = Buffer.from('sku,quantity,colour\nX,1,blue', 'utf8');
      const response = await request(harness.server)
        .post(`${API}/branches/${branch}/counts/import`)
        .set('Cookie', admin)
        .attach('file', bad, 'opening.csv')
        .expect(400);
      expect(response.body.detail).toContain('colour');
    });
  });

  describe('Large write-offs (INV-R-08, INV-T-09)', () => {
    it('INV-T-09: writing off real money asks for the password again', async () => {
      const product = await addProduct();
      // 2,000 at RM 1.00 cost is RM 2,000, well over the RM 500 default.
      await stockIn([
        { productId: product, batchNo: 'BIG-1', expiry: inYears(2), quantity: 2000, costPrice: 1 },
      ]);
      const [batch] = await batchesOf(product);

      // Confirming MFA at sign-in counts as proving identity, so this
      // session is currently fresh. Age it, the way an afternoon would.
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.session.updateMany({
          where: { userId: fx.admin.id },
          data: { reauthAt: new Date(Date.now() - 24 * 3600 * 1000) },
        }),
      );

      const refused = await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'DAMAGE', quantity: 1000, reasonCode: 'damaged' })
        .expect(403);
      expect(refused.body.code).toBe('reauth_required');
      expect(refused.body.detail).toContain('1000.00');

      // Nothing moved.
      expect(await onHandOf(product)).toBe(2000);

      // A small one goes through untouched: most adjustments are a box
      // of gauze and should not ask.
      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'DAMAGE', quantity: 10, reasonCode: 'damaged' })
        .expect(200);
      expect(await onHandOf(product)).toBe(1990);
    });

    it('lets it through once the password has been given again', async () => {
      const product = await addProduct();
      await stockIn([
        { productId: product, batchNo: 'BIG-2', expiry: inYears(2), quantity: 2000, costPrice: 1 },
      ]);
      const [batch] = await batchesOf(product);

      // The reauth endpoint is what the elevation dialogue calls.
      await request(harness.server)
        .post(`${API}/auth/reauth`)
        .set('Cookie', admin)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      await request(harness.server)
        .post(`${API}/branches/${branch}/adjustments`)
        .set('Cookie', admin)
        .send({ batchId: batch!.id, type: 'DAMAGE', quantity: 1000, reasonCode: 'damaged' })
        .expect(200);
      expect(await onHandOf(product)).toBe(1000);
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
