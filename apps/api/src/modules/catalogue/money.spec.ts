import { describe, expect, it } from 'vitest';
import { formatMyr, fromSen, toSen } from './money.js';

describe('Money is sen (INV-F-02)', () => {
  it('converts the way a person would expect', () => {
    expect(toSen(12.5)).toBe(1250);
    expect(toSen('12.50')).toBe(1250);
    expect(toSen(0)).toBe(0);
    expect(toSen(0.05)).toBe(5);
  });

  it('survives the numbers that break floating point', () => {
    // These are all two-decimal prices that binary cannot hold exactly.
    // 0.1 + 0.2 is 0.30000000000000004; 8.61 * 100 is 860.9999999999999.
    // Truncating either loses a sen for no reason anybody could explain.
    expect(toSen(0.1 + 0.2)).toBe(30);
    expect(toSen(0.1 * 3)).toBe(30);
    expect(toSen(8.61)).toBe(861);
    expect(toSen(1.1 * 3)).toBe(330);
    expect(toSen(29.97)).toBe(2997);
  });

  it('refuses a price with more precision than money has', () => {
    // Three decimal places is a data-entry error, not a price. Silently
    // rounding it would mean the clinic charges something they did not
    // type, which is worse than being told to fix it.
    expect(() => toSen(12.005)).toThrow(/two decimal places/);
    expect(() => toSen(12.5001)).toThrow(/two decimal places/);
    expect(() => toSen('0.125')).toThrow(/two decimal places/);
  });

  it('refuses nonsense and obvious typing errors', () => {
    expect(() => toSen(-1)).toThrow();
    expect(() => toSen(Number.NaN)).toThrow();
    expect(() => toSen('abc')).toThrow();
    expect(() => toSen(2_000_000)).toThrow(/typing error/);
  });

  it('reads back with both decimal places', () => {
    expect(fromSen(1250)).toBe('12.50');
    expect(fromSen(5)).toBe('0.05');
    expect(fromSen(0)).toBe('0.00');
    expect(fromSen(100)).toBe('1.00');
    expect(formatMyr(1250)).toBe('RM 12.50');
  });

  it('round-trips', () => {
    for (const amount of [0, 0.01, 0.99, 1, 12.5, 999.99, 1000]) {
      expect(Number(fromSen(toSen(amount)))).toBe(amount);
    }
  });
});
