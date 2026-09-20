import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';

/**
 * Common passwords that survive a 12-character minimum. The bundled list is the
 * floor; the k-anonymity API is the ceiling. Keeping a local list means the
 * check still does something useful when the network call fails open.
 */
const BUNDLED_BREACHED = new Set(
  [
    '123456789012',
    '1234567890123',
    '12345678901234',
    '123456789012345',
    'qwertyuiop123',
    'qwertyuiopasdf',
    'passwordpassword',
    'password123456',
    'password1234',
    'Password1234',
    'Password123456',
    'passw0rdpassw0rd',
    'letmeinletmein',
    'iloveyouiloveyou',
    'administrator',
    'administrator1',
    'qwerty123456',
    'abcd1234abcd',
    'abcdefghijkl',
    'aaaaaaaaaaaa',
    'zxcvbnmasdfgh',
    '1qaz2wsx3edc',
    '1q2w3e4r5t6y',
    'welcome123456',
    'welcometoclinic',
    'clinic123456',
    'malaysia12345',
    'malaysiaboleh',
    'sayangkamu123',
    'letmein123456',
    'trustno1trustno1',
    'monkeymonkey',
    'football12345',
    'baseball12345',
    'dragondragon',
    'sunshine12345',
    'princess12345',
    'qazwsxedcrfv',
    'superman1234',
    'changemeplease',
    'temporary1234',
    'temppassword1',
    'newpassword12',
    'secretsecret1',
  ].map((p) => p.toLowerCase()),
);

@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * IAM-F-08. The remote check is k-anonymous: only the first five characters of
   * the SHA-1 hash leave the building, never the password.
   *
   * IAM-N-06: login availability is the system's availability, so this call has
   * a hard timeout and fails *open*. A clinic locked out of its own records
   * because a third-party API is slow is a worse outcome than a weak password.
   */
  async isBreached(password: string): Promise<boolean> {
    if (BUNDLED_BREACHED.has(password.toLowerCase())) return true;
    if (!this.config.breach.enabled) return false;

    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const response = await fetch(`${this.config.breach.apiUrl}/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'GementarClinicCare/0.1' },
        signal: AbortSignal.timeout(this.config.breach.timeoutMs),
      });
      if (!response.ok) return false;
      const body = await response.text();
      for (const line of body.split('\n')) {
        const [hashSuffix, countText] = line.trim().split(':');
        if (hashSuffix === suffix && Number(countText ?? '0') > 0) return true;
      }
      return false;
    } catch (error) {
      this.logger.warn(
        `Breached-password check unavailable, failing open: ${(error as Error).name}`,
      );
      return false;
    }
  }
}
