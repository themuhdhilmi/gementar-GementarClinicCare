import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { Role, UserStatus } from '../src/generated/prisma/enums.js';

const API = '/api/v1';

/** Logs in and, when the account has MFA, completes it. Returns the cookie. */
async function signIn(harness: Harness, email: string, password = DEFAULT_PASSWORD) {
  const response = await request(harness.server)
    .post(`${API}/auth/login`)
    .send({ email, password })
    .expect(200);
  const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('cc_session='),
  )!;
  return { cookie, body: response.body };
}

/** An administrator must enrol in MFA before the admin API answers. */
async function signInAdmin(harness: Harness, email: string) {
  const { cookie } = await signIn(harness, email);
  const enrol = await request(harness.server)
    .post(`${API}/auth/me/mfa/enrol`)
    .set('Cookie', cookie)
    .expect(200);
  await request(harness.server)
    .post(`${API}/auth/me/mfa/confirm`)
    .set('Cookie', cookie)
    .send({ code: totpFor(enrol.body.secret) })
    .expect(200);
  return { cookie, secret: enrol.body.secret as string };
}

describe('IAM — administration and authorisation (against real MySQL)', () => {
  const harness = new Harness();
  let fx: Fixture;
  let adminCookie: string;

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('admin');
    ({ cookie: adminCookie } = await signInAdmin(harness, fx.admin.email));
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates a user with an invitation and enforces unique email per tenant', async () => {
    const email = `new-${Date.now()}@test.local`;
    const created = await request(harness.server)
      .post(`${API}/users`)
      .set('Cookie', adminCookie)
      .send({
        name: 'Nurse Nadia',
        email,
        phone: '012-3456789',
        roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
      })
      .expect(201);

    expect(created.body.user.status).toBe(UserStatus.INVITED);
    expect(created.body.user.phone).toBe('+60123456789');
    expect(created.body.invite.expiresAt).toBeDefined();

    const duplicate = await request(harness.server)
      .post(`${API}/users`)
      .set('Cookie', adminCookie)
      .send({ name: 'Someone Else', email, roles: [{ branchId: fx.branchAId, role: Role.NURSE }] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('email_taken');
  });

  it('IAM-T-05: disabling a user kills every live session at once', async () => {
    const victim = await harness.addUser(fx, {
      name: 'Departing Staff',
      roles: [{ branchId: fx.branchAId, role: Role.FRONTDESK }],
    });
    const one = await signIn(harness, victim.email);
    const two = await signIn(harness, victim.email);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', one.cookie).expect(200);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', two.cookie).expect(200);

    await request(harness.server)
      .post(`${API}/users/${victim.id}/disable`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Left the clinic' })
      .expect(200);

    await request(harness.server).get(`${API}/auth/me`).set('Cookie', one.cookie).expect(401);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', two.cookie).expect(401);

    const blocked = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: victim.email, password: DEFAULT_PASSWORD });
    expect(blocked.status).toBe(401);

    // Historical records keep their name: the row is still there (IAM-F-17).
    const still = await request(harness.server)
      .get(`${API}/users/${victim.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(still.body.name).toBe('Departing Staff');
    expect(still.body.status).toBe(UserStatus.DISABLED);

    // Re-enabling restores access (IAM-F-14).
    await request(harness.server)
      .post(`${API}/users/${victim.id}/enable`)
      .set('Cookie', adminCookie)
      .expect(200);
    await signIn(harness, victim.email);
  });

  it('IAM-T-07: FRONTDESK at a branch cannot write clinical data there', async () => {
    const frontdesk = await harness.addUser(fx, {
      name: 'Front Desk B',
      roles: [{ branchId: fx.branchBId, role: Role.FRONTDESK }],
    });
    const { cookie } = await signIn(harness, frontdesk.email);

    const write = await request(harness.server)
      .post(`${API}/clinical-probe/records/patient-1/notes`)
      .set('Cookie', cookie);
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('forbidden');

    const read = await request(harness.server)
      .get(`${API}/clinical-probe/records/patient-1`)
      .set('Cookie', cookie);
    expect(read.status).toBe(403);
  });

  it('IAM-T-11: an ADMIN reading clinical data is allowed and recorded as break-glass', async () => {
    const before = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'audit.break_glass' } }),
    );

    await request(harness.server)
      .get(`${API}/clinical-probe/records/patient-42`)
      .set('Cookie', adminCookie)
      .expect(200);

    const entries = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'audit.break_glass' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    expect(entries).toHaveLength(1);
    expect(before).toBe(0);
    expect(JSON.stringify(entries[0]!.after)).toContain('patient-42');

    // A doctor doing the same thing is routine, not break-glass.
    const { cookie: doctorCookie } = await signIn(harness, fx.doctor.email);
    await request(harness.server)
      .get(`${API}/clinical-probe/records/patient-43`)
      .set('Cookie', doctorCookie)
      .expect(200);

    const total = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'audit.break_glass' } }),
    );
    expect(total).toBe(1);

    const summary = await request(harness.server)
      .get(`${API}/audit/summary`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(summary.body.breakGlass.last24h).toBe(1);
  });

  it('IAM-R-03: a mutating route with no declaration is refused at runtime', async () => {
    const response = await request(harness.server)
      .post(`${API}/clinical-probe/undeclared`)
      .set('Cookie', adminCookie);
    expect(response.status).toBe(403);
  });

  it('IAM-T-09: the last active ADMIN cannot drop their own ADMIN role or be disabled', async () => {
    const roleChange = await request(harness.server)
      .put(`${API}/users/${fx.admin.id}/roles`)
      .set('Cookie', adminCookie)
      .send({ roles: [{ branchId: fx.branchAId, role: Role.DOCTOR }] });
    expect(roleChange.status).toBe(422);
    expect(roleChange.body.code).toBe('last_admin');

    const selfDisable = await request(harness.server)
      .post(`${API}/users/${fx.admin.id}/disable`)
      .set('Cookie', adminCookie)
      .send({});
    expect(selfDisable.status).toBe(422);
    expect(selfDisable.body.code).toBe('cannot_disable_self');

    // With a second administrator in place, the change is allowed.
    const second = await harness.addUser(fx, {
      name: 'Second Admin',
      roles: [{ branchId: fx.branchAId, role: Role.ADMIN }],
    });
    const allowed = await request(harness.server)
      .put(`${API}/users/${second.id}/roles`)
      .set('Cookie', adminCookie)
      .send({ roles: [{ branchId: fx.branchAId, role: Role.NURSE }] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.roles).toEqual([{ branchId: fx.branchAId, role: Role.NURSE }]);
  });

  it('IAM-F-15 / IAM-R-04: a role change takes effect on the next request', async () => {
    const staff = await harness.addUser(fx, {
      name: 'Promoted Nurse',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    const { cookie } = await signIn(harness, staff.email);

    const before = await request(harness.server)
      .get(`${API}/auth/me`)
      .set('Cookie', cookie)
      .expect(200);
    expect(before.body.permissions).not.toContain('clinical.write');

    await request(harness.server)
      .put(`${API}/users/${staff.id}/roles`)
      .set('Cookie', adminCookie)
      .send({ roles: [{ branchId: fx.branchAId, role: Role.DOCTOR }] })
      .expect(200);

    const after = await request(harness.server)
      .get(`${API}/auth/me`)
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.roles).toEqual(['DOCTOR']);
    expect(after.body.permissions).toContain('clinical.write');
  });

  it('permissions resolve per active branch, and switching is validated server-side', async () => {
    const dual = await harness.addUser(fx, {
      name: 'Dual Role',
      roles: [
        { branchId: fx.branchAId, role: Role.ADMIN },
        { branchId: fx.branchBId, role: Role.FRONTDESK },
      ],
    });
    // MFA is mandatory because they hold ADMIN somewhere.
    const { cookie } = await signIn(harness, dual.email);
    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: totpFor(enrol.body.secret) })
      .expect(200);

    const atA = await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookie).expect(200);
    expect(atA.body.activeBranchId).toBe(fx.branchAId);
    expect(atA.body.permissions).toContain('admin.users');

    await request(harness.server)
      .put(`${API}/auth/me/branch`)
      .set('Cookie', cookie)
      .send({ branchId: fx.branchBId })
      .expect(200);

    const atB = await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookie).expect(200);
    expect(atB.body.activeBranchId).toBe(fx.branchBId);
    expect(atB.body.roles).toEqual(['FRONTDESK']);
    expect(atB.body.permissions).not.toContain('admin.users');

    await request(harness.server).get(`${API}/users`).set('Cookie', cookie).expect(403);

    // A branch they hold no role at is refused.
    const otherTenant = await harness.seedTenant('other-branch');
    const refused = await request(harness.server)
      .put(`${API}/auth/me/branch`)
      .set('Cookie', cookie)
      .send({ branchId: otherTenant.branchAId });
    expect(refused.status).toBe(403);
  });

  it('an administrator can force a password reset, revoke sessions and unlock an account', async () => {
    const staff = await harness.addUser(fx, {
      name: 'Needs Help',
      roles: [{ branchId: fx.branchAId, role: Role.FRONTDESK }],
    });
    const { cookie } = await signIn(harness, staff.email);

    const forced = await request(harness.server)
      .post(`${API}/users/${staff.id}/password/force-reset`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(forced.body.expiresAt).toBeDefined();
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookie).expect(401);

    const again = await signIn(harness, staff.email);
    const revoked = await request(harness.server)
      .post(`${API}/users/${staff.id}/sessions/revoke-all`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(revoked.body.revoked).toBeGreaterThanOrEqual(1);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', again.cookie).expect(401);

    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.user.update({
        where: { id: staff.id },
        data: {
          status: UserStatus.LOCKED,
          lockedUntil: new Date(Date.now() + 60_000),
          failedAttempts: 10,
        },
      }),
    );
    await request(harness.server)
      .post(`${API}/users/${staff.id}/unlock`)
      .set('Cookie', adminCookie)
      .expect(200);
    await signIn(harness, staff.email);
  });

  it('an administrator can reset a lost second factor', async () => {
    const staff = await harness.addUser(fx, {
      name: 'Lost Phone',
      roles: [{ branchId: fx.branchAId, role: Role.DOCTOR }],
    });
    const { cookie } = await signIn(harness, staff.email);
    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: totpFor(enrol.body.secret) })
      .expect(200);

    const withMfa = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: staff.email, password: DEFAULT_PASSWORD })
      .expect(200);
    expect(withMfa.body.mfaRequired).toBe(true);

    await request(harness.server)
      .post(`${API}/users/${staff.id}/mfa/reset`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Phone lost, identity verified in person' })
      .expect(204);

    const without = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: staff.email, password: DEFAULT_PASSWORD })
      .expect(200);
    expect(without.body.mfaRequired).toBe(false);

    const audited = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'user.mfa_reset', entityId: staff.id } }),
    );
    expect(audited).toBe(1);
  });

  it('filters the user list by status, branch, role and free text', async () => {
    const list = await request(harness.server)
      .get(`${API}/users`)
      .query({ role: Role.DOCTOR, branchId: fx.branchAId, pageSize: 50 })
      .set('Cookie', adminCookie)
      .expect(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    for (const user of list.body.items) {
      expect(user.roles.some((r: { role: string }) => r.role === Role.DOCTOR)).toBe(true);
    }

    const search = await request(harness.server)
      .get(`${API}/users`)
      .query({ q: 'Doctor Devi' })
      .set('Cookie', adminCookie)
      .expect(200);
    expect(search.body.items.map((u: { email: string }) => u.email)).toContain(fx.doctor.email);
  });

  it('a non-administrator cannot reach the admin API', async () => {
    const { cookie } = await signIn(harness, fx.frontdesk.email);
    await request(harness.server).get(`${API}/users`).set('Cookie', cookie).expect(403);
    await request(harness.server).get(`${API}/audit/events`).set('Cookie', cookie).expect(403);
  });

  it('IAM-F-11: changing a password needs a recent re-authentication', async () => {
    const staff = await harness.addUser(fx, {
      name: 'Reauth Needed',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    const { cookie } = await signIn(harness, staff.email);

    // Logging in counts as proof for the next few minutes.
    await request(harness.server)
      .put(`${API}/auth/me/password`)
      .set('Cookie', cookie)
      .send({ password: 'a-brand-new-long-password-1' })
      .expect(204);

    // Age the proof out and try again.
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.session.updateMany({
        where: { userId: staff.id, revokedAt: null },
        data: { reauthAt: new Date(Date.now() - 60 * 60_000) },
      }),
    );
    const stale = await request(harness.server)
      .put(`${API}/auth/me/password`)
      .set('Cookie', cookie)
      .send({ password: 'yet-another-long-password-2' });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('reauth_required');

    await request(harness.server)
      .post(`${API}/auth/reauth`)
      .set('Cookie', cookie)
      .send({ password: 'a-brand-new-long-password-1' })
      .expect(200);

    await request(harness.server)
      .put(`${API}/auth/me/password`)
      .set('Cookie', cookie)
      .send({ password: 'yet-another-long-password-2' })
      .expect(204);
  });
});
