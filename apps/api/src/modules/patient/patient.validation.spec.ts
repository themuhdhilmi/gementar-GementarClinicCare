import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  assertDateOfBirth,
  assertName,
  assertPostcode,
  describeAge,
  displayPhone,
  normaliseEmail,
  normalisePhone,
} from './patient.validation.js';

const NOW = new Date('2026-09-21T00:00:00.000Z');

describe('Patient validation (§12)', () => {
  it('tidies a name without changing it', () => {
    expect(assertName('  Ali   bin  Ahmad ')).toBe('Ali bin Ahmad');
    expect(() => assertName('A')).toThrow();
    expect(() => assertName('x'.repeat(151))).toThrow();
  });

  it('stores one phone number however reception types it', () => {
    // The same person, three days running.
    for (const written of ['012-345 6789', '0123456789', '+60123456789', '60123456789']) {
      expect(normalisePhone(written), written).toBe('+60123456789');
    }
    expect(normalisePhone('03-1234 5678')).toBe('+60312345678');
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone(null)).toBeNull();
  });

  it('keeps a foreign number rather than refusing it', () => {
    expect(normalisePhone('+62 812 3456 789')).toBe('+628123456789');
  });

  it('refuses something that is not a telephone number', () => {
    expect(() => normalisePhone('0912')).toThrow();
    expect(() => normalisePhone('12345')).toThrow();
  });

  it('reads a stored number back the Malaysian way', () => {
    expect(displayPhone('+60123456789')).toBe('012-345 6789');
    expect(displayPhone('+60312345678')).toBe('03-1234 5678');
    expect(displayPhone('+628123456789')).toBe('+628123456789');
  });

  it('takes a five digit postcode or nothing', () => {
    expect(assertPostcode('50450')).toBe('50450');
    expect(assertPostcode('')).toBeNull();
    expect(() => assertPostcode('5045')).toThrow();
  });

  it('lowercases an email and refuses a broken one', () => {
    expect(normaliseEmail(' Ali@Example.COM ')).toBe('ali@example.com');
    expect(() => normaliseEmail('ali@')).toThrow();
  });

  it('refuses a birth date in the future or beyond a human lifetime', () => {
    expect(assertDateOfBirth('1990-01-01', NOW)?.toISOString().slice(0, 10)).toBe('1990-01-01');
    expect(() => assertDateOfBirth('2027-01-01', NOW)).toThrow(/future/);
    expect(() => assertDateOfBirth('1880-01-01', NOW)).toThrow(/hundred and twenty/);
    expect(assertDateOfBirth(null, NOW)).toBeNull();
  });

  it('counts age in whole years, the day before and the day of a birthday', () => {
    expect(ageInYears(new Date('1990-09-22T00:00:00Z'), NOW)).toBe(35);
    expect(ageInYears(new Date('1990-09-21T00:00:00Z'), NOW)).toBe(36);
  });

  it('says an infant age in days or months, never in years', () => {
    // A four-day-old and a four-year-old are both "4" to arithmetic, and a
    // paediatric dose that confuses them is the reason this exists.
    expect(describeAge(new Date('2026-09-17T00:00:00Z'), NOW)).toBe('4 d');
    expect(describeAge(new Date('2026-03-21T00:00:00Z'), NOW)).toBe('6 mo');
    expect(describeAge(new Date('2022-09-21T00:00:00Z'), NOW)).toBe('4 y');
  });
});
