import { describe, expect, it } from 'vitest';
import { Gender, IdType } from '../../generated/prisma/enums.js';
import {
  deriveFromMyKad,
  displayIdNumber,
  formatMyKad,
  lastFour,
  maskIdNumber,
  normaliseIdentity,
} from './identity.js';

const NOW = new Date('2026-09-21T00:00:00.000Z');

describe('MyKad (PAT-F-02)', () => {
  it('PAT-T-01: reads the date of birth and sex off the card', () => {
    const derived = deriveFromMyKad('900101-14-5678', NOW);
    expect(derived.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-01-01');
    expect(derived.gender).toBe(Gender.FEMALE);
    expect(derived.idNumber).toBe('900101145678');
    expect(derived.warnings).toEqual([]);
  });

  it('takes the number with or without hyphens', () => {
    expect(deriveFromMyKad('900101145678', NOW).idNumber).toBe('900101145678');
    expect(formatMyKad('900101145678')).toBe('900101-14-5678');
  });

  it('reads an odd last digit as male and an even one as female', () => {
    expect(deriveFromMyKad('880315-08-5679', NOW).gender).toBe(Gender.MALE);
    expect(deriveFromMyKad('880315-08-5670', NOW).gender).toBe(Gender.FEMALE);
  });

  it('puts a year that has not happened yet in the last century', () => {
    // 2027 has not arrived, so 27 means 1927 rather than a patient from the
    // future. The same rule makes 10 mean 2010, which has.
    expect(deriveFromMyKad('270101-14-5678', NOW).dateOfBirth?.getUTCFullYear()).toBe(1927);
    expect(deriveFromMyKad('100101-14-5678', NOW).dateOfBirth?.getUTCFullYear()).toBe(2010);
  });

  it('warns when the century is a guess worth checking', () => {
    // Born 1927 by the rule above, which would make them 99. Plausible, and
    // also what a card belonging to a two-year-old would look like in 2029.
    expect(deriveFromMyKad('270101-14-5678', NOW).warnings[0]).toContain('either century');
    expect(deriveFromMyKad('900101-14-5678', NOW).warnings).toEqual([]);
  });

  it('refuses a date portion that is not a date', () => {
    // The commonest typing error is a transposition, and it usually produces
    // a month or a day that cannot exist.
    expect(() => deriveFromMyKad('901301-14-5678', NOW)).toThrow(/not one|not a real date/);
    expect(() => deriveFromMyKad('900230-14-5678', NOW)).toThrow(/not a real date/);
    expect(() => deriveFromMyKad('900100-14-5678', NOW)).toThrow();
  });

  it('accepts the 29th of February only in a leap year', () => {
    expect(deriveFromMyKad('000229-14-5678', NOW).dateOfBirth?.toISOString().slice(0, 10)).toBe(
      '2000-02-29',
    );
    expect(() => deriveFromMyKad('010229-14-5678', NOW)).toThrow(/not a real date/);
  });

  it('refuses something that is not twelve digits', () => {
    for (const bad of ['90010114567', '9001011456789', 'abcdef-14-5678', '']) {
      expect(() => deriveFromMyKad(bad, NOW), bad).toThrow(/twelve digits/);
    }
  });
});

describe('Identity documents of other kinds', () => {
  it('needs a country with a passport, because numbers collide across them', () => {
    expect(() => normaliseIdentity(IdType.PASSPORT, 'A1234567')).toThrow(/issuing country/);
    expect(normaliseIdentity(IdType.PASSPORT, 'a123 4567', { passportCountry: 'ID' }).idNumber).toBe(
      'A1234567',
    );
  });

  it('allows a patient with no document, and only then an empty number', () => {
    expect(normaliseIdentity(IdType.NONE, '').idNumber).toBe('');
    expect(normaliseIdentity(IdType.NONE, null).idNumber).toBe('');
    expect(() => normaliseIdentity(IdType.NONE, '900101145678')).toThrow(/no number to store/);
    expect(() => normaliseIdentity(IdType.MYKAD, '')).toThrow(/No document/);
  });

  it('canonicalises army, police and other numbers', () => {
    expect(normaliseIdentity(IdType.ARMY, ' t 123456 ').idNumber).toBe('T123456');
    expect(() => normaliseIdentity(IdType.OTHER, 'ab')).toThrow(/usable length/);
  });
});

describe('Masking (PAT-F-24, PAT-R-05)', () => {
  it('shows the last four and hides the rest', () => {
    expect(maskIdNumber(IdType.MYKAD, '900101145678')).toBe('••••••-••-5678');
    expect(maskIdNumber(IdType.PASSPORT, 'A1234567')).toBe('••••4567');
    expect(maskIdNumber(IdType.NONE, null)).toBeNull();
  });

  it('never leaks a short number by showing all of it', () => {
    expect(maskIdNumber(IdType.OTHER, 'AB12')).toBe('••••');
    expect(maskIdNumber(IdType.OTHER, 'AB1')).toBe('•••');
  });

  it('formats the full number the way the card reads, once unmasked', () => {
    expect(displayIdNumber(IdType.MYKAD, '900101145678')).toBe('900101-14-5678');
    expect(displayIdNumber(IdType.PASSPORT, 'A1234567')).toBe('A1234567');
  });

  it('takes the last four for searching without unmasking anything', () => {
    expect(lastFour('900101145678')).toBe('5678');
    expect(lastFour('A1234567')).toBe('4567');
    expect(lastFour('12')).toBeNull();
  });
});
