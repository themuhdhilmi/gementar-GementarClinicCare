import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { TenantStatus } from '../src/generated/prisma/enums.js';
import { BranchDeactivationRegistry } from '../src/modules/tenancy/branch-deactivation.registry.js';
import { DEFAULT_SETTINGS } from '../src/modules/tenancy/settings/tenant-settings.js';

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

/** An administrator must clear MFA before the administrative API answers. */
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
 * TEN — tenancy and branches, against the real database with row-level
 * security in force.
 *
 * Tenant isolation itself is proved in `tenant-isolation.e2e-spec.ts`
 * (TEN-T-01 … T-08). This covers what the module adds on top: the settings
 * document, how three layers of it resolve, and the branch lifecycle.
 */
describe('TEN — tenancy and branches', () => {
  const harness = new Harness();
  let fx: Fixture;
  let adminCookie: string;
  let doctorCookie: string;

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('tenancy');
    adminCookie = await signInAdmin(harness, fx.admin.email);
    doctorCookie = await signIn(harness, fx.doctor.email);
  }, 60_000);

  afterAll(async () => {
    await harness.stop();
  });

  describe('Settings (TEN-F-04, TEN-F-09)', () => {
    it('serves the schema and its defaults alongside the resolved values', async () => {
      const response = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', adminCookie)
        .expect(200);

      expect(response.body.settings).toEqual(DEFAULT_SETTINGS);
      expect(response.body.schema.version).toBe(1);
      // The screen builds itself from this, so every field must describe
      // itself to whoever runs the clinic.
      expect(response.body.schema.fields.length).toBeGreaterThan(0);
      for (const field of response.body.schema.fields) {
        expect(field.help, `${field.group}.${field.key} has no help text`).toBeTruthy();
        expect(field.default, `${field.group}.${field.key} has no default`).toBeDefined();
      }
    });

    it('resolves branch over tenant over default, one setting at a time', async () => {
      // The clinic allows 25%.
      await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 25 } } })
        .expect(200);

      // This branch allows 5%, and says nothing about rounding.
      const patched = await request(harness.server)
        .patch(`${API}/branches/${fx.branchAId}/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 5 } } })
        .expect(200);

      expect(patched.body.settings.billing.maxDiscountPctFrontdesk).toBe(5);
      // Untouched at both levels, so still the default.
      expect(patched.body.settings.billing.roundCashTo5Sen).toBe(true);
      expect(patched.body.settings.queue.resetDaily).toBe(true);

      // Branch B expressed no opinion, so it gets the clinic's 25%.
      const branchB = await request(harness.server)
        .get(`${API}/branches/${fx.branchBId}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(branchB.body.settings).toEqual({});
    });

    it('stores only the difference, so a changed default still reaches the clinic', async () => {
      const detail = await request(harness.server)
        .get(`${API}/branches/${fx.branchAId}`)
        .set('Cookie', adminCookie)
        .expect(200);

      // Only the one overridden key is written down, not the whole document.
      expect(detail.body.settings).toEqual({ billing: { maxDiscountPctFrontdesk: 5 } });
    });

    it('TEN-T-10: an invalid settings key is refused with 422 that names it', async () => {
      const response = await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 10, nonsense: true } } })
        .expect(422);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body.code).toBe('settings_invalid');
      expect(response.body.detail).toContain('billing.nonsense');

      // Refused whole: the valid half of the patch was not applied either.
      const after = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(after.body.settings.billing.maxDiscountPctFrontdesk).toBe(5);
    });

    it('refuses an unknown group, and a value of the wrong kind', async () => {
      const unknownGroup = await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { astrology: { risingSign: 'Leo' } } })
        .expect(422);
      expect(unknownGroup.body.detail).toContain('astrology');

      const wrongType = await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 'lots' } } })
        .expect(422);
      expect(wrongType.body.detail).toContain('billing.maxDiscountPctFrontdesk');

      const outOfRange = await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 400 } } })
        .expect(422);
      expect(outOfRange.body.detail).toContain('billing.maxDiscountPctFrontdesk');
    });

    it('clears an override with null, so the branch follows the clinic again', async () => {
      // Branch A overrides the discount at 5 while the clinic allows 25.
      const cleared = await request(harness.server)
        .patch(`${API}/branches/${fx.branchAId}/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: null } } })
        .expect(200);
      expect(cleared.body.settings.billing.maxDiscountPctFrontdesk).toBe(25);

      // Nothing is left written down, so a later change to the clinic lands.
      const detail = await request(harness.server)
        .get(`${API}/branches/${fx.branchAId}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(detail.body.settings).toEqual({});

      await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', adminCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 5 } } })
        .expect(200);
      const followed = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(followed.body.settings.billing.maxDiscountPctFrontdesk).toBe(5);
    });

    it('only an administrator may change them', async () => {
      await request(harness.server)
        .patch(`${API}/tenant/settings`)
        .set('Cookie', doctorCookie)
        .send({ settings: { billing: { maxDiscountPctFrontdesk: 100 } } })
        .expect(403);
    });
  });

  describe('Branches (TEN-F-06, TEN-F-07, TEN-R-08)', () => {
    let createdId: string;

    it('creates one, and refuses a duplicate code', async () => {
      const created = await request(harness.server)
        .post(`${API}/branches`)
        .set('Cookie', adminCookie)
        .send({
          code: 'kl03',
          name: 'Cawangan Ampang',
          addressLine1: '12 Jalan Ampang',
          city: 'Kuala Lumpur',
          postcode: '50450',
          phone: '03-1234 5678',
          // Open, closed for lunch, open again; shut on Sunday.
          operatingHours: { mon: [['09:00', '13:00'], ['14:00', '18:00']], sun: [] },
        })
        .expect(201);

      createdId = created.body.id;
      expect(created.body.operatingHours).toEqual({
        mon: [['09:00', '13:00'], ['14:00', '18:00']],
      });
      // Lower case in, canonical out: the code goes into document numbers.
      expect(created.body.code).toBe('KL03');
      expect(created.body.status).toBe('ACTIVE');

      const clash = await request(harness.server)
        .post(`${API}/branches`)
        .set('Cookie', adminCookie)
        .send({ code: 'KL03', name: 'Another one' })
        .expect(409);
      expect(clash.body.code).toBe('branch_code_taken');
    });

    it('rejects a malformed code, postcode and opening hours (§12)', async () => {
      const reject = async (body: Record<string, unknown>, expected: string) => {
        const response = await request(harness.server)
          .post(`${API}/branches`)
          .set('Cookie', adminCookie)
          .send({ code: 'ZZ9', name: 'Temp', ...body })
          .expect(400);
        expect(response.body.code, JSON.stringify(response.body)).toBe(expected);
        // The message has to be usable by whoever is typing it in.
        expect(response.body.detail.length).toBeGreaterThan(20);
      };

      await reject({ code: 'KL-03' }, 'invalid_branch_code');
      await reject({ postcode: '5045' }, 'invalid_postcode');
      await reject({ operatingHours: { funday: [] } }, 'invalid_operating_hours');
      await reject({ operatingHours: { mon: ['09:00'] } }, 'invalid_operating_hours');
      await reject({ operatingHours: { mon: [['18:00', '09:00']] } }, 'invalid_operating_hours');
      // Two ranges that overlap: the afternoon starts before lunch ends.
      await reject(
        { operatingHours: { mon: [['09:00', '13:00'], ['12:00', '18:00']] } },
        'invalid_operating_hours',
      );

      // Nothing was created by any of them.
      const all = await request(harness.server)
        .get(`${API}/branches/all`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(all.body.items.some((b: { code: string }) => b.code === 'ZZ9')).toBe(false);
    });

    it('TEN-R-08: the code cannot be changed, but everything else can', async () => {
      const refused = await request(harness.server)
        .patch(`${API}/branches/${createdId}`)
        .set('Cookie', adminCookie)
        .send({ code: 'KL99' })
        .expect(422);
      expect(refused.body.code).toBe('branch_code_immutable');

      const updated = await request(harness.server)
        .patch(`${API}/branches/${createdId}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Cawangan Ampang Point', phone: '03-9999 0000' })
        .expect(200);
      expect(updated.body.name).toBe('Cawangan Ampang Point');
      expect(updated.body.code).toBe('KL03');

      // Sending the code back unchanged is not an attempt to change it.
      await request(harness.server)
        .patch(`${API}/branches/${createdId}`)
        .set('Cookie', adminCookie)
        .send({ code: 'KL03', name: 'Cawangan Ampang Point' })
        .expect(200);
    });

    it('TEN-F-16: you see the branches you hold a role at, not all of them', async () => {
      const mine = await request(harness.server)
        .get(`${API}/branches`)
        .set('Cookie', doctorCookie)
        .expect(200);
      expect(mine.body.items.map((b: { id: string }) => b.id)).toEqual([fx.branchAId]);

      // And cannot read one where they have no role.
      await request(harness.server)
        .get(`${API}/branches/${fx.branchBId}`)
        .set('Cookie', doctorCookie)
        .expect(403);

      // An administrator sees every branch in the clinic.
      const all = await request(harness.server)
        .get(`${API}/branches/all`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(all.body.items.length).toBeGreaterThanOrEqual(3);

      await request(harness.server)
        .get(`${API}/branches/all`)
        .set('Cookie', doctorCookie)
        .expect(403);
    });

    it('deactivates and reactivates when nothing is open there', async () => {
      const off = await request(harness.server)
        .post(`${API}/branches/${createdId}/deactivate`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Lease ended' })
        .expect(200);
      expect(off.body.status).toBe('INACTIVE');

      // Deactivating twice is the same as deactivating once.
      await request(harness.server)
        .post(`${API}/branches/${createdId}/deactivate`)
        .set('Cookie', adminCookie)
        .send({})
        .expect(200);

      const on = await request(harness.server)
        .post(`${API}/branches/${createdId}/activate`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(on.body.status).toBe('ACTIVE');
    });

    it('TEN-T-09: deactivation is refused while work is open, and says how much', async () => {
      // ENC and INV do not exist yet, so the check they will register is
      // registered here instead. What is under test is the guard, not the
      // counting: see the registry for how a module plugs into it.
      const registry = harness.app.get(BranchDeactivationRegistry);
      registry.add('open encounters', async (_tx, branchId) =>
        branchId === createdId ? { reason: 'open encounters', count: 3 } : null,
      );
      registry.add('batches in stock', async (_tx, branchId) =>
        branchId === createdId ? { reason: 'batches in stock', count: 12 } : null,
      );

      try {
        const refused = await request(harness.server)
          .post(`${API}/branches/${createdId}/deactivate`)
          .set('Cookie', adminCookie)
          .send({})
          .expect(422);

        expect(refused.body.code).toBe('branch_in_use');
        expect(refused.body.detail).toContain('3 open encounters');
        expect(refused.body.detail).toContain('12 batches in stock');

        const still = await request(harness.server)
          .get(`${API}/branches/${createdId}`)
          .set('Cookie', adminCookie)
          .expect(200);
        expect(still.body.status).toBe('ACTIVE');
      } finally {
        registry.remove('open encounters');
        registry.remove('batches in stock');
      }
    });

    it('a branch of another tenant is not found rather than forbidden', async () => {
      const other = await harness.seedTenant('tenancy-other');
      await request(harness.server)
        .get(`${API}/branches/${other.branchAId}`)
        .set('Cookie', adminCookie)
        .expect(404);
    });
  });

  describe('Letterhead (TEN-F-10)', () => {
    // A one-pixel PNG, which is enough to prove the bytes make the round trip.
    const PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    it('keeps header and footer text independently', async () => {
      const first = await request(harness.server)
        .patch(`${API}/branches/${fx.branchAId}/letterhead`)
        .set('Cookie', adminCookie)
        .send({ headerText: 'Klinik Pilot Sdn Bhd (202601012345)' })
        .expect(200);
      expect(first.body.letterhead.headerText).toContain('202601012345');

      // Setting only the footer must not wipe the header.
      const second = await request(harness.server)
        .patch(`${API}/branches/${fx.branchAId}/letterhead`)
        .set('Cookie', adminCookie)
        .send({ footerText: 'Terima kasih' })
        .expect(200);
      expect(second.body.letterhead.headerText).toContain('202601012345');
      expect(second.body.letterhead.footerText).toBe('Terima kasih');
    });

    it('accepts a real image, serves it back, and removes it', async () => {
      expect(
        (await request(harness.server)
          .get(`${API}/branches/${fx.branchAId}`)
          .set('Cookie', adminCookie)
          .expect(200)).body.hasLogo,
      ).toBe(false);

      const uploaded = await request(harness.server)
        .put(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .attach('logo', PNG, { filename: 'logo.png', contentType: 'image/png' })
        .expect(200);
      expect(uploaded.body.hasLogo).toBe(true);

      const fetched = await request(harness.server)
        .get(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(fetched.headers['content-type']).toContain('image/png');
      expect(Buffer.from(fetched.body).equals(PNG)).toBe(true);
      // An uploaded file is served back to other people's browsers.
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(fetched.headers['content-security-policy']).toContain('sandbox');

      await request(harness.server)
        .delete(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .expect(200);
      await request(harness.server)
        .get(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .expect(404);
    });

    it('judges the file by its bytes, not by what the browser claims', async () => {
      const refused = await request(harness.server)
        .put(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .attach('logo', Buffer.from('<?php echo "hello"; ?>'), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(refused.body.code).toBe('letterhead_wrong_type');
    });

    it('stops an image too large to print, and says what the limit is', async () => {
      const huge = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)]);
      const refused = await request(harness.server)
        .put(`${API}/branches/${fx.branchAId}/letterhead/logo`)
        .set('Cookie', adminCookie)
        .attach('logo', huge, { filename: 'logo.png', contentType: 'image/png' })
        .expect(413);
      expect(refused.body.code).toBe('file_too_large');
      expect(refused.body.detail).toContain('512 KB');
    });

    it('only an administrator may change it', async () => {
      await request(harness.server)
        .patch(`${API}/branches/${fx.branchAId}/letterhead`)
        .set('Cookie', doctorCookie)
        .send({ headerText: 'mine now' })
        .expect(403);
    });
  });

  describe('Module flags (TEN-F-05)', () => {
    it('reports every flag off, and describes what each one is', async () => {
      const response = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', adminCookie)
        .expect(200);

      expect(Object.values(response.body.modules).every((on) => on === false)).toBe(true);
      expect(response.body.schema.modules.length).toBe(
        Object.keys(response.body.modules).length,
      );
    });

    it('shows a flag switched on in the column', async () => {
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.tenant.update({
          where: { id: fx.tenantId },
          data: { modules: { appointments: true } },
        }),
      );

      const response = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect(response.body.modules.appointments).toBe(true);
      // Unmentioned flags are still off, not missing.
      expect(response.body.modules.loyalty).toBe(false);
    });
  });

  describe('Tenant suspension (TEN-F-03)', () => {
    it('refuses every call with 403 and a message that explains itself', async () => {
      const victim = await harness.seedTenant('suspended');
      const cookie = await signIn(harness, victim.doctor.email);

      // Works while the clinic is active.
      await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', cookie)
        .expect(200);

      await harness.db.withPlatform('suspend for the test', (tx) =>
        tx.tenant.update({
          where: { id: victim.tenantId },
          data: { status: TenantStatus.SUSPENDED },
        }),
      );

      const refused = await request(harness.server)
        .get(`${API}/tenant`)
        .set('Cookie', cookie)
        .expect(403);
      expect(refused.body.code).toBe('tenant_suspended');
      expect(refused.body.detail).toContain('suspended');
      // It must not read as "sign in again", because signing in will not help.
      expect(refused.body.detail).not.toContain('sign in');

      // And logging in afresh is refused too.
      await request(harness.server)
        .post(`${API}/auth/login`)
        .send({ email: victim.doctor.email, password: DEFAULT_PASSWORD })
        .expect(401);

      // The data is retained, not deleted.
      const rows = await harness.db.withTenant(victim.tenantId, (tx) => tx.user.count());
      expect(rows).toBeGreaterThan(0);
    });
  });
});
