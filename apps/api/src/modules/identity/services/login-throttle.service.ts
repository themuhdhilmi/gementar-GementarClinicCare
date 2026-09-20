import { Inject, Injectable } from '@nestjs/common';
import { LoginOutcome } from '../../../generated/prisma/enums.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { Clock } from '../../../shared/time/clock.js';
import { newId } from '../../../shared/ids/uuid.js';
import type { Tx } from '../../../shared/prisma/db.service.js';

const FAILURE_OUTCOMES = [
  LoginOutcome.BAD_CREDENTIALS,
  LoginOutcome.UNKNOWN_EMAIL,
  LoginOutcome.AMBIGUOUS_EMAIL,
  LoginOutcome.NOT_LOGINABLE,
  LoginOutcome.MFA_FAILED,
];

export type ThrottleDecision = { limited: false } | { limited: true; retryAfterSeconds: number };

/**
 * Login rate limiting (IAM-F-05), stored in MySQL rather than memory.
 *
 * Memory would be faster and would also reset every deploy, which is exactly
 * when an attacker benefits. The table is small, indexed on the two windows it
 * is queried by, and swept nightly.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async check(tx: Tx, emailKey: string, ip: string | null): Promise<ThrottleDecision> {
    const windowMinutes = this.config.login.rateWindowMinutes;
    const since = this.clock.agoMinutes(windowMinutes);

    const [emailFailures, ipFailures] = await Promise.all([
      tx.loginAttempt.findMany({
        where: { emailKey, outcome: { in: FAILURE_OUTCOMES }, attemptedAt: { gt: since } },
        select: { attemptedAt: true },
        orderBy: { attemptedAt: 'asc' },
      }),
      ip
        ? tx.loginAttempt.findMany({
            where: { ip, outcome: { in: FAILURE_OUTCOMES }, attemptedAt: { gt: since } },
            select: { attemptedAt: true },
            orderBy: { attemptedAt: 'asc' },
          })
        : Promise.resolve([] as Array<{ attemptedAt: Date }>),
    ]);

    const breaches: Array<{ oldest: Date }> = [];
    if (emailFailures.length >= this.config.login.maxFailuresPerEmail) {
      breaches.push({ oldest: emailFailures[0]!.attemptedAt });
    }
    if (ip && ipFailures.length >= this.config.login.maxFailuresPerIp) {
      breaches.push({ oldest: ipFailures[0]!.attemptedAt });
    }
    if (breaches.length === 0) return { limited: false };

    // Retry when the oldest failure in the window ages out.
    const soonest = Math.min(...breaches.map((b) => b.oldest.getTime()));
    const retryAt = soonest + windowMinutes * 60_000;
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - this.clock.now().getTime()) / 1000));
    return { limited: true, retryAfterSeconds };
  }

  async record(
    tx: Tx,
    input: {
      emailKey: string;
      ip: string | null;
      userAgent: string | null;
      outcome: LoginOutcome;
      tenantId?: string | null;
      userId?: string | null;
    },
  ): Promise<void> {
    await tx.loginAttempt.create({
      data: {
        id: newId(),
        emailKey: input.emailKey.slice(0, 254),
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
        outcome: input.outcome,
        tenantId: input.tenantId ?? null,
        userId: input.userId ?? null,
        attemptedAt: this.clock.now(),
      },
    });
  }

  async countFailuresSince(tx: Tx, since: Date, tenantId?: string): Promise<number> {
    return tx.loginAttempt.count({
      where: {
        outcome: { in: FAILURE_OUTCOMES },
        attemptedAt: { gt: since },
        ...(tenantId ? { tenantId } : {}),
      },
    });
  }
}
