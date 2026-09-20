import { Injectable } from '@nestjs/common';
import { Role, TokenPurpose, UserStatus } from '../../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  InvariantViolationError,
  NotFoundError,
} from '../../../shared/errors/domain-errors.js';
import { newId } from '../../../shared/ids/uuid.js';
import { Clock } from '../../../shared/time/clock.js';
import { toPage, type Page } from '../../../shared/pagination/page.js';
import { DbService, type Tx } from '../../../shared/prisma/db.service.js';
import { requireTenantId } from '../../../shared/prisma/tenant-scope.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/audit.actions.js';
import { EventBus } from '../../events/event-bus.service.js';
import { DomainEvent } from '../../events/domain-events.js';
import { TenantService } from '../../tenancy/tenant.service.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { MailerService } from './mailer.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';
import { assertEmail, normaliseName, normalisePhone } from './normalise.js';

export type RoleAssignment = { branchId: string; role: Role };

export type UserListFilter = {
  status?: UserStatus;
  branchId?: string;
  role?: Role;
  query?: string;
  page: number;
  pageSize: number;
};

export type UserSummary = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  roles: RoleAssignment[];
  defaultBranchId: string | null;
};

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  mfaEnabled: true,
  lastLoginAt: true,
  lockedUntil: true,
  defaultBranchId: true,
  permissionVersion: true,
  branchRoles: { select: { branchId: true, role: true } },
} as const;

/**
 * User administration (IAM-F-12 … IAM-F-18).
 *
 * Users are never hard-deleted (IAM-F-17): their name is on prescriptions,
 * invoices and clinical notes, and those have to keep making sense in five
 * years. Disabling is the off switch, and it is immediate.
 */
