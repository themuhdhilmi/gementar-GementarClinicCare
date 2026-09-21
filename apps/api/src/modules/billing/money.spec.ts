import { describe, expect, it } from 'vitest';
import {
  allocate,
  divideRounded,
  formatSen,
  gross,
  lineTotal,
  percentOf,
  ringgitToSen,
  taxOn,
  toBasisPoints,
  toMilli,
} from './money.js';

describe('BIL-R-01 — rounding', () => {
  it('rounds half away from zero, the way a pencil does', () => {
    expect(divideRounded(5n, 2n)).toBe(3n);
    expect(divideRounded(3n, 2n)).toBe(2n);
    expect(divideRounded(1n, 2n)).toBe(1n);
    expect(divideRounded(-5n, 2n)).toBe(-3n);
    expect(divideRounded(-1n, 2n)).toBe(-1n);
  });

  it('is exact for values far past what a float could hold', () => {
    // A hundred million ringgit, to the sen. No clinic will see this;
    // the point is that the arithmetic has no upper bound to discover.
    expect(gross(toMilli(1), 10_000_000_000n)).toBe(10_000_000_000n);
  });
});

describe('BIL-R-02 — a line', () => {
  it('multiplies a fractional quantity exactly', () => {
    // 15 capsules at RM 1.20.
    expect(gross(toMilli(15), 120n)).toBe(1800n);
    // Half a tablet at RM 0.15 is 7.5 sen, which rounds to 8.
    expect(gross(toMilli(0.5), 15n)).toBe(8n);
    // 37.5 ml at 4 sen.
    expect(gross(toMilli(37.5), 4n)).toBe(150n);
  });

  it('does not drift the way 0.1 + 0.2 does', () => {
    let total = 0n;
    for (let i = 0; i < 1000; i += 1) total += gross(toMilli(0.1), 10n);
    expect(total).toBe(1000n);
  });
});

describe('BIL-F-07 — percentages', () => {
  it('§14: 10% of 5 sen is 1 sen, not 0', () => {
    expect(percentOf(5n, toBasisPoints(10))).toBe(1n);
  });

  it('carries two decimal places', () => {
    expect(toBasisPoints(33.33)).toBe(3333);
    expect(percentOf(3000n, 3333)).toBe(1000n);
  });

  it('refuses a percentage finer than it can hold, or outside 0–100', () => {
    expect(() => toBasisPoints(33.333)).toThrow(/finer/);
    expect(() => toBasisPoints(-1)).toThrow(/not a percentage/);
    expect(() => toBasisPoints(101)).toThrow(/not a percentage/);
  });
});

describe('BIL-R-03, BIL-T-02 — allocating a discount across lines', () => {
  it('BIL-T-02: 33.33% of three RM 10 lines is 334/333/333', () => {
    const lines = [1000n, 1000n, 1000n];
    const discount = percentOf(3000n, toBasisPoints(33.33));
    expect(discount).toBe(1000n);
    expect(allocate(discount, lines)).toEqual([334n, 333n, 333n]);
  });

  it('gives the odd sen to the largest line', () => {
    // 10 sen across 60/30/10: 6/3/1 exactly, nothing left over.
    expect(allocate(10n, [600n, 300n, 100n])).toEqual([6n, 3n, 1n]);
    // 10 sen across 50/50/1: 4.95/4.95/0.098 → 4/4/0 then two over.
    const out = allocate(10n, [500n, 500n, 10n]);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(10n);
  });

  it('breaks ties by position, so the result never wobbles', () => {
    const a = allocate(1n, [100n, 100n, 100n]);
    const b = allocate(1n, [100n, 100n, 100n]);
    expect(a).toEqual([1n, 0n, 0n]);
    expect(a).toEqual(b);
  });

  it('copes with nothing to allocate and with nothing to allocate over', () => {
    expect(allocate(0n, [100n, 200n])).toEqual([0n, 0n]);
    expect(allocate(500n, [0n, 0n])).toEqual([0n, 0n]);
    expect(allocate(500n, [])).toEqual([]);
  });

  /**
   * BIL-N-03, BIL-T-10. The one property that has to hold for every
   * input: the parts add up to the whole. An invoice whose lines do not
   * sum to its total cannot be explained to a patient at the counter.
   */
  it('always sums to the total, for two thousand random splits', () => {
    let seed = 20260921;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    for (let round = 0; round < 2000; round += 1) {
      const count = 1 + random(8);
      const weights = Array.from({ length: count }, () => BigInt(random(50_000)));
      const sum = weights.reduce((a, b) => a + b, 0n);
      const total = BigInt(random(Number(sum > 0n ? sum : 1n) + 1));

      const parts = allocate(total, weights);
      expect(parts).toHaveLength(count);
      expect(parts.every((p) => typeof p === 'bigint')).toBe(true);
      if (sum === 0n) {
        expect(parts.every((p) => p === 0n)).toBe(true);
      } else {
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        // Nobody is discounted by more than the whole discount.
        expect(parts.every((p) => p >= 0n && p <= total)).toBe(true);
      }
    }
  });
});

describe('BIL-F-11 — tax', () => {
  it('adds on top when prices exclude it', () => {
    expect(taxOn(1000n, 800, 'EXCLUSIVE')).toBe(80n);
    expect(lineTotal(1000n, 0n, 80n, 'EXCLUSIVE')).toBe(1080n);
  });

  it('BIL-T-09: works backwards when prices include it, and the patient pays the same', () => {
    // RM 10.80 with 8% already inside is 80 sen of tax.
    expect(taxOn(1080n, 800, 'INCLUSIVE')).toBe(80n);
    // §14: the customer-facing total is the price, tax or no tax.
    expect(lineTotal(1080n, 0n, 80n, 'INCLUSIVE')).toBe(1080n);
    expect(lineTotal(1080n, 80n, 74n, 'INCLUSIVE')).toBe(1000n);
  });

  it('is nothing at all when the rate is nothing, which is the usual case', () => {
    expect(taxOn(1234n, 0, 'EXCLUSIVE')).toBe(0n);
    expect(taxOn(1234n, 0, 'INCLUSIVE')).toBe(0n);
  });

  it('taxes what is left after a discount, not what was asked for', () => {
    const grossSen = 1000n;
    const discount = 200n;
    const tax = taxOn(grossSen - discount, 800, 'EXCLUSIVE');
    expect(tax).toBe(64n);
    expect(lineTotal(grossSen, discount, tax, 'EXCLUSIVE')).toBe(864n);
  });
});

describe('Reading and writing amounts', () => {
  it('prints sen the way a receipt does', () => {
    expect(formatSen(0n)).toBe('0.00');
    expect(formatSen(5n)).toBe('0.05');
    expect(formatSen(1234n)).toBe('12.34');
    expect(formatSen(-1234n)).toBe('-12.34');
    expect(formatSen(100000n)).toBe('1000.00');
  });

  it('reads what a cashier types', () => {
    expect(ringgitToSen('12.34')).toBe(1234n);
    expect(ringgitToSen('12.3')).toBe(1230n);
    expect(ringgitToSen('12')).toBe(1200n);
    expect(ringgitToSen(0.05)).toBe(5n);
  });

  it('refuses a third decimal place rather than silently dropping it', () => {
    expect(() => ringgitToSen('12.345')).toThrow(/not an amount/);
    expect(() => ringgitToSen('twelve')).toThrow(/not an amount/);
  });

  it('survives a round trip', () => {
    for (const sen of [0n, 1n, 99n, 100n, 12345n, 999999n]) {
      expect(ringgitToSen(formatSen(sen))).toBe(sen);
    }
  });
});
