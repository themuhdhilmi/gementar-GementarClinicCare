import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { UserStatus } from '../src/generated/prisma/enums.js';
import { newId } from '../src/shared/ids/uuid.js';
import { TokenPurpose } from '../src/generated/prisma/enums.js';

const API = '/api/v1';

describe('IAM — authentication (against real PostgreSQL)', () => {
  const harness = new Harness();
  let fx: Fixture;

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('auth');
  });

  afterAll(async () => {
    await harness.stop();
  });

  const login = (email: string, password: string) =>
    request(harness.server).post(`${API}/auth/login`).send({ email, password });

  it('IAM-T-01: a valid login sets a session cookie and /auth/me returns permissions', async () => {
    const response = await login(fx.doctor.email, DEFAULT_PASSWORD).expect(200);

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('cc_session='))!;
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(response.body.mfaRequired).toBe(false);
    expect(response.body.activeBranchId).toBe(fx.branchAId);

    const me = await request(harness.server)
      .get(`${API}/auth/me`)
      .set('Cookie', session)
      .expect(200);

    expect(me.body.roles).toEqual(['DOCTOR']);
    expect(me.body.permissions).toContain('clinical.write');
    expect(me.body.permissions).not.toContain('admin.users');
    expect(me.body.activeBranchId).toBe(fx.branchAId);
    expect(me.body.branches).toHaveLength(1);
  });

  it('answers identically for an unknown email and a wrong password (IAM-R-07)', async () => {
    const unknown = await login(`nobody-${newId().slice(-8)}@test.local`, 'whatever-long-password');
    const wrong = await login(fx.frontdesk.email, 'definitely-not-the-password');

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.detail).toEqual(wrong.body.detail);
    expect(unknown.body.code).toEqual(wrong.body.code);
  });

  it('IAM-T-02: the sixth failure inside the window is rate limited and audited', async () => {
    const user = await harness.addUser(fx, {
      name: 'Rate Limited',
      roles: [{ branchId: fx.branchAId, role: 'RECEPTION' }],
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(user.email, `wrong-password-${attempt}`).expect(401);
    }

    const blocked = await login(user.email, DEFAULT_PASSWORD).expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.code).toBe('rate_limited');

    const audited = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'auth.login_failed', entityId: user.id } }),
    );
    expect(audited).toBe(5);
  });

  it('IAM-T-03: after ten consecutive failures the account stays locked even with the right password', async () => {
    const user = await harness.addUser(fx, {
      name: 'Locked Out',
      roles: [{ branchId: fx.branchAId, role: 'NURSE' }],
    });

    // Nine failures are recorded directly; the tenth goes through the API so
    // the lockout itself is exercised, without tripping the rate limiter first.
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { failedAttempts: 9 } }),
    );

    await login(user.email, 'still-the-wrong-password').expect(401);

    const locked = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: user.id }, select: { status: true, lockedUntil: true } }),
    );
    expect(locked?.status).toBe(UserStatus.LOCKED);
    expect(locked?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());

    const correct = await login(user.email, DEFAULT_PASSWORD).expect(401);
    expect(correct.body.code).toBe('authentication_failed');

    const lockAudit = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'auth.locked', entityId: user.id } }),
    );
    expect(lockAudit).toBe(1);

    // An administrator can let them back in (IAM-F-06).
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { status: UserStatus.ACTIVE, lockedUntil: null, failedAttempts: 0 },
      }),
    );
    await login(user.email, DEFAULT_PASSWORD).expect(200);
  });

  it('IAM-T-04: an ADMIN without MFA is forced through enrolment before anything else', async () => {
    const response = await login(fx.admin.email, DEFAULT_PASSWORD).expect(200);
    expect(response.body.mfaEnrolmentRequired).toBe(true);
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    const blocked = await request(harness.server).get(`${API}/users`).set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('mfa_enrolment_required');

    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    expect(enrol.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrol.body.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);

    const confirm = await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: totpFor(enrol.body.secret) })
      .expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    await request(harness.server).get(`${API}/users`).set('Cookie', cookie).expect(200);
  });

  it('IAM-T-10: a TOTP code cannot be used twice inside its window', async () => {
    const user = await harness.addUser(fx, {
      name: 'MFA User',
      roles: [{ branchId: fx.branchAId, role: 'DOCTOR' }],
    });

    const first = await login(user.email, DEFAULT_PASSWORD).expect(200);
    const cookie = (first.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    const enrol = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    const code = totpFor(enrol.body.secret);
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code })
      .expect(200);

    // Fresh login now demands the second factor.
    const second = await login(user.email, DEFAULT_PASSWORD).expect(200);
    expect(second.body.mfaRequired).toBe(true);
    const cookie2 = (second.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    const replayed = await request(harness.server)
      .post(`${API}/auth/mfa/verify`)
      .set('Cookie', cookie2)
      .send({ code });
    expect(replayed.status).toBe(401);

    // The refusal is recorded and counted, even though the request that
    // carried it rolled back.
    const [audited, attempts] = await Promise.all([
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.count({ where: { action: 'mfa.failed', entityId: user.id } }),
      ),
      harness.db.withPlatform('count attempts', (tx) =>
        tx.loginAttempt.count({ where: { emailKey: user.email, outcome: 'MFA_FAILED' } }),
      ),
    ]);
    expect(audited).toBe(1);
    expect(attempts).toBe(1);

    const fresh = totpFor(enrol.body.secret, 1);
    const accepted = await request(harness.server)
      .post(`${API}/auth/mfa/verify`)
      .set('Cookie', cookie2)
      .send({ code: fresh });
    expect(accepted.status).toBe(200);

    const again = await request(harness.server)
      .post(`${API}/auth/mfa/verify`)
      .set('Cookie', cookie2)
      .send({ code: fresh });
    expect(again.status).toBe(401);
  });

  it('reopening MFA enrolment keeps the secret, so an already scanned code still works', async () => {
    const user = await harness.addUser(fx, {
      name: 'Scans Once',
      roles: [{ branchId: fx.branchAId, role: 'DOCTOR' }],
    });
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: DEFAULT_PASSWORD })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    // Scan the code, then reload the page before typing the digits.
    const first = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);
    const second = await request(harness.server)
      .post(`${API}/auth/me/mfa/enrol`)
      .set('Cookie', cookie)
      .expect(200);

    expect(second.body.secret).toBe(first.body.secret);
    expect(second.body.reused).toBe(true);

    // The code from the first QR is still the right one.
    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: totpFor(first.body.secret) })
      .expect(200);
  });

  it('a rejected code during enrolment is audited, like one at sign-in', async () => {
    const user = await harness.addUser(fx, {
      name: 'Fat Fingers',
      roles: [{ branchId: fx.branchAId, role: 'NURSE' }],
    });
    const login = await request(harness.server)
      .post(`${API}/auth/login`)
      .send({ email: user.email, password: DEFAULT_PASSWORD })
      .expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    await request(harness.server).post(`${API}/auth/me/mfa/enrol`).set('Cookie', cookie).expect(200);

    await request(harness.server)
      .post(`${API}/auth/me/mfa/confirm`)
      .set('Cookie', cookie)
      .send({ code: '000000' })
      .expect(401);

    const recorded = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({ where: { action: 'mfa.failed', entityId: user.id } }),
    );
    expect(recorded).toBe(1);
  });

  it('IAM-T-06: a reset token is single-use and revokes every existing session', async () => {
    const user = await harness.addUser(fx, {
      name: 'Reset Me',
      roles: [{ branchId: fx.branchAId, role: 'RECEPTION' }],
    });

    const sessionOne = await login(user.email, DEFAULT_PASSWORD).expect(200);
    const cookieOne = (sessionOne.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookieOne).expect(200);

    // Mint a reset token the way the forgot-password flow does.
    const token = 'tok-' + newId() + newId();
    const crypto = await import('node:crypto');
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.passwordResetToken.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          userId: user.id,
          tokenHash: Uint8Array.from(crypto.createHash('sha256').update(token).digest()),
          purpose: TokenPurpose.RESET,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      }),
    );

    const newPassword = 'entirely-different-passphrase-77';
    await request(harness.server)
      .post(`${API}/auth/password/reset`)
      .send({ token, password: newPassword })
      .expect(200);

    // Pre-existing session is dead.
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookieOne).expect(401);
    // The token cannot be replayed.
    await request(harness.server)
      .post(`${API}/auth/password/reset`)
      .send({ token, password: 'another-valid-passphrase-99' })
      .expect(400);
    // The new password works.
    await login(user.email, newPassword).expect(200);
    await login(user.email, DEFAULT_PASSWORD).expect(401);
  });

  it('rejects weak passwords with an explanation, not a rule list', async () => {
    const user = await harness.addUser(fx, {
      name: 'Weak Password',
      roles: [{ branchId: fx.branchAId, role: 'NURSE' }],
    });
    const token = 'tok-' + newId() + newId();
    const crypto = await import('node:crypto');
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.passwordResetToken.create({
        data: {
          id: newId(),
          tenantId: fx.tenantId,
          userId: user.id,
          tokenHash: Uint8Array.from(crypto.createHash('sha256').update(token).digest()),
          purpose: TokenPurpose.RESET,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      }),
    );

    const short = await request(harness.server)
      .post(`${API}/auth/password/reset`)
      .send({ token, password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.detail.toLowerCase()).toContain('12');
  });

  it('forgot-password always answers the same way', async () => {
    const known = await request(harness.server)
      .post(`${API}/auth/password/forgot`)
      .send({ email: fx.doctor.email })
      .expect(202);
    const unknown = await request(harness.server)
      .post(`${API}/auth/password/forgot`)
      .send({ email: `ghost-${newId().slice(-8)}@test.local` })
      .expect(202);
    expect(known.body).toEqual(unknown.body);
  });

  it('logout destroys the session server-side, immediately', async () => {
    const response = await login(fx.frontdesk.email, DEFAULT_PASSWORD).expect(200);
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    await request(harness.server).post(`${API}/auth/logout`).set('Cookie', cookie).expect(204);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookie).expect(401);
  });

  it('a user can list and revoke their own sessions (IAM-F-24)', async () => {
    const first = await login(fx.doctor.email, DEFAULT_PASSWORD).expect(200);
    const second = await login(fx.doctor.email, DEFAULT_PASSWORD).expect(200);
    const cookieA = (first.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;
    const cookieB = (second.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_session='),
    )!;

    const list = await request(harness.server)
      .get(`${API}/auth/me/sessions`)
      .set('Cookie', cookieB)
      .expect(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
    const current = list.body.items.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);

    const other = list.body.items.find((s: { current: boolean }) => !s.current)!;
    await request(harness.server)
      .delete(`${API}/auth/me/sessions/${other.id}`)
      .set('Cookie', cookieB)
      .expect(204);

    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookieA).expect(401);
    await request(harness.server).get(`${API}/auth/me`).set('Cookie', cookieB).expect(200);
  });
});
