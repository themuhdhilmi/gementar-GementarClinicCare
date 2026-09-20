import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { CryptoService } from '../../../shared/crypto/crypto.service.js';
import { Clock } from '../../../shared/time/clock.js';
import { newId } from '../../../shared/ids/uuid.js';
import type { Tx } from '../../../shared/prisma/db.service.js';
import { requireTenantId } from '../../../shared/prisma/tenant-scope.js';

export type NewSession = { id: string; token: string; expiresAt: Date };

export type SessionRevokeReason =
  | 'logout'
  | 'user_request'
  | 'admin_revoked'
  | 'password_changed'
  | 'password_reset'
  | 'user_disabled'
  | 'mfa_reset'
  | 'expired_idle'
  | 'expired_absolute'
  | 'replaced';

/**
 * Server-side sessions (IAM-F-02, IAM-F-26). Opaque 256-bit token in the
 * cookie, SHA-256 of it in the database: a stolen database gives an attacker
 * nothing to present back. No JWTs, because "log this person out now" is a
 * feature the clinic will actually use.
 *
 * Stored in PostgreSQL, not Redis. Revisit only when session lookup shows up
 * in a latency measurement, not before.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
  ) {}

  async create(
    tx: Tx,
    input: {
      userId: string;
      activeBranchId: string;
      permissionVersion: number;
      mfaVerified: boolean;
      reauthAt?: Date | null;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<NewSession> {
    const token = this.crypto.randomToken(32);
    const now = this.clock.now();
    const expiresAt = this.clock.inHours(this.config.session.absoluteHours, now);

    const session = await tx.session.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        userId: input.userId,
        tokenHash: this.crypto.sha256(token),
        activeBranchId: input.activeBranchId,
        permissionVersion: input.permissionVersion,
        mfaVerified: input.mfaVerified,
        reauthAt: input.reauthAt ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
      select: { id: true },
    });

    return { id: session.id, token, expiresAt };
  }

  /**
   * Looks a session up by its token hash. Runs before the tenant is known, so
   * the caller opens a platform scope; the unique index on `token_hash` keeps
   * this to a single row read (IAM-N-01).
   */
  async findByToken(tx: Tx, token: string) {
    return tx.session.findFirst({
      where: { tokenHash: this.crypto.sha256(token) },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        activeBranchId: true,
        permissionVersion: true,
        mfaVerified: true,
        reauthAt: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
            permissionVersion: true,
            mfaEnabled: true,
            tenant: { select: { id: true, status: true, name: true, slug: true } },
          },
        },
      },
    });
  }

  /** IAM-F-03: idle timeout, measured from the last request this session made. */
  isIdleExpired(lastSeenAt: Date, now = this.clock.now()): boolean {
    return lastSeenAt.getTime() + this.config.session.idleMinutes * 60_000 <= now.getTime();
  }

  needsTouch(lastSeenAt: Date, now = this.clock.now()): boolean {
    return now.getTime() - lastSeenAt.getTime() >= this.config.session.touchIntervalSeconds * 1000;
  }

  async touch(tx: Tx, sessionId: string, permissionVersion?: number): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: {
        lastSeenAt: this.clock.now(),
        ...(permissionVersion === undefined ? {} : { permissionVersion }),
      },
    });
  }

  async markMfaVerified(tx: Tx, sessionId: string, reauthAt?: Date | null): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { mfaVerified: true, ...(reauthAt === undefined ? {} : { reauthAt }) },
    });
  }

  async markReauthenticated(tx: Tx, sessionId: string): Promise<Date> {
    const at = this.clock.now();
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { reauthAt: at },
    });
    return at;
  }

  async setActiveBranch(tx: Tx, sessionId: string, branchId: string): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { activeBranchId: branchId },
    });
  }

  /**
   * IAM-F-04: logout destroys the session here, not in the browser, so a
   * copied cookie stops working too.
   *
   * Idempotent: revoking an already-revoked session is a no-op, not an error.
   */
  async revoke(tx: Tx, sessionId: string, reason: SessionRevokeReason): Promise<number> {
    const result = await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  async revokeAllForUser(
    tx: Tx,
    userId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  async listActiveForUser(tx: Tx, userId: string) {
    const now = this.clock.now();
    return tx.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        activeBranchId: true,
        mfaVerified: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  async findOwnedById(tx: Tx, userId: string, sessionId: string) {
    return tx.session.findFirst({
      where: { id: sessionId, userId },
      select: { id: true, revokedAt: true },
    });
  }
}
