import { describe, expect, it } from 'vitest';
import { assertBranchCode, assertOperatingHours, assertPostcode } from './branch.validation.js';

describe('Branch validation (§12)', () => {
  it('accepts a code and canonicalises it, because it lands in invoice numbers', () => {
    expect(assertBranchCode('kl01')).toBe('KL01');
    expect(assertBranchCode('  hq ')).toBe('HQ');
    for (const bad of ['K', 'TOOLONGACODE', 'KL-01', 'KL 01', 'kl.01', '']) {
      expect(() => assertBranchCode(bad), bad).toThrow();
    }
  });

  it('takes a Malaysian postcode, or nothing at all', () => {
    expect(assertPostcode('50450')).toBe('50450');
    expect(assertPostcode(' 43300 ')).toBe('43300');
    expect(assertPostcode(null)).toBeNull();
    expect(assertPostcode('')).toBeNull();
    expect(() => assertPostcode('5045')).toThrow();
    expect(() => assertPostcode('504500')).toThrow();
  });

  it('accepts a day split around lunch, and sorts it', () => {
    expect(
      assertOperatingHours({ mon: [['14:00', '18:00'], ['09:00', '13:00']] }),
    ).toEqual({ mon: [['09:00', '13:00'], ['14:00', '18:00']] });
  });

  it('drops a day the clinic is shut rather than storing an empty list', () => {
    expect(assertOperatingHours({ sun: [] })).toEqual({});
    expect(assertOperatingHours(null)).toEqual({});
  });

  it('refuses overlaps, backwards ranges, bad times and things that are not days', () => {
    const bad = [
      { mon: [['09:00', '13:00'], ['12:00', '18:00']] },
      { mon: [['18:00', '09:00']] },
      { mon: [['09:00', '09:00']] },
      { mon: [['9:00', '13:00']] },
      { mon: [['25:00', '26:00']] },
      { mon: [['09:00']] },
      { mon: '09:00-17:00' },
      { funday: [['09:00', '13:00']] },
      [['09:00', '13:00']],
    ];
    for (const hours of bad) {
      expect(() => assertOperatingHours(hours), JSON.stringify(hours)).toThrow();
    }
  });

  it('allows ranges that touch without overlapping', () => {
    expect(assertOperatingHours({ tue: [['09:00', '13:00'], ['13:00', '17:00']] })).toEqual({
      tue: [['09:00', '13:00'], ['13:00', '17:00']],
    });
  });
});
