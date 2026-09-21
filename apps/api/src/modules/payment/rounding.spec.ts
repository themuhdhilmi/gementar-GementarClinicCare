import { describe, expect, it } from 'vitest';
import {
  cashDue,
  changeFrom,
  planLeg,
  roundToFiveSen,
  tenderSuggestions,
} from './rounding.js';

describe('PAY-R-03 — Bank Negara 5-sen rounding', () => {
  /**
   * PAY-N-03 asks for all ten last-digit cases. Here they are, written
   * out rather than generated, so the table in the specification and the
   * table in the test can be read side by side.
   */
  const TABLE: Array<[last: number, goesTo: number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 5],
    [4, 5],
    [5, 5],
    [6, 5],
    [7, 5],
    [8, 10],
    [9, 10],
  ];

  it.each(TABLE)(
    'a total ending in %i rounds to the ten ending in %i',
    (last, goesTo) => {
      // Checked across several tens, because a rule that only works in the
      // seventies is not a rule.
      for (const tens of [0n, 10n, 70n, 7_740n, 99_990n]) {
        expect(roundToFiveSen(tens + BigInt(last))).toBe(tens + BigInt(goesTo));
      }
    },
  );

  it('never moves an amount by more than two sen', () => {
    for (let sen = 0; sen <= 500; sen += 1) {
      const moved = roundToFiveSen(BigInt(sen)) - BigInt(sen);
      expect(moved).toBeGreaterThanOrEqual(-2n);
      expect(moved).toBeLessThanOrEqual(2n);
    }
  });

  it('always lands on a five', () => {
    for (let sen = 0; sen <= 1_000; sen += 1) {
      expect(roundToFiveSen(BigInt(sen)) % 5n).toBe(0n);
    }
  });

  it('is symmetric about zero', () => {
    // A refund of RM 7.43 gives back what a payment of RM 7.43 took.
    for (let sen = 0; sen <= 200; sen += 1) {
      expect(roundToFiveSen(BigInt(-sen))).toBe(-roundToFiveSen(BigInt(sen)));
    }
  });

  it('leaves an amount that is already a five alone', () => {
    for (const sen of [0n, 5n, 10n, 7_740n, 7_745n, 100_000n]) {
      expect(roundToFiveSen(sen)).toBe(sen);
    }
  });
});

describe('PAY-T-01 — the four worked examples from the specification', () => {
  it('7743 → 7745, adjustment +2', () => {
    expect(cashDue(7_743n)).toEqual({ due: 7_745n, adjustment: 2n });
  });
  it('7742 → 7740, adjustment −2', () => {
    expect(cashDue(7_742n)).toEqual({ due: 7_740n, adjustment: -2n });
  });
  it('7741 → 7740, adjustment −1', () => {
    expect(cashDue(7_741n)).toEqual({ due: 7_740n, adjustment: -1n });
  });
  it('7748 → 7750, adjustment +2', () => {
    expect(cashDue(7_748n)).toEqual({ due: 7_750n, adjustment: 2n });
  });
  it('7740 → 7740, no adjustment', () => {
    expect(cashDue(7_740n)).toEqual({ due: 7_740n, adjustment: 0n });
  });
});

describe('planLeg — which leg rounds', () => {
  it('a card payment of the whole bill is exact (PAY-T-03)', () => {
    expect(planLeg(7_743n, 'OTHER', null)).toEqual({
      amount: 7_743n,
      rounding: 0n,
      balanceAfter: 0n,
      settles: true,
    });
  });

  it('a cash payment of the whole bill rounds (PAY-F-09)', () => {
    expect(planLeg(7_743n, 'CASH', null)).toEqual({
      amount: 7_745n,
      rounding: 2n,
      balanceAfter: 0n,
      settles: true,
    });
  });

  it('PAY-T-02: card 5000 then cash — only the cash leg rounds', () => {
    const card = planLeg(7_743n, 'OTHER', 5_000n);
    expect(card).toEqual({
      amount: 5_000n,
      rounding: 0n,
      balanceAfter: 2_743n,
      settles: false,
    });

    const cash = planLeg(card.balanceAfter, 'CASH', null);
    expect(cash).toEqual({
      amount: 2_745n,
      rounding: 2n,
      balanceAfter: 0n,
      settles: true,
    });

    // The invoice ends up two sen over its own total, once, and that is
    // exactly what `rounding_adjustment` is for.
    expect(card.amount + cash.amount).toBe(7_745n);
    expect(card.rounding + cash.rounding).toBe(2n);
  });

  it('a part payment in cash does not round, because it is not the last one', () => {
    // Rounding a leg that leaves a balance would round a number that is
    // not the final one, and then round again at the end.
    expect(planLeg(7_743n, 'CASH', 3_000n)).toEqual({
      amount: 3_000n,
      rounding: 0n,
      balanceAfter: 4_743n,
      settles: false,
    });
  });

  it('a cash leg for exactly the balance settles and rounds', () => {
    const leg = planLeg(7_743n, 'CASH', 7_743n);
    expect(leg.settles).toBe(true);
    expect(leg.amount).toBe(7_745n);
  });

  it('never rounds twice across a whole split, however it is divided', () => {
    // Every way of splitting RM 77.43 into a first leg and the rest.
    for (let first = 1; first < 7_743; first += 7) {
      const legOne = planLeg(7_743n, 'CASH', BigInt(first));
      const legTwo = planLeg(legOne.balanceAfter, 'CASH', null);
      expect(legOne.rounding + legTwo.rounding).toBe(legTwo.rounding);
      expect(legOne.rounding).toBe(0n);
      // And the total collected is the invoice, rounded once.
      expect(legOne.amount + legTwo.amount).toBe(7_743n + legTwo.rounding);
    }
  });

  it('a bill that rounds away to nothing still settles (§14)', () => {
    // RM 0.02 in cash is RM 0.00. The payment is a rounding settlement
    // and the invoice is paid, which is why the database allows a zero
    // amount only when the rounding is not zero.
    expect(planLeg(2n, 'CASH', null)).toEqual({
      amount: 0n,
      rounding: -2n,
      balanceAfter: 0n,
      settles: true,
    });
  });

  it('a settled invoice takes no more', () => {
    expect(planLeg(0n, 'CASH', null).settles).toBe(false);
    expect(planLeg(0n, 'CASH', null).amount).toBe(0n);
  });
});

describe('change and tender', () => {
  it('PAY-F-10: change is what is handed over less what is due', () => {
    expect(changeFrom(10_000n, 7_745n)).toBe(2_255n);
    expect(changeFrom(7_745n, 7_745n)).toBe(0n);
  });

  it('suggests the exact amount first, then notes that cover it', () => {
    const suggestions = tenderSuggestions(7_745n);
    expect(suggestions[0]).toBe(7_745n);
    expect(suggestions).toContain(8_000n); // four twenties
    expect(suggestions.every((value) => value >= 7_745n)).toBe(true);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });

  it('suggests nothing below the amount due', () => {
    for (const due of [5n, 500n, 4_999n, 123_456n]) {
      expect(tenderSuggestions(due).every((value) => value >= due)).toBe(true);
    }
  });
});
