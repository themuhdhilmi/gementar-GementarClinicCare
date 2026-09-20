import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service.js';
import { loadAppConfig, type AppConfig } from '../../config/app-config.js';

function testConfig(): AppConfig {
  return loadAppConfig({
    DATABASE_URL: 'mysql://u:p@localhost:3306/db',
    APP_KEK_V1: randomBytes(32).toString('base64'),
    APP_KEK_V2: randomBytes(32).toString('base64'),
    APP_HASH_PEPPER: randomBytes(32).toString('base64'),
  } as NodeJS.ProcessEnv);
}

describe('CryptoService', () => {
  let crypto: CryptoService;
  let config: AppConfig;

  beforeAll(() => {
    config = testConfig();
    crypto = new CryptoService(config);
  });

  it('round-trips a secret', () => {
    const blob = crypto.encrypt('JBSWY3DPEHPK3PXP', 'mfa-secret:user-1');
    expect(Buffer.from(blob).toString('utf8')).not.toContain('JBSWY3DPEHPK3PXP');
    expect(crypto.decrypt(blob, 'mfa-secret:user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses to decrypt under a different label, so a blob cannot be moved between users', () => {
    const blob = crypto.encrypt('secret-value', 'mfa-secret:user-1');
    expect(() => crypto.decrypt(blob, 'mfa-secret:user-2')).toThrow();
  });

  it('detects tampering', () => {
    const blob = crypto.encrypt('secret-value', 'mfa-secret:user-1');
    blob[blob.length - 1] ^= 0xff;
    expect(() => crypto.decrypt(blob, 'mfa-secret:user-1')).toThrow();
  });

  it('can still read ciphertext written under an older key after rotation', () => {
    const old = crypto.encrypt('written-under-v1', 'aad');
    const rotated = new CryptoService({ ...config, crypto: { ...config.crypto, activeKekId: 'v2' } });
    expect(rotated.decrypt(old, 'aad')).toBe('written-under-v1');
    const fresh = rotated.encrypt('written-under-v2', 'aad');
    expect(crypto.decrypt(fresh, 'aad')).toBe('written-under-v2');
  });

  it('produces 256-bit tokens and stable hashes', () => {
    const token = crypto.randomToken(32);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(crypto.sha256(token)).toHaveLength(32);
    expect(crypto.equals(crypto.sha256(token), crypto.sha256(token))).toBe(true);
    expect(crypto.equals(crypto.sha256(token), crypto.sha256('other'))).toBe(false);
  });

  it('peppers recovery-code hashes with a key outside the database', () => {
    const other = new CryptoService(testConfig());
    expect(crypto.peppered('ABCDE-12345')).not.toEqual(other.peppered('ABCDE-12345'));
    expect(crypto.peppered('ABCDE-12345')).toEqual(crypto.peppered('ABCDE-12345'));
  });

  it('emits base32 without padding, in the RFC 4648 alphabet', () => {
    const secret = crypto.randomBase32(20);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});
