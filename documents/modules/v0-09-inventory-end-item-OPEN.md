# Inventory — open end items

Everything about `INV` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

Inventory was built out of order and in two halves. The catalogue came
first, a phase early, because prescribing cannot check an allergy without
a generic name. The stock ledger came next, also early, because a
procedure that does not deduct what it used makes the stock figures wrong
every time it happens. What is left is the management layer around the
ledger: counts, quarantine, alerts and purchasing.

`INV-OPEN-01` is the one that decides whether any of the numbers mean
anything on day one.

| | |
|---|---|
| **Module** | [v0-09-inventory.md](v0-09-inventory.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides whether the numbers start true

| # | Item | Done when |
|---|---|---|
| **INV-OPEN-01** | **Nobody has counted the shelves (INV-Q-05).** The count module is now built — sessions, frozen expected quantities, blind entry, discovered batches, a variance report, a spreadsheet import, and an approval that posts the difference through the ledger. What has not happened is a clinic walking its own shelves and agreeing what is there. **Until then every figure in the system was typed in by somebody, and every later reconciliation measures drift from a guess.** | The clinic counts once before go-live, on a closed day, and an administrator approves it. Everything needed is in place: `Counts` in the sidebar, or a spreadsheet with `sku, batch_no, expiry, quantity, cost`. |

## B. Getting the first numbers in

| # | Item | Done when |
|---|---|---|
| ~~**INV-OPEN-02**~~ | ~~**There is no import for opening balances.**~~ **Closed 2026-09-21.** `sku, batch_no, expiry, quantity, cost`, with a dry run that names every problem — unknown code, missing batch number, unusable expiry, a lot listed twice — before anything is written. It fills in a count rather than posting stock, so a person still approves it, and it refuses the whole file rather than importing half of one. | Done. |

## C. Built, and one step short of safe

| # | Item | Done when |
|---|---|---|
| **INV-OPEN-03** | **`move()` is the only write path by convention, not by grant (INV-R-02, INV-T-04).** The module exports the ledger and not the stock service, so no other module *can* receive a delivery. But the application's database role can still `UPDATE product_batch SET quantity_on_hand = 99`, and the only thing that would notice is the nightly job, the next morning. | The unprivileged role loses UPDATE on `quantity_on_hand` and INSERT on `stock_movement`, and `move()` goes through a `SECURITY DEFINER` function. Pairs with `TEN-OPEN-04`, which is the same piece of work from the tenancy side. |
| ~~**INV-OPEN-04**~~ | ~~**A large adjustment needs no reauth (INV-R-08, INV-T-09).**~~ **Closed 2026-09-21.** `inventory.adjustReauthThresholdSen` is a tenant setting, default RM 500 at cost, and a write-off at or above it asks for the password again before anything moves. Small adjustments are untouched, because most of them are a box of gauze. | Done. |
| ~~**INV-OPEN-06**~~ | ~~**Alerts are computed, not remembered.**~~ **Closed 2026-09-21.** `stock_alert_state` remembers each condition, the event fires once on the transition rather than on every movement, acknowledging hides an alert without pretending the shelf is full, and a nightly sweep catches expiry, which becomes true through time rather than through a movement. | Done. |

## D. Not built

| # | Item | Done when |
|---|---|---|
| **INV-OPEN-16** | **Movement history has no CSV export (INV-F-17).** The history is on screen, filterable by product, batch, type and date, with the running balance. Getting it into a spreadsheet means copying it. | A download button on the movements view. Small, and worth doing the first time somebody asks for last month's usage. |
| **INV-OPEN-17** | **Expiry bands are fixed at 90, 60 and 30 days.** §20 asks for them to be tenant-configurable. Three constants in `alert.service.ts`. | A settings group, once a clinic says the defaults are wrong. Nobody has. |

| # | Item | Done when |
|---|---|---|
| ~~**INV-OPEN-05**~~ | ~~**Quarantine is a number with no workflow (INV-F-15).**~~ **Closed 2026-09-21.** What is held is listed per batch, and leaves in one of three directions with a reason: back to the shelf (which posts a movement, and is refused for an expired batch), destroyed, or returned to the supplier. It no longer only accumulates. | Done. |
| **INV-OPEN-07** | **A barcode resolves a product, not a batch (INV-Q-07).** GS1 barcodes carry the batch and expiry in them, and the receiving screen makes somebody type both. | The clinic confirms their supplier packs carry GS1 and they have a scanner. Then parsing application identifiers 10 and 17 is an afternoon, and receiving gets much faster. |
| **INV-OPEN-08** | **Batch-based pricing is stored and never read.** `price_basis` and the batch's own `selling_price` exist. Nothing prices anything, because nothing bills. | `v0-11-billing.md`. |
| **INV-OPEN-09** | **No transfers between branches.** `TRANSFER_IN` and `TRANSFER_OUT` are in the enum with directions and labels, and no workflow creates them. | The pilot clinic has one branch. It becomes real the day it has two. |
| ~~**INV-OPEN-10**~~ | ~~**No reorder suggestions or days-of-cover (INV-F-22).**~~ **Closed 2026-09-21.** Computed from what actually left the shelf over ninety days — dispensing and procedure use, not receipts. A product nothing has moved shows "not used" rather than an infinity, because "it will last forever" is a lie a screen should not tell. | Done. |
| **INV-OPEN-11** | **No catalogue or stock screens for an administrator beyond the basics.** Stock has a screen: on-hand, batches, receiving, corrections, movement history. The *catalogue* still has none — adding a product or fixing a price is an API call or a CSV import. | A screen under `/admin`. Carried over unchanged from the catalogue-only register this replaced. |
| **INV-OPEN-12** | **`drug_class` is folded to lower case on write and displayed that way.** A prescription's snapshot reads "penicillins". Matching is case-insensitive either way, so this is cosmetic and it is visible to a doctor. | A display-case at the edge, or — better — the class becomes a pick from a fixed list, which `RX-OPEN-01` will want anyway. |

## E. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| ~~**INV-OPEN-13**~~ | ~~**Nothing dispenses.**~~ **Closed 2026-09-21.** `DSP` calls `move()` inside its own transaction, the way procedures do. Prescribing still never touches the ledger, and `RX-T-09` now asserts that no movement references a prescription rather than that the table is absent. | Done. |
| **INV-OPEN-14** | **Reconciliation mismatches log and nothing listens.** Identical in shape to `CON-OPEN-02`: an error-level line on a server nobody watches. | `NTF` (V1). Until then a one-line cron that greps for `STOCK MISMATCH` and emails is ten minutes of work and worth doing now. |
| **INV-OPEN-15** | **Purchasing is out of scope for V0 and the seam is ready.** A movement carries `reference_type` and `reference_id`; a goods-received note would set them to `grn`. | `PUR` (V1). |

---

## Closed on 2026-09-21

- The catalogue-only register's second item, open for about an hour: the product retirement
  registry has its first check. A product still on a shelf cannot be
  withdrawn from under it.
- `TEN-OPEN-16`, open since v0-04: the branch deactivation registry has
  its stock check. A branch with batches on its shelves cannot be closed,
  which would otherwise strand them where nothing shows them.
- `RX-OPEN-03`, open since this morning: a prescriber now sees how many
  are on the shelf beside each medicine, and whether that number is known
  at all.
- The retirement registry moved out of `catalogue.service.ts` into its own
  file. Declared after the service that injects it, it was a temporal dead
  zone: the decorator metadata read the class before it existed, and the
  whole module failed to load the moment anything injected it.
- The catalogue's tables were added to the test harness cleanup, and the
  stock and procedure tables with them.
