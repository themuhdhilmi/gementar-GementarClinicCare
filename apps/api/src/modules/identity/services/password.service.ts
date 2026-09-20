import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

/** `Algorithm.Argon2id`, spelled out because it is an ambient const enum. */
const ARGON2ID = 2 as Algorithm;
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { BreachedPasswordService } from './breached-password.service.js';

export type PasswordProblem =
  | 'too_short'
  | 'too_long'
  | 'matches_email'
  | 'matches_name'
  | 'breached'
  | 'whitespace_only';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const PROBLEM_MESSAGES: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters. Length beats symbols.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  matches_email: 'Your password cannot be your email address.',
  matches_name: 'Your password cannot be your own name.',
  breached:
    'This password appears in a public breach list, so attackers already try it. Choose another.',
  whitespace_only: 'That password is only spaces.',
};

/**
 * Argon2id hashing and the password policy (IAM-F-01, IAM-F-08).
 *
 * No composition rules: they push people towards `Password1!` and a sticky note.
 * Length plus a breach check is the current guidance and the better trade.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  private readonly logger = new Logger(PasswordService.name);
  /** A real hash to verify against when no user exists, for constant timing. */
  private readonly decoyHash: Promise<string>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly breached: BreachedPasswordService,
  ) {
    this.decoyHash = this.hash('decoy-password-for-timing-equalisation');
  }

  /**
   * IAM-N-02: the cost has to be right for the machine that runs it, and only
   * that machine can say. Timing one hash at startup turns a manual
   * benchmarking step into something every deployment reports for itself.
   *
   * 200–300 ms is the target: high enough to make offline cracking expensive,
   * low enough that a clinic signing in does not notice.
   */
  async onModuleInit(): Promise<void> {
    if (this.config.nodeEnv === 'test') return;

    const started = process.hrtime.bigint();
    await this.hash('cost-measurement-at-startup');
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const settings = `${this.config.argon2.memoryCost} KiB, ${this.config.argon2.timeCost} iterations`;

    if (ms < 150) {
      this.logger.warn(
        `Password hashing takes ${ms} ms on this host (${settings}), below the 200–300 ms ` +
          'target. Run `npm run measure:argon2` here and raise ARGON2_ITERATIONS.',
      );
    } else if (ms > 400) {
      this.logger.warn(
        `Password hashing takes ${ms} ms on this host (${settings}), above the 200–300 ms ` +
          'target. Sign-in will feel slow; lower ARGON2_ITERATIONS.',
      );
    } else {
      this.logger.log(`Password hashing takes ${ms} ms on this host (${settings}).`);
    }
  }

  private get options() {
    return {
      algorithm: ARGON2ID,
      memoryCost: this.config.argon2.memoryCost,
      timeCost: this.config.argon2.timeCost,
      parallelism: this.config.argon2.parallelism,
    };
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain, this.options);
    } catch {
      return false;
    }
  }

  /**
   * IAM-R-07: an unknown email must cost the same as a wrong password, or the
   * response time becomes a user-enumeration oracle.
   */
  async burnTime(plain: string): Promise<void> {
    try {
      await verify(await this.decoyHash, plain, this.options);
    } catch {
      /* ignore */
    }
  }

  /** True when the stored hash was made with weaker parameters than today's policy. */
  needsRehash(hashed: string): boolean {
    try {
      const parsed = parseOptions(hashed);
      return (
        parsed.algorithm !== ARGON2ID ||
        parsed.memoryCost < this.config.argon2.memoryCost ||
        parsed.timeCost < this.config.argon2.timeCost
      );
    } catch {
      return true;
    }
  }

  async validate(
    plain: string,
    context: { email?: string; name?: string } = {},
  ): Promise<{ ok: boolean; problems: PasswordProblem[]; messages: string[] }> {
    const problems: PasswordProblem[] = [];

    if (plain.trim().length === 0) problems.push('whitespace_only');
    if (plain.length < PASSWORD_MIN_LENGTH) problems.push('too_short');
    if (plain.length > PASSWORD_MAX_LENGTH) problems.push('too_long');
    if (context.email && plain.trim().toLowerCase() === context.email.trim().toLowerCase()) {
      problems.push('matches_email');
    }
    if (context.name && plain.trim().toLowerCase() === context.name.trim().toLowerCase()) {
      problems.push('matches_name');
    }

    if (problems.length === 0 && (await this.breached.isBreached(plain))) {
      problems.push('breached');
    }

    return {
      ok: problems.length === 0,
      problems,
      messages: problems.map((p) => PROBLEM_MESSAGES[p]),
    };
  }
}
