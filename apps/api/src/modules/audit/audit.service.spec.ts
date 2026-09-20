import { describe, expect, it } from 'vitest';
import { redact, shallowDiff } from './audit.service.js';

describe('audit redaction', () => {
  it('removes anything that looks like a credential, at any depth', () => {
    const entry = redact({
      email: 'siti@klinik.my',
      passwordHash: '$argon2id$v=19$...',
      password: 'hunter2000000',
      nested: { tokenHash: 'abc', mfaSecretEnc: 'xyz', keep: 'visible' },
      recoveryCodes: ['AAAAA-BBBBB'],
    }) as Record<string, unknown>;

    expect(entry['email']).toBe('siti@klinik.my');
    expect(entry['passwordHash']).toBe('[redacted]');
    expect(entry['password']).toBe('[redacted]');
    expect(entry['recoveryCodes']).toBe('[redacted]');
    expect((entry['nested'] as Record<string, unknown>)['tokenHash']).toBe('[redacted]');
    expect((entry['nested'] as Record<string, unknown>)['mfaSecretEnc']).toBe('[redacted]');
    expect((entry['nested'] as Record<string, unknown>)['keep']).toBe('visible');
  });

  it('never writes raw bytes into the trail', () => {
    const entry = redact({ blob: Buffer.from('secret') }) as Record<string, unknown>;
    expect(entry['blob']).toBe('[redacted]');
  });

  it('renders dates and bigints in a form JSON can hold', () => {
    const entry = redact({ at: new Date('2026-03-01T00:00:00Z'), step: 10n }) as Record<string, unknown>;
    expect(entry['at']).toBe('2026-03-01T00:00:00.000Z');
    expect(entry['step']).toBe('10');
  });
});

describe('audit diff', () => {
  it('records what changed, from and to', () => {
    expect(shallowDiff({ name: 'A', phone: null }, { name: 'B', phone: null })).toEqual({
      name: { from: 'A', to: 'B' },
    });
  });

  it('is null when nothing changed', () => {
    expect(shallowDiff({ name: 'A' }, { name: 'A' })).toBeNull();
    expect(shallowDiff(null, { name: 'A' })).toBeNull();
  });
});
