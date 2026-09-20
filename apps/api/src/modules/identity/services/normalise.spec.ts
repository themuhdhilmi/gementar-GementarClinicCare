import { describe, expect, it } from 'vitest';
import { assertEmail, normaliseEmail, normaliseName, normalisePhone } from './normalise.js';

describe('input normalisation', () => {
  it('lower-cases and trims email addresses', () => {
    expect(normaliseEmail('  Siti@Klinik.MY ')).toBe('siti@klinik.my');
    expect(assertEmail('Siti+rota@klinik.my')).toBe('siti+rota@klinik.my');
  });

  it('rejects addresses that are not addresses', () => {
    for (const bad of ['siti', 'siti@', '@klinik.my', 'siti@klinik', 'a b@klinik.my']) {
      expect(() => assertEmail(bad), bad).toThrow();
    }
  });

  it('stores Malaysian numbers in E.164 however they were typed', () => {
    expect(normalisePhone('012-345 6789')).toBe('+60123456789');
    expect(normalisePhone('0123456789')).toBe('+60123456789');
    expect(normalisePhone('60123456789')).toBe('+60123456789');
    expect(normalisePhone('+60123456789')).toBe('+60123456789');
    expect(normalisePhone('03-7890 1234')).toBe('+60378901234');
  });

  it('accepts a foreign number only in international form', () => {
    expect(normalisePhone('+6591234567')).toBe('+6591234567');
    expect(() => normalisePhone('91234567')).toThrow();
  });

  it('treats blank as absent', () => {
    expect(normalisePhone('   ')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });

  it('collapses whitespace in names and enforces the length limit', () => {
    expect(normaliseName('  Dr   Siti   Aminah ')).toBe('Dr Siti Aminah');
    expect(() => normaliseName('')).toThrow();
    expect(() => normaliseName('x'.repeat(121))).toThrow();
  });
});
