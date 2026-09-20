import { describe, expect, it } from 'vitest';
import { parseExpiry } from './stock.service.js';

/**
 * INV-F-08. Blister packs are stamped "03/2027", not with a day.
 *
 * Reading a month as its first day throws away up to thirty days of
 * usable stock and writes off medicine that is still good. Reading it as
 * the last day is what the manufacturer means.
 */
describe('INV-F-08 — a month-precision expiry', () => {
  it('means the last day of that month', () => {
    expect(parseExpiry('2027-03')?.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(parseExpiry('2027-02')?.toISOString().slice(0, 10)).toBe('2027-02-28');
    expect(parseExpiry('2027-04')?.toISOString().slice(0, 10)).toBe('2027-04-30');
    expect(parseExpiry('2027-12')?.toISOString().slice(0, 10)).toBe('2027-12-31');
  });

  it('knows about leap years', () => {
    expect(parseExpiry('2028-02')?.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('takes a full date as it stands', () => {
    expect(parseExpiry('2027-03-15')?.toISOString().slice(0, 10)).toBe('2027-03-15');
  });

  it('refuses anything else rather than guessing', () => {
    expect(parseExpiry('')).toBeNull();
    expect(parseExpiry(null)).toBeNull();
    expect(parseExpiry('March 2027')).toBeNull();
    expect(parseExpiry('03/2027')).toBeNull();
    expect(parseExpiry('2027-13')).toBeNull();
    expect(parseExpiry('2027')).toBeNull();
  });
});
