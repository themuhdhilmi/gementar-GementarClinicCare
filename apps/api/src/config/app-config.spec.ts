import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from './app-config.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  APP_KEK_V1: randomBytes(32).toString('base64'),
  APP_HASH_PEPPER: randomBytes(32).toString('base64'),
} as NodeJS.ProcessEnv;

describe('configuration', () => {
  it('loads with sensible defaults', () => {
    const config = loadAppConfig(base);
    expect(config.session.idleMinutes).toBe(720);
    expect(config.session.absoluteHours).toBe(168);
    expect(config.login.lockoutThreshold).toBe(10);
    expect(config.argon2.memoryCost).toBe(65536);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => loadAppConfig({ ...base, APP_KEK_V1: 'dG9vLXNob3J0' })).toThrow(/32 bytes/);
  });

  it('refuses an active key id with no key behind it', () => {
    expect(() => loadAppConfig({ ...base, APP_KEK_ACTIVE: 'v2' })).toThrow(/no matching key/);
  });

  it('refuses insecure cookies in production', () => {
    expect(() =>
      loadAppConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false', MAIL_TRANSPORT: 'noop' }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('refuses the console mail transport in production, since it logs links', () => {
    expect(() =>
      loadAppConfig({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        MAIL_TRANSPORT: 'console',
      }),
    ).toThrow(/writes password links to the log/);
  });

  it('refuses to start with no database url', () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = base;
    expect(() => loadAppConfig(withoutUrl as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});
