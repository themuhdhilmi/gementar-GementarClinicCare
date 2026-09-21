/**
 * Money, in sen, as integers, all the way through (BIL-R-01).
 *
 * Every amount in billing is a `bigint` count of sen. Nothing here uses
 * a floating-point number for an amount, because a total that is wrong
 * by one sen on a receipt is the kind of small persistent wrongness that
 * makes a clinic stop trusting the software — and then stop trusting the
 * parts that are correct.
 *
 * Quantities are the exception: they are decimals with three places
 * (half a tablet, 37.5 ml). They arrive here as integer thousandths so
 * that even the multiplication is exact.
 */

/** A quantity, as thousandths. 1.5 becomes 1500. */
export function toMilli(quantity: number): bigint {
  return BigInt(Math.round(quantity * 1000));
}

export function fromMilli(milli: bigint): number {
  return Number(milli) / 1000;
}

/**
 * Divide, rounding half away from zero.
 *
 * Half-up is what a person does with a pencil, and what the
 * specification says. Banker's rounding would be defensible and would
 * surprise the cashier, which is worse.
 */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('division by zero in money arithmetic');
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const result = (a * 2n + b) / (b * 2n);
  return negative ? -result : result;
}

/** BIL-R-02: `gross = round_half_up(quantity × unit_price)`. */
export function gross(quantityMilli: bigint, unitPriceSen: bigint): bigint {
  return divideRounded(quantityMilli * unitPriceSen, 1000n);
}

/**
 * A percentage of an amount, in sen.
 *
 * The percentage carries two decimal places, so it is held as basis
 * points: 33.33% is 3333. 10% of 5 sen is 0.5 sen, which rounds to 1 —
 * the case §14 calls out, and the reason this is a named function
 * rather than inline arithmetic.
 */
export function percentOf(amountSen: bigint, basisPoints: number): bigint {
  return divideRounded(amountSen * BigInt(basisPoints), 10_000n);
}

/** 12.5% → 1250. Refuses anything that is not a percentage. */
export function toBasisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`${percent} is not a percentage`);
  }
  const bp = Math.round(percent * 100);
  if (Math.abs(percent * 100 - bp) > 1e-6) {
    throw new RangeError(`${percent}% is finer than a hundredth of a percent`);
  }
  return bp;
}

/**
 * BIL-R-03, BIL-T-02: split an amount across lines, to the sen.
 *
 * Largest-remainder: every line gets its exact share rounded down, then
 * the sen left over go to the lines whose fractional part was largest,
 * ties broken by position. The sum of the parts always equals the whole,
 * which is the only property that actually matters — an invoice whose
 * lines do not add up to its total cannot be explained to a patient.
 *
 * Weights are usually the lines' gross amounts. A zero total or zero
 * weights give zeros rather than an error, because an invoice of nothing
 * discounted by nothing is a real thing.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n || total === 0n) return weights.map(() => 0n);

  const base = weights.map((weight) => (total * weight) / sum);
  const allocated = base.reduce((a, b) => a + b, 0n);
  let remainder = total - allocated;

  // Rank by the fractional part we threw away, largest first; ties keep
  // their original order, so the result is deterministic.
  const order = weights
    .map((weight, index) => ({
      index,
      fraction: (total * weight) % sum,
    }))
    .sort((a, b) => (b.fraction === a.fraction ? a.index - b.index : b.fraction > a.fraction ? 1 : -1));

  const out = [...base];
  for (const { index } of order) {
    if (remainder === 0n) break;
    const step = remainder > 0n ? 1n : -1n;
    out[index] = out[index]! + step;
    remainder -= step;
  }
  return out;
}

export type TaxMode = 'INCLUSIVE' | 'EXCLUSIVE';

/**
 * BIL-F-11: tax on one line, after its discount.
 *
 * Exclusive: tax is added on top, and the patient pays more.
 * Inclusive: the price already contains it, and the tax is worked
 * backwards for the report. §14 is explicit that inclusive tax must
 * never change the customer-facing total, so the two modes differ in
 * what the line adds up to, not only in where the number is printed.
 */
export function taxOn(netSen: bigint, rateBasisPoints: number, mode: TaxMode): bigint {
  if (rateBasisPoints === 0) return 0n;
  if (mode === 'EXCLUSIVE') return percentOf(netSen, rateBasisPoints);
  // Inclusive: net already contains the tax, so the component is
  // net × r / (1 + r).
  return divideRounded(netSen * BigInt(rateBasisPoints), BigInt(10_000 + rateBasisPoints));
}

/** What the line contributes to the invoice total. */
export function lineTotal(
  grossSen: bigint,
  discountSen: bigint,
  taxSen: bigint,
  mode: TaxMode,
): bigint {
  const net = grossSen - discountSen;
  return mode === 'EXCLUSIVE' ? net + taxSen : net;
}

/** Sen as the string a receipt prints. */
export function formatSen(sen: bigint): string {
  const negative = sen < 0n;
  const absolute = negative ? -sen : sen;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

/** What a cashier typed, as sen. Refuses more than two decimal places. */
export function ringgitToSen(amount: number | string): bigint {
  const text = typeof amount === 'string' ? amount.trim() : String(amount);
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new RangeError(`"${amount}" is not an amount in ringgit and sen`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const sen = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -sen : sen;
}
