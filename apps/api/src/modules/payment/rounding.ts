/**
 * Malaysia's 5-sen cash rounding (PAY-F-09, PAY-R-03).
 *
 * Bank Negara's mechanism, in force since 2008: a cash total is rounded to
 * the nearest 5 sen, with 2.5 going up.
 *
 *   last digit 1, 2 → 0      74.31, 74.32 → 74.30
 *   last digit 3, 4 → 5      74.33, 74.34 → 74.35
 *   last digit 6, 7 → 5      74.36, 74.37 → 74.35
 *   last digit 8, 9 → 10     74.38, 74.39 → 74.40
 *   last digit 0, 5 → itself
 *
 * Three things about it are easy to get wrong and are therefore stated
 * here rather than left to the reader of the arithmetic.
 *
 * **It belongs to the payment, not the invoice.** An invoice of RM 77.43
 * is RM 77.43. It becomes RM 77.45 only because somebody is paying it in
 * coins, and it stays RM 77.43 if they pay by card. So rounding is
 * computed per payment leg and accumulated onto the invoice, never baked
 * into a line.
 *
 * **It applies once, to the leg that settles the bill.** On a split —
 * card RM 50.00 then cash for the rest — the card leg is exact and only
 * the final cash leg rounds. Rounding each leg would round twice and
 * drift by up to four sen per payment.
 *
 * **It rounds the amount outstanding, not the total.** After a part
 * payment the thing being rounded is what is left.
 *
 * There is one implementation of this function and everything that needs
 * it calls this one, because a second would eventually disagree.
 */

/** The step, in sen. Five-cent coins are the smallest in circulation. */
const STEP = 5n;

/**
 * The nearest multiple of five sen, halves away from zero.
 *
 * Integers throughout: `Math.round(x / 5) * 5` on a float is how a
 * total ends up a sen out once in ten thousand, in a way nobody can
 * reproduce.
 */
export function roundToFiveSen(sen: bigint): bigint {
  const sign = sen < 0n ? -1n : 1n;
  const magnitude = sen < 0n ? -sen : sen;
  const remainder = magnitude % STEP;
  const down = magnitude - remainder;
  // 0,1,2 → down; 3,4 → up. Which gives BNM's table exactly.
  const rounded = remainder < 3n ? down : down + STEP;
  return sign * rounded;
}

/**
 * What a cash payment of `outstanding` actually costs, and the
 * difference that has to be recorded.
 *
 * `adjustment` is what goes onto `invoice.rounding_adjustment`: positive
 * when the patient pays a little more than the invoice says, negative
 * when a little less. It is always between −2 and +2 sen.
 */
export function cashDue(outstanding: bigint): {
  due: bigint;
  adjustment: bigint;
} {
  const due = roundToFiveSen(outstanding);
  return { due, adjustment: due - outstanding };
}

export type LegPlan = {
  /** What this leg settles against the invoice, in sen. */
  amount: bigint;
  /** The rounding recorded on this leg. Zero unless it settles in cash. */
  rounding: bigint;
  /** What remains on the invoice after this leg. */
  balanceAfter: bigint;
  /** True when this leg clears the bill. */
  settles: boolean;
};

/**
 * PAY-F-07, PAY-F-09: what one leg of a payment does.
 *
 * `requested` is what the cashier typed, in sen, before any rounding.
 * Passing it as `null` means "settle the rest", which is the common case
 * and the one where rounding applies.
 */
export function planLeg(
  outstanding: bigint,
  method: 'CASH' | 'OTHER',
  requested: bigint | null,
): LegPlan {
  if (outstanding <= 0n) {
    return {
      amount: 0n,
      rounding: 0n,
      balanceAfter: outstanding,
      settles: false,
    };
  }

  // A leg that does not clear the bill is exact, whatever it is paid
  // with: rounding it would round a number that is not the final one.
  if (requested !== null && requested < outstanding) {
    return {
      amount: requested,
      rounding: 0n,
      balanceAfter: outstanding - requested,
      settles: false,
    };
  }

  if (method !== 'CASH') {
    return {
      amount: outstanding,
      rounding: 0n,
      balanceAfter: 0n,
      settles: true,
    };
  }

  const { due, adjustment } = cashDue(outstanding);
  return { amount: due, rounding: adjustment, balanceAfter: 0n, settles: true };
}

/** PAY-F-10. What the cashier hands back. */
export function changeFrom(tendered: bigint, due: bigint): bigint {
  return tendered - due;
}

/**
 * The quick-tender buttons the payment screen offers (§11).
 *
 * The exact amount, then the notes a patient is likely to be holding,
 * largest first and only the ones that cover it.
 */
export function tenderSuggestions(due: bigint): bigint[] {
  const notes = [1_000n, 5_000n, 10_000n, 20_000n, 50_000n, 10_000_0n];
  const out = [due];
  for (const note of notes) {
    // The smallest multiple of this note that covers the amount, which is
    // what somebody actually hands over — two fifties, not "a fifty".
    const covering = ((due + note - 1n) / note) * note;
    if (covering > due && !out.includes(covering)) out.push(covering);
  }
  return out.slice(0, 4);
}
