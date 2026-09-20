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
| **INV-OPEN-01** | **There is no physical count, and so no opening stock (INV-F-16, INV-Q-05).** Every figure in the system today was typed in by somebody. A delivery can be marked as an opening balance, which is enough to start, and it is not the same as a clinic walking the shelves and agreeing what is there. **Without a real opening count, every later reconciliation is measuring drift from a guess.** | The count module is built — sessions, frozen expected quantities, blind entry, a variance report and an approval that posts `COUNT_ADJUST` — and the clinic counts once before go-live with somebody signing it off. The approval path is also what `INV-T-08` needs. |

## B. Built, and one step short of safe

| # | Item | Done when |
|---|---|---|
| **INV-OPEN-03** | **`move()` is the only write path by convention, not by grant (INV-R-02, INV-T-04).** The module exports the ledger and not the stock service, so no other module *can* receive a delivery. But the application's database role can still `UPDATE product_batch SET quantity_on_hand = 99`, and the only thing that would notice is the nightly job, the next morning. | The unprivileged role loses UPDATE on `quantity_on_hand` and INSERT on `stock_movement`, and `move()` goes through a `SECURITY DEFINER` function. Pairs with `TEN-OPEN-04`, which is the same piece of work from the tenancy side. |
| **INV-OPEN-04** | **A large adjustment needs no reauth (INV-R-08, INV-T-09).** Writing off RM 6,000 of stock takes the same three clicks as writing off RM 6. The audit entry records the value in ringgit, so it is *visible*; nothing stops it. | The `inventory.adjust_reauth_threshold_sen` tenant setting exists (default RM 500 at cost) and the service asks for reauth above it. The reauth machinery is built and used elsewhere; this is wiring plus a settings group. |
| **INV-OPEN-06** | **Alerts are computed, not remembered (INV-F-19, F-20, INV-T-11).** The on-hand view flags below-minimum and below-reorder, and the expiry filter works. There is no `stock_alert_state`, so there is no "fired once" semantics, nothing to acknowledge, and no `stock.low` event. A dashboard that recomputes on every page load is fine; an alert that fires on every movement would be noise. | `stock_alert_state` exists with acknowledge, and the events fire on the transition rather than on the state. Worth doing with `NTF`, which is what would carry them anywhere. |

## C. Not built

| # | Item | Done when |
|---|---|---|
| **INV-OPEN-05** | **No quarantine (INV-F-15).** Returned or damaged stock is adjusted out and gone. `quantity_quarantined` is on the batch, defaulted to zero, and nothing writes it. | Somebody needs to hold stock back without destroying it — a suspected-damaged delivery awaiting a supplier's answer. Until then, `DAMAGE` with a reason is honest and simpler. |
| **INV-OPEN-07** | **A barcode resolves a product, not a batch (INV-Q-07).** GS1 barcodes carry the batch and expiry in them, and the receiving screen makes somebody type both. | The clinic confirms their supplier packs carry GS1 and they have a scanner. Then parsing application identifiers 10 and 17 is an afternoon, and receiving gets much faster. |
| **INV-OPEN-08** | **Batch-based pricing is stored and never read.** `price_basis` and the batch's own `selling_price` exist. Nothing prices anything, because nothing bills. | `v0-11-billing.md`. |
| **INV-OPEN-09** | **No transfers between branches.** `TRANSFER_IN` and `TRANSFER_OUT` are in the enum with directions and labels, and no workflow creates them. | The pilot clinic has one branch. It becomes real the day it has two. |
| **INV-OPEN-10** | **No reorder suggestions or days-of-cover (INV-F-22).** `min_stock` and `reorder_level` are per branch and settable, and nothing computes usage from the ledger. | The ledger now holds the usage history this needs, so it is a query rather than a schema change. Worth doing once there are ninety days of real movements to average. |
| **INV-OPEN-11** | **No catalogue or stock screens for an administrator beyond the basics.** Stock has a screen: on-hand, batches, receiving, corrections, movement history. The *catalogue* still has none — adding a product or fixing a price is an API call or a CSV import. | A screen under `/admin`. This was `INV-CAT-OPEN-01` and is unchanged. |
| **INV-OPEN-12** | **`drug_class` is folded to lower case on write and displayed that way.** A prescription's snapshot reads "penicillins". Matching is case-insensitive either way, so this is cosmetic and it is visible to a doctor. | A display-case at the edge, or — better — the class becomes a pick from a fixed list, which `RX-OPEN-01` will want anyway. |

## D. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **INV-OPEN-13** | **Nothing dispenses.** `DISPENSE` and `DISPENSE_REVERSAL` are in the enum, with directions, and no caller. Prescribing deliberately never touches the ledger (`RX-T-09` asserts it). | `v0-08-dispensing.md`. It calls `move()` inside its own transaction, the way procedures do. |
| **INV-OPEN-14** | **Reconciliation mismatches log and nothing listens.** Identical in shape to `CON-OPEN-02`: an error-level line on a server nobody watches. | `NTF` (V1). Until then a one-line cron that greps for `STOCK MISMATCH` and emails is ten minutes of work and worth doing now. |
| **INV-OPEN-15** | **Purchasing is out of scope for V0 and the seam is ready.** A movement carries `reference_type` and `reference_id`; a goods-received note would set them to `grn`. | `PUR` (V1). |

---

## Closed on 2026-09-21

- `INV-CAT-OPEN-02`, open for about an hour: the product retirement
  registry has its first check. A product still on a shelf cannot be
  withdrawn from under it.
- `RX-OPEN-03`, open since this morning: a prescriber now sees how many
  are on the shelf beside each medicine, and whether that number is known
  at all.
- The retirement registry moved out of `catalogue.service.ts` into its own
  file. Declared after the service that injects it, it was a temporal dead
  zone: the decorator metadata read the class before it existed, and the
  whole module failed to load the moment anything injected it.
- The catalogue's tables were added to the test harness cleanup, and the
  stock and procedure tables with them.
