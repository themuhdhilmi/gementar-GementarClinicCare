# 11 · Billing (BIL)

The bill: what goes on it by itself, what you put on it, discounts, and
what happens when it is wrong.

**Register:** [`../v0-11-billing-end-item-OPEN.md`](../../v0-11-billing-end-item-OPEN.md)

## Setup

```bash
npm run billing:seed --workspace @gementar/api
```

Sign in as **Cik Rina** (`cashier@klinikpilot.test`).

## Walk through

1. **Billing.** Who is waiting to pay, and today's invoices.
2. **Open a visit's bill.** The consultation fee is already on it,
   because the note was signed. So is any medicine dispensed and any
   procedure performed.
   *Nothing here was typed by the cashier — the clinical modules put it
   there, inside their own transactions.*
3. **Add a manual line.** From the billable-item catalogue, or typed.
4. **Discount one line** — say 10% off the dressing. Then **discount
   the whole invoice** by 10%. Read the totals carefully: **the second
   discount does not re-discount the first**. (This was a real bug; a
   line's *own* discount is stored separately from its share of the
   invoice's, with a constraint that one can never exceed the other.)
5. **Try a discount above the limit.** Refused, naming what an
   administrator would have to approve.
6. **Issue the invoice.** It gets a gapless number, per branch, per
   year. The patient's name is frozen onto it as it was at that moment.
7. **Print it** ([13](../13-documents/README.md)).
8. **Take the money** ([12](../12-payment/README.md)).

## Try to break it

- **Try to edit a line that the system put there** — the consultation
  fee, a dispensed medicine. Refused; those are owned by whatever
  created them.
- **Try to change an issued invoice.** Refused by a trigger, not by the
  screen.
- **Void an issued invoice** (administrator, reason). Then **reissue**
  it — a new invoice, cross-referenced to the voided one, so the series
  stays gapless and the history reads correctly.
- **Try to void an invoice that has been paid.** Refused, and it checks
  the **payment rows** rather than the summary column on the invoice —
  so if the two ever disagreed, the answer would come from the money.
- **Fifty invoices at once.** The test does this; the numbers come out
  consecutive, because the series is allocated under a row lock.
- **Sell something to a walk-up** with no patient record. Billing →
  new sale, a name, lines, issue.

## What is deliberately not here

- **The fee schedule is one invented rule** (`BIL-OPEN-01`) — a flat
  RM 40 consultation. **A production blocker**: unlike a wrong stock
  figure, a wrong price is money the clinic does not get back. The same
  conversation settles the discount cap, which is also a guess.
- **Tax is off everywhere** (`BIL-OPEN-05`), which is right for most GP
  work and is nobody's professional opinion. Both modes are implemented
  and tested.
- **No administration screen for fees or billable items**
  (`BIL-OPEN-04`), which blocks the pricing conversation in practice.
- **The bill does not refresh itself** (`BIL-OPEN-06`) if a dispense
  happens while it is open. It reloads when the cashier does something,
  which in practice they do.

## Notes

<!-- yours -->
