import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LoginOutcome,
  Role,
  TokenPurpose,
  UserStatus,
  TenantStatus,
} from '../../../generated/prisma/enums.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import {
  AppError,
  AuthenticationFailedError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from '../../../shared/errors/domain-errors.js';
import { Clock } from '../../../shared/time/clock.js';
import { DbService, type Tx } from '../../../shared/prisma/db.service.js';
import { permissionsFor, requiresMfa } from '../../../shared/access/permissions.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/audit.actions.js';
import { EventBus } from '../../events/event-bus.service.js';
import { DomainEvent } from '../../events/domain-events.js';
import { BranchService } from '../../tenancy/branch.service.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { MailerService } from './mailer.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { UserService } from './user.service.js';
import { normaliseEmail } from './normalise.js';

export type RequestMeta = {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  deviceToken?: string;
};

export type LoginResult = {
  sessionToken: string;
  expiresAt: Date;
  mfaRequired: boolean;
  mfaEnrolmentRequired: boolean;
  activeBranchId: string;
  user: { id: string; name: string; email: string };
  tenant: { id: string; name: string; slug: string };
};

/**
 * The login path. Everything here is written for one property above all others:
 * a caller must not be able to tell an unknown email from a wrong password from
 * a locked account (IAM-R-07). Same response, same status, same rough timing.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly mfa: MfaService,
    private readonly devices: TrustedDeviceService,
    private readonly tokens: TokenService,
    private readonly mailer: MailerService,
    private readonly users: UserService,
    private readonly branches: BranchService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  // ------------------------------------------------------------------ login

  async login(
    input: { email: string; password: string; tenantSlug?: string },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const emailKey = normaliseEmail(input.email);

    const decision = await this.db.withPlatform('login rate-limit check', (tx) =>
      this.throttle.check(tx, emailKey, meta.ip),
    );
    if (decision.limited) {
      await this.db.withPlatform('record throttled login', (tx) =>
        this.throttle.record(tx, {
          emailKey,
          ip: meta.ip,
          userAgent: meta.userAgent,
          outcome: LoginOutcome.RATE_LIMITED,
        }),
      );
      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    // The tenant is not known yet, so this one read is deliberately unscoped.
    const candidates = await this.db.withPlatform('resolve login identity', (tx) =>
      tx.user.findMany({
        where: {
          email: emailKey,
          ...(input.tenantSlug ? { tenant: { slug: input.tenantSlug.trim().toLowerCase() } } : {}),
        },
        select: {
          id: true,
          tenantId: true,
          email: true,
          name: true,
          passwordHash: true,
          status: true,
          lockedUntil: true,
          failedAttempts: true,
          mfaEnabled: true,
          permissionVersion: true,
          defaultBranchId: true,
          tenant: { select: { id: true, name: true, slug: true, status: true } },
        },
        take: 3,
      }),
    );

    if (candidates.length !== 1) {
      await this.passwords.burnTime(input.password);
      await this.db.withPlatform('record failed login', (tx) =>
        this.throttle.record(tx, {
          emailKey,
          ip: meta.ip,
          userAgent: meta.userAgent,
          outcome:
            candidates.length === 0 ? LoginOutcome.UNKNOWN_EMAIL : LoginOutcome.AMBIGUOUS_EMAIL,
        }),
      );
      if (candidates.length > 1) {
        // Two tenants, one email address. V0 has no tenant picker on the login
        // form (§14), so the honest answer is to fail and record it.
        this.logger.warn(`Login for ${emailKey} matched ${candidates.length} tenants`);
      }
      throw new AuthenticationFailedError();
    }

    const user = candidates[0]!;
    const now = this.clock.now();

    // Always run a hash comparison, even when the outcome is already decided.
    const passwordOk = user.passwordHash
      ? await this.passwords.verify(user.passwordHash, input.password)
      : (await this.passwords.burnTime(input.password), false);

    const locked = user.lockedUntil !== null && user.lockedUntil > now;
    const loginable =
      user.tenant.status === TenantStatus.ACTIVE &&
      user.passwordHash !== null &&
      (user.status === UserStatus.ACTIVE || user.status === UserStatus.LOCKED);

    if (!passwordOk) {
      await this.recordFailure(user, emailKey, meta, LoginOutcome.BAD_CREDENTIALS);
      throw new AuthenticationFailedError();
    }

    if (locked || !loginable) {
      await this.recordFailure(user, emailKey, meta, LoginOutcome.NOT_LOGINABLE, {
        countsTowardsLockout: false,
      });
      throw new AuthenticationFailedError();
    }

    // Rehash out here: Argon2id takes a quarter of a second and must not be
    // holding a database connection while it runs.
    const rehashed =
      user.passwordHash && this.passwords.needsRehash(user.passwordHash)
        ? await this.passwords.hash(input.password)
        : null;

    return this.db.withTenant(user.tenantId, async (tx) => {
      const assignments = await this.users.rolesFor(tx, user.id);
      if (assignments.length === 0) {
        throw new AppError(
          403,
          'no_branch_access',
          'No branch access',
          'Your account has no branch assigned. Ask an administrator to give you one.',
        );
      }

      const activeBranchId = await this.pickActiveBranch(tx, user.defaultBranchId, assignments);
      const rolesAnywhere = assignments.map((a) => a.role);
      const mfaEnrolmentRequired = requiresMfa(rolesAnywhere) && !user.mfaEnabled;
      const trusted = user.mfaEnabled
        ? await this.devices.isTrusted(tx, user.id, meta.deviceToken)
        : false;
      const mfaSatisfied = user.mfaEnabled ? trusted : !mfaEnrolmentRequired;

      await tx.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(user.status === UserStatus.LOCKED ? { status: UserStatus.ACTIVE } : {}),
          ...(rehashed ? { passwordHash: rehashed } : {}),
        },
      });

      const session = await this.sessions.create(tx, {
        userId: user.id,
        activeBranchId,
        permissionVersion: user.permissionVersion,
        mfaVerified: mfaSatisfied,
        // A password typed a moment ago counts as a fresh proof of identity, so
        // enrolling in MFA right after login does not ask for it twice.
        reauthAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      await this.throttle.record(tx, {
        emailKey,
        ip: meta.ip,
        userAgent: meta.userAgent,
        outcome: LoginOutcome.SUCCESS,
        tenantId: user.tenantId,
        userId: user.id,
      });

      await this.audit.record(
        tx,
        {
          tenantId: user.tenantId,
          branchId: activeBranchId,
          actorId: user.id,
          actorName: user.name,
          actorRole: this.users.rolesAtBranch(assignments, activeBranchId).join(','),
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        },
        {
          action: AuditAction.AuthLogin,
          entityType: 'session',
          entityId: session.id,
          after: { mfaVerified: mfaSatisfied, trustedDevice: trusted, branchId: activeBranchId },
        },
      );
      this.events.publish({
        name: DomainEvent.AuthLogin,
        tenantId: user.tenantId,
        branchId: activeBranchId,
        actorId: user.id,
        occurredAt: now,
        payload: { sessionId: session.id, mfaVerified: mfaSatisfied },
      });

      return {
        sessionToken: session.token,
        expiresAt: session.expiresAt,
        mfaRequired: user.mfaEnabled && !trusted,
        mfaEnrolmentRequired,
        activeBranchId,
        user: { id: user.id, name: user.name, email: user.email },
        tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
      } satisfies LoginResult;
    });
  }

  private async recordFailure(
    user: {
      id: string;
      tenantId: string;
      name: string;
      failedAttempts: number;
      status: UserStatus;
    },
    emailKey: string,
    meta: RequestMeta,
    outcome: LoginOutcome,
    options: { countsTowardsLockout?: boolean } = {},
  ): Promise<void> {
    const countsTowardsLockout = options.countsTowardsLockout ?? true;

    await this.db.withTenant(user.tenantId, async (tx) => {
      let locked = false;
      if (countsTowardsLockout) {
        const attempts = user.failedAttempts + 1;
        locked = attempts >= this.config.login.lockoutThreshold;
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedAttempts: attempts,
            ...(locked
              ? {
                  status: user.status === UserStatus.ACTIVE ? UserStatus.LOCKED : user.status,
                  lockedUntil: this.clock.inMinutes(this.config.login.lockoutMinutes),
                }
              : {}),
          },
        });
      }

      await this.throttle.record(tx, {
        emailKey,
        ip: meta.ip,
        userAgent: meta.userAgent,
        outcome,
        tenantId: user.tenantId,
        userId: user.id,
      });

      const actor = {
        tenantId: user.tenantId,
        branchId: null,
        actorId: user.id,
        actorName: user.name,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      };
      await this.audit.record(tx, actor, {
        action: AuditAction.AuthLoginFailed,
        entityType: 'user',
        entityId: user.id,
        // The attempted email is recorded; the attempted password never is.
        after: { email: emailKey, outcome },
      });
      if (locked) {
        await this.audit.record(tx, actor, {
          action: AuditAction.AuthLocked,
          entityType: 'user',
          entityId: user.id,
          after: { lockoutMinutes: this.config.login.lockoutMinutes },
        });
        this.events.publish({
          name: DomainEvent.AuthLocked,
          tenantId: user.tenantId,
          branchId: null,
          actorId: user.id,
          occurredAt: this.clock.now(),
          payload: { userId: user.id },
        });
      }
      this.events.publish({
        name: DomainEvent.AuthLoginFailed,
        tenantId: user.tenantId,
        branchId: null,
        actorId: user.id,
        occurredAt: this.clock.now(),
        payload: { email: emailKey, outcome },
      });
    });
  }

  private async pickActiveBranch(
    tx: Tx,
    defaultBranchId: string | null,
    assignments: ReadonlyArray<{ branchId: string; role: Role }>,
  ): Promise<string> {
    const ids = [...new Set(assignments.map((a) => a.branchId))];
    const branches = await this.branches.listByIds(tx, ids);
    const active = branches.filter((b) => b.status === 'ACTIVE');
    const pool = active.length > 0 ? active : branches;
    if (pool.length === 0) {
      throw new AppError(
        403,
        'no_branch_access',
        'No branch access',
        'None of your branches are open. Ask an administrator.',
      );
    }
    const preferred = pool.find((b) => b.id === defaultBranchId);
    return (preferred ?? pool[0]!).id;
  }

  // -------------------------------------------------------------------- MFA

  async verifyMfa(
    ctx: TenantContext,
    input: { code: string; trustDevice?: boolean; deviceLabel?: string },
    meta: RequestMeta,
  ): Promise<{ trustedDeviceToken?: string; trustedDeviceExpiresAt?: Date }> {
    const tx = this.db.tx();
    const user = await tx.user.findFirst({
      where: { id: ctx.userId },
      select: { id: true, email: true, name: true, mfaEnabled: true, mfaSecretEnc: true, mfaRecoveryEnc: true },
    });
    if (!user || !user.mfaEnabled) {
      throw new BadRequestError('Multi-factor authentication is not set up.', 'mfa_not_enrolled');
    }

    const raw = input.code.trim();
    const looksLikeRecovery = /[^0-9]/.test(raw);
    const ok = looksLikeRecovery
      ? await this.mfa.verifyRecoveryCode(tx, user, raw)
      : await this.mfa.verifyTotp(tx, user, raw, this.mfaIssuer());

    const actor = this.audit.actorFromContext(ctx);
    if (!ok) {
      // In its own transaction: this request is about to fail, and a rolled
      // back failure record would neither be audited nor counted towards the
      // rate limit.
      await this.db.withTenantIndependently(ctx.tenantId, 'record a failed MFA code', async (own) => {
        await this.throttle.record(own, {
          emailKey: user.email,
          ip: meta.ip,
          userAgent: meta.userAgent,
          outcome: LoginOutcome.MFA_FAILED,
          tenantId: ctx.tenantId,
          userId: user.id,
        });
        await this.audit.record(own, actor, {
          action: AuditAction.MfaFailed,
          entityType: 'user',
          entityId: user.id,
          after: { method: looksLikeRecovery ? 'recovery' : 'totp', stage: 'sign-in' },
        });
      });
      throw new AuthenticationFailedError('That code is not valid.');
    }

    await this.sessions.markMfaVerified(tx, ctx.sessionId, this.clock.now());

    if (looksLikeRecovery) {
      await this.audit.record(tx, actor, {
        action: AuditAction.MfaRecoveryUsed,
        entityType: 'user',
        entityId: user.id,
        after: { remaining: await this.mfa.remainingRecoveryCodes(user) },
      });
    }

    if (!input.trustDevice) return {};

    const device = await this.devices.issue(tx, user.id, input.deviceLabel ?? meta.userAgent);
    await this.audit.record(tx, actor, {
      action: AuditAction.TrustedDeviceAdded,
      entityType: 'trusted_device',
      entityId: null,
      after: { expiresAt: device.expiresAt },
    });
    return { trustedDeviceToken: device.token, trustedDeviceExpiresAt: device.expiresAt };
  }

  async enrolMfa(
    ctx: TenantContext,
  ): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string; reused: boolean }> {
    const tx = this.db.tx();
    const user = await tx.user.findFirst({
      where: { id: ctx.userId },
      select: { id: true, email: true, mfaEnabled: true, mfaSecretEnc: true },
    });
    if (!user) throw new NotFoundError('User');
    return this.mfa.offerEnrolment(tx, user, this.mfaIssuer());
  }

  async confirmMfa(ctx: TenantContext, code: string): Promise<{ recoveryCodes: string[] }> {
    const tx = this.db.tx();
    const user = await tx.user.findFirst({
      where: { id: ctx.userId },
      select: { id: true, email: true, mfaSecretEnc: true },
    });
    if (!user?.mfaSecretEnc) {
      throw new BadRequestError('Start enrolment before confirming it.', 'mfa_not_started');
    }

    const codes = await this.mfa.confirmEnrolment(tx, user, code, this.mfaIssuer());
    if (!codes) {
      // Recorded like a rejected code at sign-in, and in its own transaction
      // for the same reason: the request is about to roll back.
      await this.db.withTenantIndependently(ctx.tenantId, 'record a failed enrolment code', (own) =>
        this.audit.record(own, this.audit.actorFromContext(ctx), {
          action: AuditAction.MfaFailed,
          entityType: 'user',
          entityId: ctx.userId,
          after: { method: 'totp', stage: 'enrolment' },
        }),
      );
      throw new AuthenticationFailedError('That code is not valid.');
    }

    await this.sessions.markMfaVerified(tx, ctx.sessionId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.MfaEnrolled,
      entityType: 'user',
      entityId: ctx.userId,
      after: { codesIssued: codes.length },
    });
    this.events.publish({
      name: DomainEvent.MfaEnrolled,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId: ctx.userId },
    });
    return { recoveryCodes: codes };
  }

  async disableMfa(ctx: TenantContext): Promise<void> {
    const tx = this.db.tx();
    const roles = await this.users.rolesFor(tx, ctx.userId);
    if (requiresMfa(roles.map((r) => r.role))) {
      throw new ForbiddenError(
        'Your role requires multi-factor authentication, so it cannot be switched off.',
      );
    }
    await this.mfa.disable(tx, ctx.userId);
    await this.devices.revokeAllForUser(tx, ctx.userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.MfaDisabled,
      entityType: 'user',
      entityId: ctx.userId,
      after: { by: 'self' },
    });
    this.events.publish({
      name: DomainEvent.MfaDisabled,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId: ctx.userId, by: 'self' },
    });
  }

  private mfaIssuer(): string {
    return 'ClinicCare';
  }

  // --------------------------------------------------------------- sessions

  async logout(ctx: TenantContext): Promise<void> {
    const tx = this.db.tx();
    const count = await this.sessions.revoke(tx, ctx.sessionId, 'logout');
    if (count > 0) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.AuthLogout,
        entityType: 'session',
        entityId: ctx.sessionId,
      });
      this.events.publish({
        name: DomainEvent.AuthLogout,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        actorId: ctx.userId,
        occurredAt: this.clock.now(),
        payload: { sessionId: ctx.sessionId },
      });
    }
  }

  async listSessions(ctx: TenantContext) {
    const tx = this.db.tx();
    const rows = await this.sessions.listActiveForUser(tx, ctx.userId);
    return rows.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      branchId: s.activeBranchId,
      current: s.id === ctx.sessionId,
    }));
  }

  async revokeOwnSession(ctx: TenantContext, sessionId: string): Promise<void> {
    const tx = this.db.tx();
    const session = await this.sessions.findOwnedById(tx, ctx.userId, sessionId);
    if (!session) throw new NotFoundError('Session');
    const count = await this.sessions.revoke(tx, sessionId, 'user_request');
    if (count > 0) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.SessionRevoked,
        entityType: 'session',
        entityId: sessionId,
        after: { scope: 'self' },
      });
    }
  }

  async switchBranch(ctx: TenantContext, branchId: string): Promise<{ branchId: string }> {
    const tx = this.db.tx();
    const assignments = await this.users.rolesFor(tx, ctx.userId);
    if (!assignments.some((a) => a.branchId === branchId)) {
      // IAM-F-21 and TEN-R-06: switching branch is a server-side action, and
      // the client is never trusted to say where it may work.
      throw new ForbiddenError('You do not have a role at that branch.');
    }
    const branch = await this.branches.getOrThrow(tx, branchId);
    if (branch.status !== 'ACTIVE') {
      throw new ForbiddenError('That branch is not active.');
    }

    await this.sessions.setActiveBranch(tx, ctx.sessionId, branchId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.AuthBranchSwitched,
      entityType: 'session',
      entityId: ctx.sessionId,
      before: { branchId: ctx.branchId },
      after: { branchId },
    });
    return { branchId };
  }

  // --------------------------------------------------------------- password

  async reauthenticate(
    ctx: TenantContext,
    input: { password?: string; code?: string },
  ): Promise<{ reauthAt: Date }> {
    const tx = this.db.tx();
    const user = await tx.user.findFirst({
      where: { id: ctx.userId },
      select: { id: true, email: true, passwordHash: true, mfaEnabled: true, mfaSecretEnc: true },
    });
    if (!user) throw new NotFoundError('User');

    let ok = false;
    if (input.password && user.passwordHash) {
      ok = await this.passwords.verify(user.passwordHash, input.password);
    } else if (input.code && user.mfaEnabled) {
      ok = await this.mfa.verifyTotp(tx, user, input.code, this.mfaIssuer());
    } else {
      throw new BadRequestError('Provide your password or a one-time code.', 'reauth_input');
    }
    if (!ok) throw new AuthenticationFailedError('That did not match.');

    const reauthAt = await this.sessions.markReauthenticated(tx, ctx.sessionId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.AuthReauth,
      entityType: 'session',
      entityId: ctx.sessionId,
      after: { method: input.password ? 'password' : 'totp' },
    });
    return { reauthAt };
  }

  async changeOwnPassword(ctx: TenantContext, newPassword: string): Promise<void> {
    const check = await this.passwords.validate(newPassword, {
      email: ctx.userEmail,
      name: ctx.userName,
    });
    if (!check.ok) {
      throw new BadRequestError(check.messages.join(' '), 'password_rejected', {
        problems: check.problems,
      });
    }
    const hash = await this.passwords.hash(newPassword);

    const tx = this.db.tx();
    await tx.user.update({
      where: { id: ctx.userId },
      data: { passwordHash: hash, updatedBy: ctx.userId },
    });
    const revoked = await this.sessions.revokeAllForUser(
      tx,
      ctx.userId,
      'password_changed',
      ctx.sessionId,
    );
    await this.tokens.invalidateAllForUser(tx, ctx.userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.AuthPasswordChanged,
      entityType: 'user',
      entityId: ctx.userId,
      after: { otherSessionsRevoked: revoked },
    });
  }

  /** Always 202, whatever the answer: the endpoint must not confirm who exists. */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const emailKey = normaliseEmail(email);
    const candidates = await this.db.withPlatform('resolve password reset identity', (tx) =>
      tx.user.findMany({
        where: { email: emailKey },
        select: {
          id: true,
          tenantId: true,
          email: true,
          name: true,
          status: true,
          tenant: { select: { status: true } },
        },
        take: 3,
      }),
    );
    if (candidates.length !== 1) return;

    const user = candidates[0]!;
    if (user.tenant.status !== TenantStatus.ACTIVE) return;
    if (user.status === UserStatus.DISABLED) return;

    await this.db.withTenant(user.tenantId, async (tx) => {
      // A quiet cap, so the endpoint cannot be used to spam someone's inbox.
      const recent = await this.tokens.countRecentForUser(tx, user.id, 15);
      if (recent >= 3) return;

      const purpose = user.status === UserStatus.INVITED ? TokenPurpose.INVITE : TokenPurpose.RESET;
      const token = await this.tokens.issue(tx, { userId: user.id, purpose });
      await this.audit.record(
        tx,
        {
          tenantId: user.tenantId,
          actorId: user.id,
          actorName: user.name,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        },
        {
          action: AuditAction.AuthPasswordResetRequested,
          entityType: 'user',
          entityId: user.id,
          after: { purpose, expiresAt: token.expiresAt },
        },
      );
      this.db.afterCommit(() => {
        if (purpose === TokenPurpose.INVITE) {
          void this.mailer.sendInvite(user.email, user.name, token.link, token.expiresAt);
        } else {
          void this.mailer.sendPasswordReset(user.email, user.name, token.link, token.expiresAt);
        }
      });
    });
  }

  /**
   * IAM-F-07 / IAM-R-06: consuming the token, setting the password and revoking
   * every existing session happen in one transaction. Half of that would be a
   * security hole.
   */
  async resetPassword(
    input: { token: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    const found = await this.db.withPlatform('resolve reset token', (tx) =>
      this.tokens.findUsable(tx, input.token),
    );
    if (!found) {
      throw new BadRequestError(
        'That link has expired or has already been used. Request a new one.',
        'token_invalid',
      );
    }

    const user = await this.db.withTenant(found.tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: found.userId },
        select: { id: true, email: true, name: true, status: true },
      }),
    );
    if (!user) throw new BadRequestError('That link is no longer valid.', 'token_invalid');
    if (user.status === UserStatus.DISABLED) {
      throw new BadRequestError('That account is disabled.', 'user_disabled');
    }

    const check = await this.passwords.validate(input.password, {
      email: user.email,
      name: user.name,
    });
    if (!check.ok) {
      throw new BadRequestError(check.messages.join(' '), 'password_rejected', {
        problems: check.problems,
      });
    }
    const hash = await this.passwords.hash(input.password);

    await this.db.withTenant(found.tenantId, async (tx) => {
      const consumed = await this.tokens.consume(tx, found.id);
      if (!consumed) {
        throw new BadRequestError('That link has already been used.', 'token_invalid');
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: hash,
          status: UserStatus.ACTIVE,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await this.tokens.invalidateAllForUser(tx, user.id);
      const revoked = await this.sessions.revokeAllForUser(tx, user.id, 'password_reset');

      await this.audit.record(
        tx,
        {
          tenantId: found.tenantId,
          actorId: user.id,
          actorName: user.name,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        },
        {
          action: AuditAction.AuthPasswordReset,
          entityType: 'user',
          entityId: user.id,
          after: { purpose: found.purpose, sessionsRevoked: revoked },
        },
      );
    });
  }

  // --------------------------------------------------------------------- me

  async describeContext(ctx: TenantContext) {
    const tx = this.db.tx();
    const assignments = await this.users.rolesFor(tx, ctx.userId);
    const branches = await this.branches.listByIds(
      tx,
      [...new Set(assignments.map((a) => a.branchId))],
    );
    const user = await tx.user.findFirst({
      where: { id: ctx.userId },
      select: { mfaEnabled: true, mfaRecoveryEnc: true, lastLoginAt: true, id: true },
    });

    const rolesAnywhere = assignments.map((a) => a.role);
    return {
      user: {
        id: ctx.userId,
        name: ctx.userName,
        email: ctx.userEmail,
        lastLoginAt: user?.lastLoginAt ?? null,
      },
      tenantId: ctx.tenantId,
      activeBranchId: ctx.branchId,
      roles: ctx.roles,
      permissions: [...ctx.permissions],
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        status: b.status,
        roles: this.users.rolesAtBranch(assignments, b.id),
      })),
      mfa: {
        enabled: user?.mfaEnabled ?? false,
        required: requiresMfa(rolesAnywhere),
        verified: ctx.mfaVerified,
        recoveryCodesRemaining: user ? await this.mfa.remainingRecoveryCodes(user) : 0,
      },
      reauthValidUntil: ctx.reauthAt
        ? new Date(ctx.reauthAt.getTime() + this.config.session.reauthMinutes * 60_000)
        : null,
      permissionsByRole: permissionsFor(ctx.roles),
    };
  }
}
