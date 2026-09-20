import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../shared/prisma/db.service.js';
import { Clock } from '../../shared/time/clock.js';

const SESSION_RETENTION_DAYS = 30;
const TOKEN_RETENTION_DAYS = 30;
const ATTEMPT_RETENTION_DAYS = 90;

/**
 * IAM-N-03. Nightly, quietly, in one platform-scoped transaction. Rows are
 * deleted only once they can no longer affect a decision: an expired session
 * cannot authenticate, a used token cannot be replayed.
 */
@Injectable()
export class IdentityCleanupJob {
  private readonly logger = new Logger(IdentityCleanupJob.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  @Cron('15 19 * * *', { name: 'identity-cleanup' }) // 03:15 Asia/Kuala_Lumpur
  async run(): Promise<{ sessions: number; tokens: number; attempts: number; replays: number }> {
    const result = await this.db.withPlatform('nightly identity cleanup', async (tx) => {
      const now = this.clock.now();
      const sessions = await tx.session.deleteMany({
        where: { expiresAt: { lt: this.clock.agoDays(SESSION_RETENTION_DAYS, now) } },
      });
      const tokens = await tx.passwordResetToken.deleteMany({
        where: { expiresAt: { lt: this.clock.agoDays(TOKEN_RETENTION_DAYS, now) } },
      });
      const attempts = await tx.loginAttempt.deleteMany({
        where: { attemptedAt: { lt: this.clock.agoDays(ATTEMPT_RETENTION_DAYS, now) } },
      });
      const replays = await tx.mfaReplay.deleteMany({ where: { expiresAt: { lt: now } } });
      const devices = await tx.trustedDevice.deleteMany({
        where: { expiresAt: { lt: this.clock.agoDays(TOKEN_RETENTION_DAYS, now) } },
      });
      return {
        sessions: sessions.count,
        tokens: tokens.count,
        attempts: attempts.count,
        replays: replays.count,
        devices: devices.count,
      };
    });

    this.logger.log(
      `identity cleanup: ${result.sessions} sessions, ${result.tokens} tokens, ` +
        `${result.attempts} login attempts, ${result.replays} replay rows, ${result.devices} devices`,
    );
    return result;
  }
}
