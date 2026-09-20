import { BadRequestError } from '../../shared/errors/domain-errors.js';

/**
 * Money is an integer number of sen, everywhere, always.
 *
 * `0.1 + 0.2` is not `0.3` in any language with binary floating point, and
 * a clinic that is out by a sen a day is out by three ringgit a year and
 * cannot reconcile a till. The conversion happens at the edge, here, and
 * nothing inside the system ever holds a fractional currency amount.
 */

/** `12.50` becomes `1250`. Accepts a number or the string a form sends. */
export function toSen(amount: number | string): number {
  const value = typeof amount === 'string' ? Number(amount.trim()) : amount;
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestError('That is not a price.', 'invalid_price');
  }
  if (value > 1_000_000) {
    throw new BadRequestError(
      'A price of more than a million ringgit is a typing error.',
      'invalid_price',
    );
  }
  // Rounded rather than truncated: 0.1 * 3 is 0.30000000000000004, and
  // truncating that would lose a sen for no reason anybody could explain.
  const sen = Math.round(value * 100);
  if (Math.abs(value * 100 - sen) > 0.001) {
    throw new BadRequestError(
      'A price has at most two decimal places.',
      'invalid_price',
    );
  }
  return sen;
}

/** `1250` becomes `12.50`, as a string, because that is for display. */
export function fromSen(sen: number | bigint): string {
  const value = typeof sen === 'bigint' ? Number(sen) : sen;
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** `RM 12.50`, for a screen or a printed line. */
export function formatMyr(sen: number | bigint): string {
  return `RM ${fromSen(sen)}`;
}
