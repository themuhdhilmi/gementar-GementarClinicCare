# 12 · Payment (PAY)

The drawer, the money, Malaysia's 5-sen rounding, and proving at the end
of the day that it balances.

**Register:** [`../v0-12-payment-end-item-OPEN.md`](../../v0-12-payment-end-item-OPEN.md)

## Setup

An issued invoice ([11](../11-billing/README.md)). Sign in as **Cik Rina**;
you will need **Dr Aisyah** for voids and refunds.

## Walk through

**The drawer first — nothing can be taken without one.**

1. **Drawer → open it** with a float of RM 200. Try to pay before doing
   this and the panel says so rather than failing at the last step.

**Then the rounding, which is the heart of the module.**

2. **Make a bill of RM 77.43 and pay it in cash.** The panel says
   **RM 77.45** and *"Rounded up by RM 0.02 — five-sen coins."*
3. **RM 77.42** rounds **down** to RM 77.40.
4. **RM 77.41** rounds down to RM 77.40 — a one-sen adjustment.
5. **RM 77.48** rounds up to RM 77.50.
6. **Now pay a RM 77.43 bill by card.** Exactly RM 77.43, no rounding.
   *The rounding belongs to the coins, not to the bill. An invoice is
   RM 77.43 whichever way it is settled.*
7. **Split one.** Card RM 50.00 first, then cash for the rest. The card
   leg is exact; **only the final cash leg rounds**. The clinic collects
   two sen more than it billed — once, not twice.

**Then the till.**

8. **Type an amount tendered.** The change appears as you type. The
   quick buttons offer the exact amount and the notes somebody is
   likely to be holding.
9. **Take cash out** — "to the safe at lunchtime". What is expected in
   the drawer drops by that much.
10. **Count and close.** Type a figure and **the variance appears
    before you commit**, so a cashier who is short can recount. Inside
    RM 10 it closes with a note; beyond it only an administrator can,
    and only with an explanation.
    *The expected figure is never adjusted to match the count. That is
    the whole point — the number the owner wants is the difference,
    over time, per cashier.*
11. **Print the Z-report.** Totals by method, every movement, the
    variance, the note.

**Then the things that go wrong.**

12. **Void a payment** (administrator, same day, asks for your password
    again). The invoice goes back to unpaid, **the rounding goes back
    with it**, and the drawer records a `VOID_OUT`.
13. **Try to void one from yesterday.** Refused — use a **refund**,
    which is a negative payment pointing at the original. The trail
    reads as two events: they paid, and then we gave it back.

## Try to break it

- **Pay more than is owed.** Refused — after rounding, so RM 77.45
  against a RM 77.43 bill is fine and RM 80 is not.
- **Tender less than is due.** Refused.
- **Double-click "Take payment".** One payment. Every attempt carries an
  idempotency key and a retry returns the original.
- **Pay a draft invoice**, or a voided one. Both refused.
- **Open a second drawer** with the same code. Refused — by a partial
  unique index, so a direct SQL insert is refused too. A *different*
  drawer code is fine; two cashiers, two drawers.
- **Take more out of the drawer than is in it.** Refused.
- **Try to edit a payment with SQL.** Refused by a trigger. Try to edit
  a drawer movement — also refused: a movement is a fact, and the
  correction is another movement.
- **Complete a visit with an unpaid bill.** Refused, naming what is
  owed. Pay it and it completes.
- **Ask for the same receipt twice.** The same document, not a second
  one claiming the same money was taken. The first print is the
  handover; every one after is stamped COPY.

## What is deliberately not here

- **No receipt has come out of a printer** (`PAY-OPEN-01`). **A
  production blocker.** The 80 mm template has met nothing but a
  browser; the width, the font and whether their printer even wants
  HTML are assumptions.
- **The till has never been reconciled** (`PAY-OPEN-06`). **A
  production blocker.** Three evenings of parallel running with the
  Z-report against their real cash count is the only test of the money
  that matters, and it cannot be written in a repository.
- **Nobody has said which methods they take** (`PAY-OPEN-02`), what the
  variance threshold should be (`PAY-OPEN-04`), or whether they give
  credit (`PAY-OPEN-05`). All three are settings with invented defaults.
- **No screen for payment methods, refunds, or reopening a session**
  (`PAY-OPEN-08`, `-09`, `-11`). The APIs work; the buttons do not
  exist, which is awkward precisely on the bad day you need them.

## Notes

<!-- yours -->
