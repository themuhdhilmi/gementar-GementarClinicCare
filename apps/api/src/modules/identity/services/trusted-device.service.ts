import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { CryptoService } from '../../../shared/crypto/crypto.service.js';
import { Clock } from '../../../shared/time/clock.js';
import { newId } from '../../../shared/ids/uuid.js';
import type { Tx } from '../../../shared/prisma/db.service.js';
import { requireTenantId } from '../../../shared/prisma/tenant-scope.js';

/**
 * "Remember this device" for MFA (IAM-F-10). A device token skips the *second*
 * factor, never the first: a password is still required on every login.
 */
@Injectable()
export class TrustedDeviceService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
  ) {}

  async issue(
    tx: Tx,
    userId: string,
    label: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = this.crypto.randomToken(32);
    const expiresAt = this.clock.inDays(this.config.session.trustedDeviceDays);
    await tx.trustedDevice.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        userId,
        tokenHash: this.crypto.sha256(token),
        label: label?.slice(0, 200) ?? null,
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  async isTrusted(tx: Tx, userId: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const device = await tx.trustedDevice.findFirst({
      where: {
        tokenHash: this.crypto.sha256(token),
        userId,
        revokedAt: null,
        expiresAt: { gt: this.clock.now() },
      },
      select: { id: true },
    });
    if (!device) return false;
    await tx.trustedDevice.updateMany({
      where: { id: device.id },
      data: { lastSeenAt: this.clock.now() },
    });
    return true;
  }

  async revokeAllForUser(tx: Tx, userId: string): Promise<number> {
    const result = await tx.trustedDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    return result.count;
  }
}
