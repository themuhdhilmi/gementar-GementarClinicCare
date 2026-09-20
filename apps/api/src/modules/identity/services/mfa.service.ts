import { Injectable, Logger } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import { toDataURL } from 'qrcode';
import { CryptoService } from '../../../shared/crypto/crypto.service.js';
import { Clock } from '../../../shared/time/clock.js';
import { newId } from '../../../shared/ids/uuid.js';
import type { Tx } from '../../../shared/prisma/db.service.js';
import { requireTenantId } from '../../../shared/prisma/tenant-scope.js';

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // ±1 step, for clock skew (IAM-F-12 validation notes)
const RECOVERY_CODE_COUNT = 10;
const REPLAY_RETENTION_MINUTES = 5;

export type EnrolmentOffer = {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
  /** True when an enrolment already in progress was picked up again. */
  reused: boolean;
};

type StoredRecoveryCodes = { codes: Array<{ hash: string; usedAt: string | null }> };

function aadForSecret(userId: string): string {
  return `mfa-secret:${userId}`;
}

function aadForRecovery(userId: string): string {
  return `mfa-recovery:${userId}`;
}

/**
 * TOTP multi-factor (IAM-F-09). Secrets and recovery codes are encrypted with a
 * key held outside the database (IAM-R-08), and each accepted code is recorded
 * so it cannot be replayed inside its own window.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
  ) {}

  private totp(secret: string, label: string, issuer: string): TOTP {
    return new TOTP({
      issuer,
      label,
      algorithm: 'SHA1',
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(secret),
    });
  }

  /**
   * Step 1 of enrolment: offer a secret. Nothing is enabled until it is
   * confirmed.
   *
   * An enrolment already in progress keeps its secret. Reloading the page
   * used to mint a new one, which silently invalidated the QR code the person
   * had just scanned and rejected every code they typed afterwards.
   */
  async offerEnrolment(
    tx: Tx,
    user: { id: string; email: string; mfaEnabled: boolean; mfaSecretEnc: Uint8Array | null },
    issuer: string,
  ): Promise<EnrolmentOffer> {
    const pending = user.mfaEnabled ? null : this.readSecret(user.id, user.mfaSecretEnc);
    const secret = pending ?? this.crypto.randomBase32(20); // 160-bit, per RFC 4226

    if (!pending) await this.storePendingSecret(tx, user.id, secret);

    const uri = this.totp(secret, user.email, issuer).toString();
    return {
      secret,
      otpauthUri: uri,
      qrDataUrl: await toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 }),
      reused: pending !== null,
    };
  }

  private async storePendingSecret(tx: Tx, userId: string, secret: string): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        mfaSecretEnc: this.crypto.encrypt(secret, aadForSecret(userId)),
        mfaEnabled: false,
        mfaEnrolledAt: null,
      },
    });

    // The replay cache is keyed on the user and the time step, not on the
    // secret, so entries from the previous secret would refuse a perfectly
    // good code from this one. That matters in the flow it is most likely to
    // happen in: a lost phone, reset and re-enrolled inside the same minute.
    await tx.mfaReplay.deleteMany({ where: { userId } });
  }

  private readSecret(userId: string, blob: Uint8Array | null): string | null {
    if (!blob) return null;
    try {
      return this.crypto.decrypt(blob, aadForSecret(userId));
    } catch (error) {
      this.logger.error(`Unable to decrypt MFA secret for user ${userId}`, error as Error);
      return null;
    }
  }

  /**
   * Verifies a TOTP code and burns it. Two requests carrying the same code, even
   * inside the same 30-second window, cannot both succeed (IAM-T-10).
   */
  async verifyTotp(
    tx: Tx,
    user: { id: string; email: string; mfaSecretEnc: Uint8Array | null },
    code: string,
    issuer: string,
  ): Promise<boolean> {
    const secret = this.readSecret(user.id, user.mfaSecretEnc);
    if (!secret) return false;

    const normalised = code.replace(/\D/g, '');
    if (normalised.length !== DIGITS) return false;

    const delta = this.totp(secret, user.email, issuer).validate({
      token: normalised,
      window: WINDOW,
    });
    if (delta === null) return false;

    const now = this.clock.now();
    const step = BigInt(Math.floor(now.getTime() / 1000 / PERIOD_SECONDS) + delta);

    // Claim this time step. `skipDuplicates` turns the race into a row count
    // rather than an exception: on PostgreSQL a failed statement aborts the
    // whole transaction, so catching a unique violation and carrying on would
    // poison every query after it.
    const claimed = await tx.mfaReplay.createMany({
      data: [
        {
          id: newId(),
          tenantId: requireTenantId(),
          userId: user.id,
          timeStep: step,
          expiresAt: this.clock.inMinutes(REPLAY_RETENTION_MINUTES, now),
        },
      ],
      skipDuplicates: true,
    });

    // Zero rows means this code was already accepted inside its window.
    return claimed.count === 1;
  }

  /** Step 2 of enrolment: the first correct code turns MFA on and issues recovery codes. */
  async confirmEnrolment(
    tx: Tx,
    user: { id: string; email: string; mfaSecretEnc: Uint8Array | null },
    code: string,
    issuer: string,
  ): Promise<string[] | null> {
    const ok = await this.verifyTotp(tx, user, code, issuer);
    if (!ok) return null;

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.formatRecoveryCode());
    const stored: StoredRecoveryCodes = {
      codes: codes.map((c) => ({ hash: this.hashRecovery(c), usedAt: null })),
    };

    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaEnrolledAt: this.clock.now(),
        mfaRecoveryEnc: this.crypto.encrypt(JSON.stringify(stored), aadForRecovery(user.id)),
      },
    });
    return codes;
  }

  async verifyRecoveryCode(
    tx: Tx,
    user: { id: string; mfaRecoveryEnc: Uint8Array | null },
    code: string,
  ): Promise<boolean> {
    if (!user.mfaRecoveryEnc) return false;
    let stored: StoredRecoveryCodes;
    try {
      stored = JSON.parse(
        this.crypto.decrypt(user.mfaRecoveryEnc, aadForRecovery(user.id)),
      ) as StoredRecoveryCodes;
    } catch (error) {
      this.logger.error(`Unable to decrypt recovery codes for user ${user.id}`, error as Error);
      return false;
    }

    const candidate = this.hashRecovery(code);
    const match = stored.codes.find(
      (c) =>
        c.usedAt === null &&
        this.crypto.equals(Buffer.from(c.hash, 'hex'), Buffer.from(candidate, 'hex')),
    );
    if (!match) return false;

    match.usedAt = this.clock.now().toISOString();
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaRecoveryEnc: this.crypto.encrypt(JSON.stringify(stored), aadForRecovery(user.id)),
      },
    });
    return true;
  }

  async remainingRecoveryCodes(user: { id: string; mfaRecoveryEnc: Uint8Array | null }): Promise<number> {
    if (!user.mfaRecoveryEnc) return 0;
    try {
      const stored = JSON.parse(
        this.crypto.decrypt(user.mfaRecoveryEnc, aadForRecovery(user.id)),
      ) as StoredRecoveryCodes;
      return stored.codes.filter((c) => c.usedAt === null).length;
    } catch {
      return 0;
    }
  }

  async disable(tx: Tx, userId: string): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecretEnc: null,
        mfaRecoveryEnc: null,
        mfaEnrolledAt: null,
      },
    });
  }

  private formatRecoveryCode(): string {
    const raw = this.crypto.randomBase32(7).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  }

  private hashRecovery(code: string): string {
    const normalised = code.trim().toUpperCase().replace(/[^A-Z2-7]/g, '');
    return Buffer.from(this.crypto.peppered(normalised)).toString('hex');
  }
}