@Injectable()
export class UserService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly devices: TrustedDeviceService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly tenants: TenantService,
  ) {}

  // ---------------------------------------------------------------- queries

  async rolesFor(tx: Tx, userId: string): Promise<RoleAssignment[]> {
    return tx.userBranchRole.findMany({
      where: { userId },
      select: { branchId: true, role: true },
      orderBy: [{ branchId: 'asc' }, { role: 'asc' }],
    });
  }

  rolesAtBranch(assignments: readonly RoleAssignment[], branchId: string): Role[] {
    return assignments.filter((a) => a.branchId === branchId).map((a) => a.role);
  }

  /** Users who are ACTIVE and hold ADMIN somewhere in the tenant (IAM-R-05). */
  async countActiveAdmins(tx: Tx, excludeUserId?: string): Promise<number> {
    const rows = await tx.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        branchRoles: { some: { role: Role.ADMIN } },
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
      select: { id: true },
    });
    return rows.length;
  }

  async list(tx: Tx, filter: UserListFilter): Promise<Page<UserSummary>> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.branchId || filter.role
        ? {
            branchRoles: {
              some: {
                ...(filter.branchId ? { branchId: filter.branchId } : {}),
                ...(filter.role ? { role: filter.role } : {}),
              },
            },
          }
        : {}),
      ...(filter.query
        ? {
            OR: [
              { name: { contains: filter.query } },
              { email: { contains: filter.query } },
              { phone: { contains: filter.query } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      tx.user.findMany({
        where,
        select: USER_SELECT,
        orderBy: [{ name: 'asc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      tx.user.count({ where }),
    ]);

    return toPage(rows.map(toSummary), total, filter.page, filter.pageSize);
  }

  async getOrThrow(tx: Tx, userId: string): Promise<UserSummary> {
    const user = await tx.user.findFirst({ where: { id: userId }, select: USER_SELECT });
    if (!user) throw new NotFoundError('User');
    return toSummary(user);
  }

  // ---------------------------------------------------------------- commands

  async create(
    ctx: TenantContext,
    input: {
      name: string;
      email: string;
      phone?: string | null;
      roles: RoleAssignment[];
      defaultBranchId?: string | null;
    },
  ): Promise<{ user: UserSummary; inviteLink: string; inviteExpiresAt: Date }> {
    const tx = this.db.tx();
    const email = assertEmail(input.email);
    const name = normaliseName(input.name);
    const phone = normalisePhone(input.phone);

    if (input.roles.length === 0) {
      throw new BadRequestError('Give the user at least one branch and role.', 'roles_required');
    }
    await this.assertBranchesExist(tx, input.roles.map((r) => r.branchId));

    const clash = await tx.user.findFirst({ where: { email }, select: { id: true } });
    if (clash) {
      throw new ConflictError('Someone already uses that email address.', 'email_taken');
    }

    const defaultBranchId = input.defaultBranchId ?? input.roles[0]!.branchId;
    if (!input.roles.some((r) => r.branchId === defaultBranchId)) {
      throw new BadRequestError(
        'The default branch must be one the user has a role at.',
        'invalid_default_branch',
      );
    }

    const userId = newId();
    await tx.user.create({
      data: {
        id: userId,
        tenantId: requireTenantId(),
        email,
        name,
        phone,
        status: UserStatus.INVITED,
        defaultBranchId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });
    await tx.userBranchRole.createMany({
      data: dedupeRoles(input.roles).map((r) => ({
        id: newId(),
        tenantId: requireTenantId(),
        userId,
        branchId: r.branchId,
        role: r.role,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })),
    });

    const invite = await this.tokens.issue(tx, {
      userId,
      purpose: TokenPurpose.INVITE,
      actorId: ctx.userId,
    });
    const user = await this.getOrThrow(tx, userId);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserCreated,
      entityType: 'user',
      entityId: userId,
      after: { email, name, phone, status: UserStatus.INVITED, roles: user.roles },
    });
    this.events.publish({
      name: DomainEvent.UserCreated,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, email },
    });

    // Network I/O never happens inside the transaction.
    this.db.afterCommit(() => {
      void this.mailer.sendInvite(email, name, invite.link, invite.expiresAt);
    });

    return { user, inviteLink: invite.link, inviteExpiresAt: invite.expiresAt };
  }

  async update(
    ctx: TenantContext,
    userId: string,
    input: { name?: string; phone?: string | null; defaultBranchId?: string | null },
  ): Promise<UserSummary> {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, userId);

    if (input.defaultBranchId) {
      if (!before.roles.some((r) => r.branchId === input.defaultBranchId)) {
        throw new BadRequestError(
          'The default branch must be one the user has a role at.',
          'invalid_default_branch',
        );
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        ...(input.name === undefined ? {} : { name: normaliseName(input.name) }),
        ...(input.phone === undefined ? {} : { phone: normalisePhone(input.phone) }),
        ...(input.defaultBranchId === undefined
          ? {}
          : { defaultBranchId: input.defaultBranchId }),
        updatedBy: ctx.userId,
      },
    });

    const after = await this.getOrThrow(tx, userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserUpdated,
      entityType: 'user',
      entityId: userId,
      before: { name: before.name, phone: before.phone, defaultBranchId: before.defaultBranchId },
      after: { name: after.name, phone: after.phone, defaultBranchId: after.defaultBranchId },
    });
    return after;
  }

  /** IAM-F-15: assignments are replaced wholesale, so the payload is the truth. */
  async replaceRoles(
    ctx: TenantContext,
    userId: string,
    roles: RoleAssignment[],
  ): Promise<UserSummary> {
    const tx = this.db.tx();
    await this.tenants.lockForUpdate(tx, ctx.tenantId);

    const before = await this.getOrThrow(tx, userId);
    if (roles.length === 0) {
      throw new BadRequestError('A user needs at least one branch and role.', 'roles_required');
    }
    await this.assertBranchesExist(tx, roles.map((r) => r.branchId));

    const next = dedupeRoles(roles);
    const losesAdmin =
      before.roles.some((r) => r.role === Role.ADMIN) && !next.some((r) => r.role === Role.ADMIN);
    if (losesAdmin && before.status === UserStatus.ACTIVE) {
      const others = await this.countActiveAdmins(tx, userId);
      if (others === 0) {
        throw new InvariantViolationError(
          'last_admin',
          'This is the clinic’s only administrator. Give someone else the ADMIN role first.',
        );
      }
    }

    // Apply the difference rather than deleting everything and writing it back.
    // Re-saving an unchanged set then touches no rows, which matters: the
    // last-administrator trigger fires on a DELETE of an ADMIN assignment, and
    // a delete-then-reinsert would trip it on the way past.
    const key = (r: RoleAssignment) => `${r.branchId}:${r.role}`;
    const beforeKeys = new Set(before.roles.map(key));
    const nextKeys = new Set(next.map(key));
    const removed = before.roles.filter((r) => !nextKeys.has(key(r)));
    const added = next.filter((r) => !beforeKeys.has(key(r)));

    if (removed.length > 0) {
      await tx.userBranchRole.deleteMany({
        where: { userId, OR: removed.map((r) => ({ branchId: r.branchId, role: r.role })) },
      });
    }
    if (added.length > 0) {
      await tx.userBranchRole.createMany({
        data: added.map((r) => ({
          id: newId(),
          tenantId: requireTenantId(),
          userId,
          branchId: r.branchId,
          role: r.role,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })),
      });
    }

    const changed = removed.length > 0 || added.length > 0;
    const keepsDefault =
      before.defaultBranchId && next.some((r) => r.branchId === before.defaultBranchId);
    if (changed || !keepsDefault) {
      await tx.user.update({
        where: { id: userId },
        data: {
          // IAM-R-04: bumping the version makes every live session reload its
          // permissions on its next request.
          ...(changed ? { permissionVersion: { increment: 1 } } : {}),
          ...(keepsDefault ? {} : { defaultBranchId: next[0]!.branchId }),
          updatedBy: ctx.userId,
        },
      });
    }

    const after = await this.getOrThrow(tx, userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserRoleChanged,
      entityType: 'user',
      entityId: userId,
      before: { roles: before.roles },
      after: { roles: after.roles },
    });
    this.events.publish({
      name: DomainEvent.UserRoleChanged,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, roles: after.roles },
    });
    return after;
  }

  async disable(ctx: TenantContext, userId: string, reason?: string): Promise<UserSummary> {
    const tx = this.db.tx();
    await this.tenants.lockForUpdate(tx, ctx.tenantId);

    // IAM-F-16: not even the last administrator can disable themselves.
    if (userId === ctx.userId) {
      throw new InvariantViolationError(
        'cannot_disable_self',
        'You cannot disable your own account. Ask another administrator.',
      );
    }

    const before = await this.getOrThrow(tx, userId);
    if (before.status === UserStatus.DISABLED) return before; // idempotent

    if (before.status === UserStatus.ACTIVE && before.roles.some((r) => r.role === Role.ADMIN)) {
      const others = await this.countActiveAdmins(tx, userId);
      if (others === 0) {
        throw new InvariantViolationError(
          'last_admin',
          'This is the clinic’s only active administrator. Appoint another one first.',
        );
      }
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        status: UserStatus.DISABLED,
        permissionVersion: { increment: 1 },
        updatedBy: ctx.userId,
      },
    });

    // Everything they hold stops working in the same transaction (IAM-F-13).
    const revoked = await this.sessions.revokeAllForUser(tx, userId, 'user_disabled');
    await this.devices.revokeAllForUser(tx, userId);
    await this.tokens.invalidateAllForUser(tx, userId);

    const after = await this.getOrThrow(tx, userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserDisabled,
      entityType: 'user',
      entityId: userId,
      before: { status: before.status },
      after: { status: after.status, sessionsRevoked: revoked },
      reason: reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.UserDisabled,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, sessionsRevoked: revoked },
    });
    return after;
  }

  async enable(ctx: TenantContext, userId: string): Promise<UserSummary> {
    const tx = this.db.tx();
    const before = await tx.user.findFirst({
      where: { id: userId },
      select: { ...USER_SELECT, passwordHash: true },
    });
    if (!before) throw new NotFoundError('User');
    if (before.status !== UserStatus.DISABLED) return toSummary(before);

    // Someone who never set a password goes back to INVITED, not ACTIVE.
    const status = before.passwordHash ? UserStatus.ACTIVE : UserStatus.INVITED;
    await tx.user.update({
      where: { id: userId },
      data: {
        status,
        failedAttempts: 0,
        lockedUntil: null,
        permissionVersion: { increment: 1 },
        updatedBy: ctx.userId,
      },
    });

    const after = await this.getOrThrow(tx, userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserEnabled,
      entityType: 'user',
      entityId: userId,
      before: { status: before.status },
      after: { status: after.status },
    });
    this.events.publish({
      name: DomainEvent.UserEnabled,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, status },
    });
    return after;
  }

  async unlock(ctx: TenantContext, userId: string): Promise<UserSummary> {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, userId);
    await tx.user.update({
      where: { id: userId },
      data: {
        failedAttempts: 0,
        lockedUntil: null,
        ...(before.status === UserStatus.LOCKED ? { status: UserStatus.ACTIVE } : {}),
        updatedBy: ctx.userId,
      },
    });
    const after = await this.getOrThrow(tx, userId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserUnlocked,
      entityType: 'user',
      entityId: userId,
      before: { status: before.status, lockedUntil: before.lockedUntil },
      after: { status: after.status, lockedUntil: null },
    });
    return after;
  }

  /** IAM-F-25: an administrator can sign anyone out of everywhere at once. */
  async revokeAllSessions(ctx: TenantContext, userId: string): Promise<number> {
    const tx = this.db.tx();
    await this.getOrThrow(tx, userId);
    const revoked = await this.sessions.revokeAllForUser(tx, userId, 'admin_revoked');
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.SessionRevoked,
      entityType: 'user',
      entityId: userId,
      after: { sessionsRevoked: revoked, scope: 'all' },
    });
    this.events.publish({
      name: DomainEvent.SessionRevoked,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, count: revoked },
    });
    return revoked;
  }

  async forcePasswordReset(
    ctx: TenantContext,
    userId: string,
  ): Promise<{ link: string; expiresAt: Date }> {
    const tx = this.db.tx();
    const user = await tx.user.findFirst({
      where: { id: userId },
      select: { id: true, email: true, name: true, status: true },
    });
    if (!user) throw new NotFoundError('User');
    if (user.status === UserStatus.DISABLED) {
      throw new ConflictError('Enable the account before resetting its password.', 'user_disabled');
    }

    const token = await this.tokens.issue(tx, {
      userId,
      purpose: TokenPurpose.RESET,
      actorId: ctx.userId,
    });
    const revoked = await this.sessions.revokeAllForUser(tx, userId, 'password_reset');

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserPasswordForceReset,
      entityType: 'user',
      entityId: userId,
      after: { sessionsRevoked: revoked, expiresAt: token.expiresAt },
    });

    this.db.afterCommit(() => {
      void this.mailer.sendPasswordReset(user.email, user.name, token.link, token.expiresAt);
    });
    return { link: token.link, expiresAt: token.expiresAt };
  }

  /**
   * Lost phone, no recovery codes (§14). The administrator verifies identity
   * out of band; the reset is audited and the user must enrol again at next
   * login.
   */
  async resetMfa(ctx: TenantContext, userId: string, reason?: string): Promise<void> {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, userId);
    await tx.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecretEnc: null,
        mfaRecoveryEnc: null,
        mfaEnrolledAt: null,
        updatedBy: ctx.userId,
      },
    });
    await this.devices.revokeAllForUser(tx, userId);
    const revoked = await this.sessions.revokeAllForUser(tx, userId, 'mfa_reset');

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.UserMfaReset,
      entityType: 'user',
      entityId: userId,
      before: { mfaEnabled: before.mfaEnabled },
      after: { mfaEnabled: false, sessionsRevoked: revoked },
      reason: reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.MfaDisabled,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { userId, by: 'admin' },
    });
  }

  private async assertBranchesExist(tx: Tx, branchIds: readonly string[]): Promise<void> {
    const unique = [...new Set(branchIds)];
    const found = await tx.branch.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      // Tenant scoping means a branch from another tenant simply is not found.
      throw new BadRequestError('One of those branches does not exist.', 'unknown_branch');
    }
  }
}

function dedupeRoles(roles: readonly RoleAssignment[]): RoleAssignment[] {
  const seen = new Map<string, RoleAssignment>();
  for (const r of roles) seen.set(`${r.branchId}:${r.role}`, r);
  return [...seen.values()];
}

function toSummary(row: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  defaultBranchId: string | null;
  branchRoles: Array<{ branchId: string; role: Role }>;
}): UserSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    lastLoginAt: row.lastLoginAt,
    lockedUntil: row.lockedUntil,
    defaultBranchId: row.defaultBranchId,
    roles: row.branchRoles.map((r) => ({ branchId: r.branchId, role: r.role })),
  };
}
