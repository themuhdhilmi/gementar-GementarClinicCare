import { Inject, Injectable } from '@nestjs/common';
import { TokenPurpose } from '../../../generated/prisma/enums.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { CryptoService } from '../../../shared/crypto/crypto.service.js';
import { Clock } from '../../../shared/time/clock.js';
import { newId } from '../../../shared/ids/uuid.js';
import type { Tx } from '../../../shared/prisma/db.service.js';
import { requireTenantId } from '../../../shared/prisma/tenant-scope.js';

export type IssuedToken = {
  id: string;
  token: string;
  expiresAt: Date;
  link: string;
};

/**
 * Single-use invite and reset tokens (IAM-F-07, IAM-F-12). Only the hash is
 * stored, so a database dump cannot be replayed into account takeover.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
  ) {}

  /**
   * @param tenantId Only passed by callers running in platform scope, such as
   *   the seed script; inside a request it comes from the open scope.
   */
  async issue(
    tx: Tx,
    params: { userId: string; purpose: TokenPurpose; actorId?: string; tenantId?: string },
  ): Promise<IssuedToken> {
    const { userId, purpose, actorId } = params;
    const token = this.crypto.randomToken(32);
    const expiresAt =
      purpose === TokenPurpose.INVITE
        ? this.clock.inHours(this.config.invite.expiryHours)
        : this.clock.inMinutes(this.config.reset.expiryMinutes);

    const row = await tx.passwordResetToken.create({
      data: {
        id: newId(),
        tenantId: params.tenantId ?? requireTenantId(),
        userId,
        tokenHash: this.crypto.sha256(token),
        purpose,
        expiresAt,
        createdBy: actorId ?? null,
      },
      select: { id: true },
    });

    const path = purpose === TokenPurpose.INVITE ? 'set-password' : 'reset-password';
    return {
      id: row.id,
      token,
      expiresAt,
      link: `${this.config.appBaseUrl}/${path}?token=${encodeURIComponent(token)}`,
    };
  }

  /** Looks a token up across tenants: the holder of a reset link has no session. */
  async findUsable(tx: Tx, token: string) {
    const now = this.clock.now();
    return tx.passwordResetToken.findFirst({
      where: { tokenHash: this.crypto.sha256(token), usedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        purpose: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Consumes the token. The `usedAt: null` condition in the update is what makes
   * it single-use even if two requests arrive at once: the second updates zero
   * rows.
   */
  async consume(tx: Tx, tokenId: string): Promise<boolean> {
    const result = await tx.passwordResetToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: this.clock.now() },
    });
    return result.count === 1;
  }

  /** Invalidates outstanding tokens, e.g. once a password has been changed. */
  async invalidateAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: this.clock.now() },
    });
  }

  async countRecentForUser(tx: Tx, userId: string, sinceMinutes: number): Promise<number> {
    return tx.passwordResetToken.count({
      where: { userId, createdAt: { gt: this.clock.agoMinutes(sinceMinutes) } },
    });
  }
}
