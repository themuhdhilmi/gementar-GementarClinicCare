import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';
import { BreachedPasswordService } from './breached-password.service.js';
import { loadAppConfig, type AppConfig } from '../../../config/app-config.js';

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadAppConfig({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    APP_KEK_V1: randomBytes(32).toString('base64'),
    APP_HASH_PEPPER: randomBytes(32).toString('base64'),
    // Keep the unit suite fast; the algorithm is the same at any work factor.
    ARGON2_MEMORY_KIB: '8192',
    ARGON2_ITERATIONS: '1',
    BREACH_CHECK_ENABLED: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

describe('PasswordService', () => {
  let service: PasswordService;
  let config: AppConfig;

  beforeAll(() => {
    config = testConfig();
    service = new PasswordService(config, new BreachedPasswordService(config));
  });

  it('hashes with Argon2id and verifies', async () => {
    const hash = await service.hash('a-perfectly-fine-passphrase');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await service.verify(hash, 'a-perfectly-fine-passphrase')).toBe(true);
    expect(await service.verify(hash, 'a-perfectly-fine-passphrasE')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [one, two] = await Promise.all([service.hash('same-password-here'), service.hash('same-password-here')]);
    expect(one).not.toBe(two);
  });

  it('never throws on a malformed stored hash', async () => {
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
  });

  it('spots a hash made with weaker parameters than today’s policy', async () => {
    const weak = new PasswordService(
      testConfig({ ARGON2_MEMORY_KIB: '8192', ARGON2_ITERATIONS: '1' }),
      new BreachedPasswordService(config),
    );
    const oldHash = await weak.hash('passphrase-from-last-year');

    const stronger = new PasswordService(
      testConfig({ ARGON2_MEMORY_KIB: '65536', ARGON2_ITERATIONS: '3' }),
      new BreachedPasswordService(config),
    );
    expect(stronger.needsRehash(oldHash)).toBe(true);
    expect(weak.needsRehash(oldHash)).toBe(false);
  });

  it('enforces length, and nothing about composition', async () => {
    expect((await service.validate('short')).problems).toContain('too_short');
    expect((await service.validate('x'.repeat(129))).problems).toContain('too_long');
    // No uppercase, no digit, no symbol, and perfectly acceptable.
    expect((await service.validate('correct horse battery staple')).ok).toBe(true);
  });

  it('refuses a password that is the account’s own email or name', async () => {
    const byEmail = await service.validate('siti.aminah@klinik.my', {
      email: 'siti.aminah@klinik.my',
    });
    expect(byEmail.problems).toContain('matches_email');

    const byName = await service.validate('Doctor Siti Aminah', { name: 'Doctor Siti Aminah' });
    expect(byName.problems).toContain('matches_name');
  });

  it('rejects known-breached passwords from the bundled list even with the API off', async () => {
    const result = await service.validate('passwordpassword');
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('breached');
    // The message explains why, rather than reciting a rule.
    expect(result.messages.join(' ')).toMatch(/breach/i);
  });

  it('burns comparable time for an account that does not exist', async () => {
    const hash = await service.hash('a-real-password-value');
    const realStart = performance.now();
    await service.verify(hash, 'wrong-password-value');
    const realMs = performance.now() - realStart;

    const decoyStart = performance.now();
    await service.burnTime('wrong-password-value');
    const decoyMs = performance.now() - decoyStart;

    // Same order of magnitude is the property that matters.
    expect(decoyMs).toBeGreaterThan(realMs / 5);
  });
});
