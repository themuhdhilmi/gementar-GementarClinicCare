import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TenantStatus, UserStatus, type Role } from '../../../generated/prisma/enums.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import {
  AppError,
  MfaEnrolmentRequiredError,
  MfaRequiredError,
  SessionInvalidError,
} from '../../../shared/errors/domain-errors.js';
import { permissionsFor, requiresMfa } from '../../../shared/access/permissions.js';
import { DbService } from '../../../shared/prisma/db.service.js';
import { clientIp } from '../../../shared/http/client-ip.js';
import { Clock } from '../../../shared/time/clock.js';
import type { RequestWithContext, TenantContext } from '../../tenancy/tenant-context.js';
import { SessionService } from '../services/session.service.js';
import { UserService } from '../services/user.service.js';
import {
  IS_PUBLIC_KEY,
  MFA_ENROLMENT_KEY,
  PRE_MFA_KEY,
} from '../decorators/auth.decorators.js';

/**
 * Resolves `TenantContext` from the session cookie on every request
 * (IAM-F-19), and enforces IAM-R-02: a session is usable only if it is neither
 * revoked nor expired, its user is ACTIVE, and the second factor has been
 * satisfied where the role demands one.
 *
 * The tenant comes from here and from nowhere else (IAM-R-01).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly users: UserService,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & RequestWithContext & { cookies?: Record<string, string> }>();

    const token = request.cookies?.[this.config.cookie.sessionName];
    if (!token) throw new SessionInvalidError('Please sign in.');

    const { tenantContext, mfaEnabled, rolesAnywhere } = await this.resolve(token, request);
    request.tenantContext = tenantContext;

    const allowPreMfa = this.reflector.getAllAndOverride<boolean>(PRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const allowEnrolment = this.reflector.getAllAndOverride<boolean>(MFA_ENROLMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiresMfa(rolesAnywhere) && !mfaEnabled) {
      // IAM-T-04: an administrator without MFA gets nowhere except enrolment.
      if (!allowEnrolment && !allowPreMfa) throw new MfaEnrolmentRequiredError();
      return true;
    }
    if (mfaEnabled && !tenantContext.mfaVerified && !allowPreMfa) {
      throw new MfaRequiredError();
    }
    return true;
  }

  private async resolve(
    token: string,
    request: Request & { id?: string },
  ): Promise<{ tenantContext: TenantContext; mfaEnabled: boolean; rolesAnywhere: Role[] }> {
    const now = this.clock.now();
    const ip = clientIp(request);
    const userAgent = request.get('user-agent') ?? null;

    // One transaction for the whole lookup: the session is found before the
    // tenant is known, and the rest runs inside that tenant (IAM-N-01).
    return this.db.withAuthLookup(async (tx, becomeTenant) => {
      const session = await this.sessions.findByToken(tx, token);
      if (!session || session.revokedAt !== null) throw new SessionInvalidError();

      if (session.expiresAt <= now) {
        await this.expire(session.tenantId, session.id, 'expired_absolute');
        throw new SessionInvalidError('Your session has expired. Please sign in again.');
      }
      if (this.sessions.isIdleExpired(session.lastSeenAt, now)) {
        await this.expire(session.tenantId, session.id, 'expired_idle');
        throw new SessionInvalidError('You were signed out after a period of inactivity.');
      }
      if (session.user.status !== UserStatus.ACTIVE) {
        // IAM-T-05: a disabled user's live sessions stop working immediately.
        throw new SessionInvalidError('This account is no longer active.');
      }
      if (session.user.tenant.status !== TenantStatus.ACTIVE) {
        throw new SessionInvalidError('This clinic account is not active.');
      }

      await becomeTenant(session.tenantId);

      const assignments = await this.users.rolesFor(tx, session.userId);
      if (assignments.length === 0) {
        throw new AppError(
          403,
          'no_branch_access',
          'No branch access',
          'Your account has no branch assigned. Ask an administrator.',
        );
      }

      // TEN-R-06: the active branch is re-validated on every request, not only
      // when it is switched. A role removed a minute ago takes effect now.
      let branchId = session.activeBranchId;
      if (!assignments.some((a) => a.branchId === branchId)) {
        branchId = assignments[0]!.branchId;
        await this.sessions.setActiveBranch(tx, session.id, branchId);
      }

      const roles = this.users.rolesAtBranch(assignments, branchId);
      const permissionVersion = session.user.permissionVersion;
      const stalePermissions = session.permissionVersion !== permissionVersion;

      // IAM-N-01: at most one small write per session per minute.
      if (stalePermissions || this.sessions.needsTouch(session.lastSeenAt, now)) {
        await this.sessions.touch(tx, session.id, permissionVersion);
      }

      const tenantContext: TenantContext = {
        tenantId: session.tenantId,
        branchId,
        userId: session.userId,
        sessionId: session.id,
        userName: session.user.name,
        userEmail: session.user.email,
        roles,
        rolesAnywhere: assignments.map((a) => a.role),
        permissions: new Set(permissionsFor(roles)),
        permissionVersion,
        mfaVerified: session.mfaVerified,
        reauthAt: session.reauthAt,
        ip,
        userAgent,
        requestId: request.id ?? 'unknown',
      };

      return {
        tenantContext,
        mfaEnabled: session.user.mfaEnabled,
        rolesAnywhere: assignments.map((a) => a.role),
      };
    });
  }

  /**
   * In its own transaction: the request is about to be refused, and a rolled
   * back revocation would leave the dead session looking alive.
   */
  private async expire(tenantId: string, sessionId: string, reason: 'expired_idle' | 'expired_absolute') {
    await this.db.withTenantIndependently(tenantId, `expire a session (${reason})`, (tx) =>
      this.sessions.revoke(tx, sessionId, reason),
    );
  }
}
