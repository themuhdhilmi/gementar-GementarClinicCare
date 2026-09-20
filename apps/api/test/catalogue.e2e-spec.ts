import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';

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

describe('INV — the product catalogue', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;

  let seq = 0;
  function medicine(overrides: Record<string, unknown> = {}) {
    seq += 1;
    return {
      name: `Amoxicillin ${seq}`,
      type: 'MEDICINE',
      genericName: 'Amoxicillin',
      drugClass: 'Penicillins',
      form: 'cap',
      strengthText: '500 mg',
      dispenseUnit: 'cap',
      sellingPrice: 0.45,
      ...overrides,
    };
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('catalogue');
    [doctor, reception] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  });

  describe('Creating a product (INV-F-01)', () => {
    it('gives it a code and stores the price in sen', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sellingPrice: 12.5 }))
        .expect(201);

      expect(created.body.sku).toMatch(/^MED-\d{4}$/);
      expect(created.body.sellingPrice).toBe('12.50');
      expect(created.body.sellingPriceSen).toBe(1250);
      expect(created.body.label).toContain('500 mg');

      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.product.findFirst({ where: { id: created.body.id } }),
      );
      // Integer money underneath, always.
      expect(row?.sellingPrice).toBe(1250n);
    });

    it('refuses a medicine without a generic name, and says why', async () => {
      const refused = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ genericName: undefined }))
        .expect(400);
      expect(refused.body.code).toBe('generic_name_required');
      // The reason is the whole point of building this before prescribing.
      expect(refused.body.detail).toContain('penicillin');
    });

    it('the database refuses one too, whatever writes the row', async () => {
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO product (id, tenant_id, sku, name, type, dispense_unit, created_at, updated_at)
             VALUES (gen_random_uuid(), $1::uuid, 'RAW-1', 'Sneaky', 'MEDICINE', 'tab', now(), now())`,
            fx.tenantId,
          ),
        ),
      ).rejects.toThrow(/product_medicine_has_generic/);
    });

    it('allows a consumable with no generic name', async () => {
      await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send({
          name: 'Surgical gloves, medium',
          type: 'CONSUMABLE',
          dispenseUnit: 'pcs',
          packSize: 100,
          sellingPrice: 0,
        })
        .expect(201);
    });

    it('refuses a unit nothing is handed over in', async () => {
      const refused = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ dispenseUnit: 'handful' }))
        .expect(400);
      expect(refused.body.detail).toContain('tab');
    });

    it('refuses a duplicate code', async () => {
      await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sku: 'PARA-500' }))
        .expect(201);
      const clash = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sku: 'PARA-500' }))
        .expect(409);
      expect(clash.body.code).toBe('sku_taken');
    });

    it('only an administrator maintains the catalogue', async () => {
      await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', doctor)
        .send(medicine())
        .expect(403);
      // Everybody who touches a patient can look one up, though.
      await request(harness.server).get(`${API}/products`).set('Cookie', doctor).query({ q: 'amox' }).expect(200);
      await request(harness.server).get(`${API}/products`).set('Cookie', reception).query({ q: 'amox' }).expect(200);
    });
  });

  describe('Finding one (INV-F-06)', () => {
    beforeAll(async () => {
      await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send({
          name: 'Augmentin',
          type: 'MEDICINE',
          brand: 'GSK',
          genericName: 'Amoxicillin/Clavulanate',
          drugClass: 'Penicillins',
          strengthText: '625 mg',
          dispenseUnit: 'tab',
          sellingPrice: 2.2,
          barcodes: ['9551234567890'],
        })
        .expect(201);
    });

    const find = async (q: string, cookie = doctor) =>
      (
        await request(harness.server)
          .get(`${API}/products`)
          .set('Cookie', cookie)
          .query({ q })
          .expect(200)
      ).body.items as Array<{ name: string; genericName: string | null }>;

    it('finds a brand by its generic, and a generic by its brand', async () => {
      expect((await find('augmentin')).map((p) => p.name)).toContain('Augmentin');
      // The point: somebody typing the generic finds the brand on the shelf.
      expect((await find('clavulanate')).map((p) => p.name)).toContain('Augmentin');
      expect((await find('amoxicillin')).length).toBeGreaterThan(1);
    });

    it('finds a partial word, as a dispenser would type it', async () => {
      expect((await find('augm')).map((p) => p.name)).toContain('Augmentin');
      expect((await find('amox')).length).toBeGreaterThan(0);
    });

    it('finds one by its barcode, exactly', async () => {
      const hits = await find('9551234567890');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.name).toBe('Augmentin');
    });

    it('says nothing for one letter', async () => {
      expect(await find('a')).toEqual([]);
    });

    it('leaves out retired products unless asked', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ name: 'Discontinued Syrup', genericName: 'Nothing' }))
        .expect(201);

      await request(harness.server)
        .post(`${API}/products/${created.body.id}/retire`)
        .set('Cookie', admin)
        .send({ reason: 'No longer stocked' })
        .expect(200);

      expect((await find('discontinued')).length).toBe(0);
      const withRetired = await request(harness.server)
        .get(`${API}/products`)
        .set('Cookie', admin)
        .query({ q: 'discontinued', includeInactive: 'true' })
        .expect(200);
      expect(withRetired.body.items.length).toBe(1);
    });
  });

  describe('Changing one (INV-F-02, INV-F-05)', () => {
    it('keeps every price it has ever had, and who set it', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sellingPrice: 1 }))
        .expect(201);

      await request(harness.server)
        .patch(`${API}/products/${created.body.id}`)
        .set('Cookie', admin)
        .send({ sellingPrice: 1.35, priceReason: 'Supplier increase, March' })
        .expect(200);

      const detail = await request(harness.server)
        .get(`${API}/products/${created.body.id}`)
        .set('Cookie', admin)
        .expect(200);

      expect(detail.body.product.sellingPrice).toBe('1.35');
      expect(detail.body.priceHistory).toHaveLength(2);
      expect(detail.body.priceHistory[0].sellingPrice).toBe('1.35');
      expect(detail.body.priceHistory[0].reason).toContain('Supplier increase');
      expect(detail.body.priceHistory[0].setBy).toBe(fx.admin.id);
    });

    it('the price history cannot be tidied away', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sellingPrice: 3 }))
        .expect(201);
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM product_price_history WHERE product_id = $1::uuid`,
            created.body.id,
          ),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses a price with more precision than money has', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine())
        .expect(201);
      const refused = await request(harness.server)
        .patch(`${API}/products/${created.body.id}`)
        .set('Cookie', admin)
        .send({ sellingPrice: 1.2345 })
        .expect(400);
      expect(refused.body.detail).toContain('two decimal places');
    });

    it('will not move the code, because invoices name it', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine({ sku: 'FIXED-1' }))
        .expect(201);
      const updated = await request(harness.server)
        .patch(`${API}/products/${created.body.id}`)
        .set('Cookie', admin)
        .send({ sku: 'MOVED-1', name: 'Renamed' })
        .expect(200);
      expect(updated.body.sku).toBe('FIXED-1');
      expect(updated.body.name).toBe('Renamed');
    });

    it('retires and reinstates rather than deleting', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine())
        .expect(201);

      const retired = await request(harness.server)
        .post(`${API}/products/${created.body.id}/retire`)
        .set('Cookie', admin)
        .send({ reason: 'Replaced by a different strength' })
        .expect(200);
      expect(retired.body.status).toBe('INACTIVE');

      // Still there, because prescriptions and invoices name it.
      await request(harness.server)
        .get(`${API}/products/${created.body.id}`)
        .set('Cookie', admin)
        .expect(200);

      const back = await request(harness.server)
        .post(`${API}/products/${created.body.id}/reinstate`)
        .set('Cookie', admin)
        .expect(200);
      expect(back.body.status).toBe('ACTIVE');
    });
  });

  describe('Categories and branch levels', () => {
    it('goes two levels deep and no further', async () => {
      const top = await request(harness.server)
        .post(`${API}/product-categories`)
        .set('Cookie', admin)
        .send({ name: 'Medicines' })
        .expect(201);
      const parentId = top.body.items.find((c: { name: string }) => c.name === 'Medicines').id;

      const second = await request(harness.server)
        .post(`${API}/product-categories`)
        .set('Cookie', admin)
        .send({ name: 'Antibiotics', parentId })
        .expect(201);
      const childId = second.body.items.find((c: { name: string }) => c.name === 'Antibiotics').id;

      const refused = await request(harness.server)
        .post(`${API}/product-categories`)
        .set('Cookie', admin)
        .send({ name: 'Penicillins', parentId: childId })
        .expect(400);
      expect(refused.body.code).toBe('category_too_deep');
    });

    it('holds a reorder level per branch', async () => {
      const created = await request(harness.server)
        .post(`${API}/products`)
        .set('Cookie', admin)
        .send(medicine())
        .expect(201);

      const set = await request(harness.server)
        .put(`${API}/products/${created.body.id}/branches/${fx.branchAId}`)
        .set('Cookie', admin)
        .send({ minStock: 50, reorderLevel: 100, reorderQty: 500 })
        .expect(200);
      expect(set.body.items).toHaveLength(1);
      expect(Number(set.body.items[0].reorderLevel)).toBe(100);
    });
  });

  describe('Importing the clinic’s list (INV-F-04)', () => {
    const csv = [
      'sku,name,type,generic_name,drug_class,strength,dispense_unit,selling_price,is_controlled',
      'IMP-001,Panadol,MEDICINE,Paracetamol,Analgesics,500 mg,tab,0.20,n',
      'IMP-002,Ventolin Inhaler,MEDICINE,Salbutamol,Beta agonists,100 mcg,puff,18.50,n',
      'IMP-003,No Generic Here,MEDICINE,,,,tab,1.00,n',
      'IMP-001,Panadol again,MEDICINE,Paracetamol,Analgesics,500 mg,tab,0.20,n',
      'IMP-004,Gauze swabs,CONSUMABLE,,,,pcs,0.10,n',
    ].join('\n');

    it('a dry run reports every row and writes nothing', async () => {
      const before = await request(harness.server)
        .get(`${API}/products`)
        .set('Cookie', admin)
        .query({ q: 'panadol' })
        .expect(200);

      const report = await request(harness.server)
        .post(`${API}/products/import?dryRun=true`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'catalogue.csv', contentType: 'text/csv' })
        .expect(200);

      expect(report.body.dryRun).toBe(true);
      expect(report.body.rowCount).toBe(5);
      expect(report.body.imported).toBe(3);
      // The medicine with no generic name.
      expect(report.body.rejected).toBe(1);
      expect(
        report.body.verdicts.find((v: { row: number }) => v.row === 4).message,
      ).toContain('generic name');
      // The repeated code inside the file.
      expect(report.body.skipped).toBe(1);

      const after = await request(harness.server)
        .get(`${API}/products`)
        .set('Cookie', admin)
        .query({ q: 'panadol' })
        .expect(200);
      expect(after.body.items.length).toBe(before.body.items.length);
    });

    it('imports for real, and skips what is already there next time', async () => {
      const first = await request(harness.server)
        .post(`${API}/products/import?dryRun=false`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'catalogue.csv' })
        .expect(200);
      expect(first.body.imported).toBe(3);

      const again = await request(harness.server)
        .post(`${API}/products/import?dryRun=false`)
        .set('Cookie', admin)
        .attach('file', Buffer.from(csv), { filename: 'catalogue.csv' })
        .expect(200);
      expect(again.body.imported).toBe(0);
      expect(again.body.skipped).toBe(4);

      const found = await request(harness.server)
        .get(`${API}/products`)
        .set('Cookie', doctor)
        .query({ q: 'salbutamol' })
        .expect(200);
      expect(found.body.items[0].name).toBe('Ventolin Inhaler');
      expect(found.body.items[0].sellingPrice).toBe('18.50');
    });

    it('updates existing rows when asked to', async () => {
      const updated = await request(harness.server)
        .post(`${API}/products/import?dryRun=false&updateExisting=true`)
        .set('Cookie', admin)
        .attach(
          'file',
          Buffer.from(
            'sku,name,type,generic_name,dispense_unit,selling_price\nIMP-001,Panadol,MEDICINE,Paracetamol,tab,0.25',
          ),
          { filename: 'prices.csv' },
        )
        .expect(200);
      expect(updated.body.updated).toBe(1);

      const found = await request(harness.server)
        .get(`${API}/products`)
        .set('Cookie', admin)
        .query({ q: 'panadol' })
        .expect(200);
      expect(found.body.items[0].sellingPrice).toBe('0.25');
    });

    it('refuses a column nobody will read', async () => {
      const refused = await request(harness.server)
        .post(`${API}/products/import?dryRun=true`)
        .set('Cookie', admin)
        .attach('file', Buffer.from('name,type,dispense_unit,colour\nx,CONSUMABLE,pcs,blue'), {
          filename: 'x.csv',
        })
        .expect(400);
      expect(refused.body.detail).toContain('colour');
    });

    it('only an administrator imports', async () => {
      await request(harness.server)
        .post(`${API}/products/import?dryRun=true`)
        .set('Cookie', doctor)
        .attach('file', Buffer.from(csv), { filename: 'catalogue.csv' })
        .expect(403);
    });
  });
});
