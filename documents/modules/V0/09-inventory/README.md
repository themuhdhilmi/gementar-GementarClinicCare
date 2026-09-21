# 09 · Inventory (INV)

What is on the shelves, which batch, when it expires, and whether the
count agrees with reality.

**Register:** [`../v0-09-inventory-end-item-OPEN.md`](../../v0-09-inventory-end-item-OPEN.md)

## Setup

```bash
npm run catalogue:seed --workspace @gementar/api
```

Sign in as **Dr Aisyah** for receiving and counts, **En Kamal** to see
the read-only view.

## Walk through

1. **Stock.** On-hand per product, with the nearest expiry.
2. **Receive stock.** A product, a batch number, an expiry, a quantity,
   a cost. The batch is created and the quantity is a *movement*, never
   a typed-in total.
3. **Receive the same product again** with a different batch and a
   nearer expiry. Now dispense some ([08](../08-dispensing/README.md)) — the
   nearer expiry goes first.
4. **Adjust a quantity** down, with a reason. The adjustment is a
   movement of its own; the original receipt is untouched.
5. **Write off an expired batch.** Same shape.
6. **Set a reorder level** on a product, then dispense below it. An
   alert appears on **Counts** — which holds three things: what needs
   attention, what is worth ordering, and the counts themselves. It
   fires **once, on the way down**, not on every movement afterwards.
7. **Restock above the level.** The alert clears. Go below again — it
   fires again, because a recurrence is news.
8. **Acknowledge an alert** without restocking. It stays but stops
   shouting, which is the honest state when the order is placed and the
   delivery is Thursday.

Then the count, also on **Counts**:

9. **Start a cycle count.** Leave *blind* ticked. Expected quantities
   are **frozen** the moment it opens, so what the shelf is compared
   against does not move while you are counting.
10. **Type what is on the shelf.** You cannot see the expected figure
    while typing it; the difference appears only after *Done counting*.
    A number on the sheet is a number people count towards.
11. **Approve it** as an administrator. One adjustment per disagreeing
    line, each pointing back at the count. **Stock → History** shows
    the movement as *"Corrected by a stock count"* with the balance it
    left. A line that agrees posts nothing — a movement of nothing is
    not a movement.
12. **Import opening stock from a spreadsheet.** Start an *Opening*
    count and attach a CSV of `sku, batch_no, expiry, quantity, cost`.
    It reports everything wrong with the file before writing anything,
    and refuses the whole file rather than importing half — a partly
    imported opening balance cannot be told from a complete one
    afterwards.

## Try to break it

- **Make a quantity negative** by adjusting below zero. Refused at the
  ledger.
- **Approve a count twice.** Refused.
- **Start a second count while one is open.** Refused: two people
  counting the same shelves against two frozen snapshots produce two
  different truths, and approving both applies the difference twice.
- **Submit with a box left blank.** Refused — a blank is not a zero,
  and *"we did not get to that shelf"* and *"there are none"* produce
  very different adjustments.
- **Open a count, then dispense something.** The expected figure does
  not move; it was frozen, so the dispense is not mistaken for a
  discrepancy.
- **Write to `quantity_on_hand` directly with SQL.** It works — and it
  should not (`INV-OPEN-03`, **a production blocker**). `move()` is the
  only write path by module boundary, which a compiler checks; nothing
  stops a mistaken direct `UPDATE`, and only the nightly job would
  notice, the next morning.
- **Run the reconciliation on demand:** Stock → the admin action, or
  `POST /admin/stock-reconciliation`. It compares the cached on-hand
  against the sum of movements and reports, never repairs.

## What is deliberately not here

- **Nobody has counted the shelves** (`INV-OPEN-01`). **A production
  blocker.** Every figure was typed in. Until a real opening count
  happens, later reconciliation measures drift from a guess, and the
  first time the shelf disagrees nobody knows which to trust.
- **No catalogue admin screen** (`INV-OPEN-11`) — products are seeded
  or `curl`'d.
- **No GS1 barcode parsing** (`INV-OPEN-07`), on purpose.

## Notes

<!-- yours -->
