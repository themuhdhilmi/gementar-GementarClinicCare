# Inventory (INV)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Built. Open items in [v0-09-inventory-end-item-OPEN.md](v0-09-inventory-end-item-OPEN.md) |
| **Delivery phase** | Phase 3 |
| **Spec sections** | 9 |
| **Depends on** | TEN, IAM, AUD |
| **Depended on by** | RX, DSP, PRC, BIL, RPT, PUR, BRN |
| **Est. effort** | ~45 h |

> The stock invariant (`../04-data-model.md`) is non-negotiable. If the system says 40 and the shelf says 12, the clinic stops trusting the system — and that distrust spreads to the parts that are correct.

---

## 1. Purpose & business value

What is on the shelf, and proof of how it got there. Two things live here: the **catalogue** (products the tenant sells or uses, shared across branches) and the **stock** (batches with expiry, per branch, with an append-only ledger of every movement).

Inventory is where clinic software most often loses trust. The design defends against that with one rule — the ledger is truth and the cached quantity is only a cache — and one habit: a nightly reconciliation that shouts when they disagree.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `stock.read` — view products, batches, movements | ✓ | ✓ | ✓ | ✓ |
| `catalogue.write` — create/edit products, prices | ✓ | – | – | – |
| `stock.receive` — stock-in (manual / GRN) | ✓ | – | ✓ | ✓ |
| `stock.adjust` — adjustments, damage, expiry write-off | ✓ | – | – | – |
| `stock.count` — enter physical counts | ✓ | – | ✓ | ✓ |
| Approve a count (posts adjustments) | ✓ | – | – | – |
| Configure alerts / thresholds | ✓ | – | – | – |

## 3. Functional requirements

### Catalogue (tenant-scoped)
| ID | Requirement | Priority |
|---|---|---|
| INV-F-01 | Product: SKU (tenant-unique, auto or manual), name, type (`MEDICINE`, `CONSUMABLE`, `SUPPLY`, `SERVICE_ITEM`), category (tree, 2 levels), brand, **generic_name** (required for MEDICINE), **drug_class** (required for antibiotics/NSAIDs/opioids; recommended all), form (tab, cap, syrup, injection, cream, inhaler…), strength (text + parsed value/unit), `dispense_unit` (tab, ml, bottle, tube, pcs…), `pack_size` (units per pack), `is_pack_dispensed`, `is_controlled`, `is_cold_chain`, `max_daily_dose`, default dose/route/frequency (RX prefill), barcode(s), notes, status. | Must |
| INV-F-02 | Pricing: `selling_price` (sen, per dispense unit), `price_basis` (`PRODUCT` list price or `BATCH` markup), optional `markup_pct` for batch-based pricing; price history with effective dates. Branch price overrides → V2 `BRN`. | Must |
| INV-F-03 | Stock control fields per product **per branch**: `min_stock`, `reorder_level`, `reorder_qty`, `preferred_supplier` (V1). | Must |
| INV-F-04 | Catalogue import from CSV (dry-run, validation, dedupe by SKU/name+strength). | Must |
| INV-F-05 | Product deactivation blocked while any branch has on-hand > 0; deactivated products remain on historical records. | Must |
| INV-F-06 | Product search: name, generic, brand, SKU, barcode; type filter; on-hand at the caller's branch in results. | Must |
| INV-F-07 | Product merge (duplicates from import), re-pointing batches and history. | Could |

### Batches & stock (branch-scoped)
| ID | Requirement | Priority |
|---|---|---|
| INV-F-08 | Batch: product, branch, batch_no, expiry (month precision allowed → last day of month), cost_price (sen/unit), selling_price (if batch-priced), `quantity_on_hand`, received date, source (manual/GRN/transfer), supplier (V1), barcode. | Must |
| INV-F-09 | Non-batched products (consumables without lot numbers): a synthetic batch `NB-<product>` with null expiry per branch, so every movement still references a batch. | Must |
| INV-F-10 | **Stock movement ledger** — append-only, one row per quantity change: type (`RECEIVE`, `DISPENSE`, `DISPENSE_REVERSAL`, `CONSUME` (procedures), `ADJUST_IN`, `ADJUST_OUT`, `DAMAGE`, `EXPIRE`, `RETURN_TO_SUPPLIER`, `RETURN_FROM_PATIENT`, `QUARANTINE_IN`, `QUARANTINE_OUT`, `TRANSFER_OUT`, `TRANSFER_IN`, `COUNT_ADJUST`, `OPENING`), signed quantity, unit cost snapshot, reference (type + id), reason, actor, timestamp. | Must |
| INV-F-11 | **Ledger API** used by DSP/PRC/PUR: `move(tx, { batchId, type, qty, ref, reason })` which locks the batch, validates non-negative result, inserts the movement, updates the cache — all within the caller's transaction. No other write path to `stock_movement` or `quantity_on_hand`. | Must |
| INV-F-12 | Manual stock-in: product → new or existing batch → qty, cost, expiry → `RECEIVE`. Multi-line entry for a delivery. Supplier reference free text (structured in V1 `PUR`). | Must |
| INV-F-13 | Adjustments (`ADJUST_IN/OUT`, `DAMAGE`, `EXPIRE`) require a reason from a controlled list + free text; `stock.adjust` only; amounts over a tenant threshold (value in sen) require reauth. | Must |
| INV-F-14 | Expiry write-off workflow: list batches expiring ≤ N days / expired → select → `EXPIRE` movements → optional disposal note. | Must |
| INV-F-15 | Quarantine location per branch: returned/damaged stock moves `QUARANTINE_IN` (not saleable, not FEFO-eligible); from quarantine → `DAMAGE`/`RETURN_TO_SUPPLIER`/`QUARANTINE_OUT` (back to stock, ADMIN, reason). | Should |
| INV-F-16 | **Physical count**: create a count session (whole branch, category, or ad-hoc list); freeze expected quantities; enter counted per batch (blind entry option); variance report; ADMIN approves → `COUNT_ADJUST` movements per variance with the session as reference. Opening stock is a count session of type `OPENING`. | Must |
| INV-F-17 | Stock movement history per product/batch with running balance; filter by type/date/actor; export CSV. | Must |
| INV-F-18 | On-hand view per branch: product, total on-hand, per-batch breakdown, nearest expiry, days of cover (avg daily usage last 90 d), below-min flag. | Must |

### Alerts & reconciliation
| ID | Requirement | Priority |
|---|---|---|
| INV-F-19 | Low-stock alert when on-hand ≤ `reorder_level`; critical when ≤ `min_stock`; shown on dashboard (RPT) and as `stock.low` event. | Must |
| INV-F-20 | Expiry alert at 90/60/30 days (tenant-configurable) and on expiry; `stock.expiring` event; dashboard list. | Must |
| INV-F-21 | **Nightly reconciliation**: for every batch, recompute `Σ stock_movement.quantity`, compare to `quantity_on_hand`; any mismatch → `stock.reconciliation_mismatch` event, alert to you, entry on admin dashboard; job never auto-corrects. | Must |
| INV-F-22 | Days-of-cover and suggested reorder list (feeds PUR in V1; CSV in V0). | Should |
| INV-F-23 | Cold-chain flag surfaces on receiving and on the on-hand view (no sensor integration in V0). | Could |

## 4. Key workflows

**Opening stock (once, closed day)**
1. Catalogue imported and reviewed (generic names, classes, prices)
2. ADMIN creates count session `OPENING` for the branch → printed count sheets by shelf/category
3. Staff count per batch (batch no, expiry, qty) → entered (or CSV)
4. Variance report meaningless for OPENING (expected 0) → approve → `OPENING` movements → on-hand set
5. Reconciliation job runs that night → zero mismatches expected

**Delivery arrives (V0 manual; V1 via PO/GRN)**
1. FRONTDESK → Stock-in → scan/select product → batch no, expiry, qty, unit cost → repeat per line → Post → `RECEIVE` movements

**Dispense (DSP calls the ledger)**
1. `move(tx, { batchId, type:'DISPENSE', qty:-15, ref:{dispense_item}, ... })` inside DSP's transaction

**Expired stock**
1. Dashboard "12 batches expired/expiring" → Expiry write-off → select → reason "expired" → post → `EXPIRE` movements; batches drop out of FEFO

**Monthly count**
1. Count session by category → blind entry → variance report → investigate large variances → approve → `COUNT_ADJUST`

## 5. Data model

```
product   (tenant-scoped)
  id              uuid pk
  tenant_id       uuid not null
  sku             text not null
  name            text not null
  type            enum(MEDICINE, CONSUMABLE, SUPPLY, SERVICE_ITEM) not null
  category_id     uuid → product_category
  brand           text
  generic_name    text                      -- required for MEDICINE (check constraint)
  drug_class      text
  form            text
  strength_text   text, strength_value numeric(12,4), strength_unit text
  dispense_unit   text not null
  pack_size       int not null default 1
  is_pack_dispensed bool not null default false
  is_batched      bool not null default true
  is_controlled   bool not null default false
  is_cold_chain   bool not null default false
  max_daily_dose  numeric(12,4), max_daily_dose_unit text
  default_dose    numeric(10,3), default_dose_unit text, default_route text, default_frequency text
  selling_price   bigint not null default 0         -- sen per dispense unit
  price_basis     enum(PRODUCT, BATCH) not null default 'PRODUCT'
  markup_pct      numeric(6,2)
  barcodes        text[] not null default '{}'
  notes           text
  status          enum(ACTIVE, INACTIVE) not null default 'ACTIVE'
  UNIQUE (tenant_id, sku)
  INDEX gin (tenant_id, (name || ' ' || coalesce(generic_name,'') || ' ' || coalesce(brand,'')) gin_trgm_ops)
  INDEX gin (barcodes)
  CHECK (type <> 'MEDICINE' OR generic_name IS NOT NULL)

product_category
  id uuid pk, tenant_id, parent_id uuid, name text, sort int

product_price_history
  id uuid pk, tenant_id, product_id, selling_price bigint, effective_from timestamptz, set_by uuid, reason text

product_branch_setting
  tenant_id, product_id, branch_id  (pk)
  min_stock numeric(12,3), reorder_level numeric(12,3), reorder_qty numeric(12,3)
  preferred_supplier_id uuid          -- V1

product_batch   (branch-scoped)
  id              uuid pk
  tenant_id       uuid not null
  branch_id       uuid not null
  product_id      uuid not null → product
  batch_no        text not null              -- 'NB' for non-batched synthetic
  expiry_date     date                       -- null only for non-batched
  cost_price      bigint not null            -- sen per dispense unit
  selling_price   bigint                     -- if BATCH-priced
  quantity_on_hand numeric(12,3) not null default 0
  quantity_quarantined numeric(12,3) not null default 0
  received_at     timestamptz not null
  source_type     text, source_id uuid       -- 'manual' | 'grn' | 'transfer' | 'opening'
  supplier_id     uuid                       -- V1
  barcode         text
  status          enum(ACTIVE, DEPLETED, EXPIRED, BLOCKED) not null default 'ACTIVE'
  UNIQUE (branch_id, product_id, batch_no)
  INDEX (branch_id, product_id, expiry_date)       -- FEFO
  INDEX (branch_id, expiry_date) WHERE quantity_on_hand > 0
  CHECK (quantity_on_hand >= 0)
  CHECK (quantity_quarantined >= 0)

stock_movement   (append-only; partition by month when > 5 M)
  id              uuid pk
  tenant_id       uuid not null
  branch_id       uuid not null
  product_id      uuid not null
  batch_id        uuid not null → product_batch
  type            enum(...) not null          -- INV-F-10
  quantity        numeric(12,3) not null      -- signed
  unit_cost       bigint not null             -- sen, snapshot
  balance_after   numeric(12,3) not null      -- batch on-hand after this movement
  reference_type  text, reference_id uuid
  reason_code     text, reason_text text
  performed_by    uuid, performed_by_name text
  occurred_at     timestamptz not null default now()
  INDEX (batch_id, occurred_at)
  INDEX (branch_id, product_id, occurred_at)
  INDEX (tenant_id, type, occurred_at)
  INDEX (reference_type, reference_id)
  CHECK (quantity <> 0)

stock_count
  id uuid pk, tenant_id, branch_id
  type        enum(OPENING, FULL, CYCLE, ADHOC) not null
  scope       jsonb                     -- category ids / product ids
  status      enum(OPEN, SUBMITTED, APPROVED, CANCELLED) not null
  blind       bool not null default false
  frozen_at   timestamptz, created_by uuid, submitted_by uuid, approved_by uuid, approved_at timestamptz
  notes text

stock_count_line
  id uuid pk, tenant_id, count_id → stock_count
  batch_id uuid → product_batch (nullable for new batches discovered), product_id uuid not null
  new_batch_no text, new_expiry date, new_cost bigint   -- for batches found on shelf but not in system
  expected numeric(12,3), counted numeric(12,3), variance numeric(12,3)
  counted_by uuid, counted_at timestamptz, note text
  UNIQUE (count_id, batch_id)

stock_alert_state
  tenant_id, branch_id, product_id, kind enum(LOW, CRITICAL, EXPIRING_90, EXPIRING_60, EXPIRING_30, EXPIRED)
  first_seen timestamptz, last_seen timestamptz, acknowledged_by uuid, acknowledged_at timestamptz
  pk (branch_id, product_id, kind)

reconciliation_run
  id uuid pk, tenant_id, run_at, batches_checked int, mismatches int, details jsonb
```

## 6. State machines

**Batch**: `ACTIVE` → `DEPLETED` (on-hand 0 and quarantined 0; auto) → `ACTIVE` (if stock returns); `ACTIVE` → `EXPIRED` (expiry passed; auto nightly; FEFO-excluded); any → `BLOCKED` (ADMIN, e.g. recall; reason).
**Count**: `OPEN` → `SUBMITTED` → `APPROVED` | `CANCELLED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| INV-R-01 | `product_batch.quantity_on_hand = Σ stock_movement.quantity` for that batch, always. | Ledger API writes both in one transaction; nightly job verifies |
| INV-R-02 | The only write path to `stock_movement` and `quantity_on_hand` is `LedgerService.move()`; the app role has no direct UPDATE grant on `quantity_on_hand` outside a security-definer function used by `move()`. | DB grants + function |
| INV-R-03 | `move()` acquires `SELECT … FOR UPDATE` on the batch before computing the new balance. | Service |
| INV-R-04 | On-hand can never go negative. | `CHECK` constraint + service pre-check |
| INV-R-05 | Every movement carries `balance_after`, so the ledger is self-auditing without recomputation. | Service |
| INV-R-06 | `stock_movement` is append-only; no UPDATE/DELETE grants. | DB grants + trigger |
| INV-R-07 | Expired or BLOCKED batches are excluded from FEFO and cannot be dispensed. | Query + DSP check |
| INV-R-08 | Adjustments above `inventory.adjust_reauth_threshold_sen` (default RM500 at cost) require reauth. | Service |
| INV-R-09 | Price changes are recorded in history with actor and reason; the current price is a projection of history. | Service |
| INV-R-10 | Reconciliation never auto-corrects; humans post `COUNT_ADJUST`. | Job design |
| INV-R-11 | `generic_name` required for MEDICINE (RX allergy matching depends on it). | CHECK constraint |
| INV-R-12 | Catalogue is tenant-scoped; batches, movements, counts, alerts are branch-scoped. | Schema |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/products?q=&type=&category=&branchId=` | `stock.read` | With on-hand at branch |
| GET | `/products/:id` | `stock.read` | + batches per branch |
| POST | `/products` | `catalogue.write` | |
| PATCH | `/products/:id` | `catalogue.write` | Price change → history + reason |
| POST | `/products/:id/deactivate` | `catalogue.write` | Guarded |
| POST | `/products/import` | `catalogue.write` | CSV, dry-run |
| CRUD | `/product-categories` | `catalogue.write` | |
| PUT | `/branches/:b/products/:id/settings` | `catalogue.write` | min/reorder |
| GET | `/branches/:b/stock?belowMin=&expiringDays=&category=` | `stock.read` | On-hand view |
| GET | `/branches/:b/batches?productId=` | `stock.read` | |
| POST | `/branches/:b/stock-in` | `stock.receive` | Multi-line; creates batches; `RECEIVE` |
| POST | `/branches/:b/adjustments` | `stock.adjust` (+reauth over threshold) | `{ batchId, type, qty, reasonCode, reasonText }` |
| POST | `/branches/:b/expiry-writeoff` | `stock.adjust` | Batch ids → `EXPIRE` |
| POST | `/branches/:b/quarantine/:batchId/release` | `stock.adjust` | |
| GET | `/branches/:b/movements?productId=&batchId=&type=&from=&to=` | `stock.read` | Running balance; CSV |
| POST | `/branches/:b/counts` | `stock.count` | Create session; freezes expected |
| GET | `/counts/:id` | `stock.count` | Lines |
| PUT | `/counts/:id/lines` | `stock.count` | Bulk entry |
| POST | `/counts/:id/submit` | `stock.count` | |
| POST | `/counts/:id/approve` | `stock.adjust` + reauth | Posts `COUNT_ADJUST` |
| GET | `/branches/:b/alerts` | `stock.read` | Low/expiring |
| POST | `/alerts/:id/acknowledge` | `stock.read` | |
| GET | `/branches/:b/reorder-suggestions` | `stock.read` | CSV |
| GET | `/admin/reconciliation-runs` | `admin.settings` | |

Internal (not HTTP): `LedgerService.move(tx, MoveInput): Promise<StockMovement>`; `LedgerService.suggestFefo(tx, branchId, productId, qty)`.

## 9. Domain events

**Emits:** `catalogue.changed` `{ productId, fields }`, `catalogue.price_changed`, `stock.moved` `{ batchId, type, qty, balanceAfter, ref }`, `stock.low`, `stock.critical`, `stock.expiring`, `stock.expired`, `stock.reconciliation_mismatch`, `stock.count_approved`, `batch.blocked`
**Consumes:** `dispense.completed` etc. are *not* consumed — DSP calls the ledger directly inside its transaction (events would break atomicity). `goods.received` (V1 PUR) likewise calls `move()`.

## 10. Audit events

`catalogue.changed`, `catalogue.price_changed` (before/after), every `ADJUST_*`/`DAMAGE`/`EXPIRE`/`COUNT_ADJUST`/`QUARANTINE_OUT` movement with reason and actor, `stock.count_approved` (variance summary), `batch.blocked`, `stock.import`.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Catalogue | Table with search, type/category filters, on-hand at my branch, price, status; edit drawer; import wizard |
| Product detail | Master data; per-branch settings; batches table (expiry-coloured); movement history with running balance; price history |
| Stock on hand | Branch view; filters below-min / expiring; days of cover; export |
| Stock-in | Line-based form; product search with barcode focus; batch no + expiry (MM/YYYY accepted) + qty + cost; running total; post |
| Adjustment | Batch picker; type; reason code + text; value shown; reauth if over threshold |
| Expiry write-off | List with checkboxes; total cost value; post |
| Count session | Setup (scope, blind); printable count sheet; entry grid (keyboard-first; barcode jumps to row); variance report with value; approve |
| Alerts | Grouped low/critical/expiring; acknowledge; link to reorder list |
| Admin → Reconciliation | Last runs; mismatches with batch links |

## 12. Validation

- SKU `^[A-Z0-9-]{2,32}$`; name 2–200
- Strength parses to value + unit when provided (e.g. `500 mg`, `5 mg/5 ml`)
- Expiry ≥ today on receive (past expiry needs `stock.adjust` and reason — receiving expired stock is a deliberate act); month-only → last day
- Quantity > 0 on receive; cost ≥ 0
- Adjustment qty ≠ 0; reason code from list
- Count line: counted ≥ 0; new-batch lines require batch no + expiry (if batched)
- Barcode unique per tenant across products

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| INV-N-01 | `move()` ≤ 20 ms p95 (single-row lock, one insert, one update). |
| INV-N-02 | FEFO suggestion for one product ≤ 10 ms (indexed by branch/product/expiry). |
| INV-N-03 | Reconciliation for 20 000 batches ≤ 2 min; runs at 02:00 branch time. |
| INV-N-04 | Movement history query for a product over a year ≤ 200 ms. |
| INV-N-05 | Catalogue import of 5 000 rows ≤ 1 min. |
| INV-N-06 | Stock-in form: 20 lines entered in ≤ 5 min by a trained user (keyboard + barcode). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Same batch number received twice (second delivery of same lot) | Adds to the existing batch row if cost matches; if cost differs, creates a suffixed batch (`LOT123-2`) — cost basis matters for FIN. |
| Delivery includes expired or near-expired stock | Receive allowed with warning; near-expiry flagged immediately. |
| Product changes from non-batched to batched | Existing synthetic `NB` batch remains until depleted; new receipts require batch no. |
| Count finds a batch not in the system | Count line with new batch details → approval creates the batch and an `OPENING`-type movement. |
| Count variance is large (> 20% or > RM200) | Highlighted; approval requires a note per such line. |
| Nightly reconciliation finds a mismatch | Alert to you; batch flagged on dashboard; investigate via movement history (`balance_after` chain makes the break point obvious); post a `COUNT_ADJUST` with root cause in the reason. |
| Product deactivated with stock at another branch | Blocked; message names the branch. |
| Price changed mid-day | New dispenses use the new price; already-created invoice lines keep their snapshot. |
| Cold-chain excursion | No sensor; staff record a `DAMAGE` movement with reason "cold chain". |
| Recall notice | ADMIN blocks the batch → excluded from FEFO; quarantine → return to supplier. |

## 15. Compliance

- Controlled substances: batch-level tracking + register (DSP) supports inspection.
- Expiry control prevents dispensing expired medicines (regulatory and safety).
- Cost snapshots on movements are the basis for COGS (FIN, V1) and for stock valuation.
- Movement ledger is the audit trail for any stock query; adjustments always carry reason and actor.

## 16. Reporting outputs

- Stock on hand and valuation (at cost) per branch (RPT; FIN)
- Low / critical / expiring / expired lists (dashboard)
- Movement summary by type per period (receipts, dispensed, adjustments, write-offs at cost)
- Stock turnover and days of cover per product (ANL)
- Shrinkage: `ADJUST_OUT + DAMAGE + COUNT_ADJUST(−)` at cost per period
- Reconciliation history

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| INV-T-01 | Given a batch with 10, when `move(-4)` then `move(-6)`, then on-hand 0, two movements with `balance_after` 6 and 0. |
| INV-T-02 | Given a batch with 5, when `move(-6)`, then rejected and no movement exists. |
| INV-T-03 | Given 20 parallel `move(-1)` on a batch of 10, then exactly 10 succeed; on-hand 0; 10 movements. |
| INV-T-04 | Given a direct `UPDATE product_batch SET quantity_on_hand = 99` as the app role, then permission denied. |
| INV-T-05 | Given a batch whose cached quantity is tampered via a privileged role, when reconciliation runs, then a mismatch is reported and the cache is not changed. |
| INV-T-06 | Given expiry `11/2026` on stock-in, then `expiry_date = 2026-11-30`. |
| INV-T-07 | Given a batch expires today, when FEFO is asked, then it is excluded; when DSP tries it, then 422. |
| INV-T-08 | Given a count with expected 30, counted 27, when approved, then a `COUNT_ADJUST` of −3 exists referencing the count. |
| INV-T-09 | Given an adjustment worth RM600 at cost, when posted without reauth, then 401 reauth-required. |
| INV-T-10 | Given a MEDICINE product without `generic_name`, when created, then 422. |
| INV-T-11 | Given on-hand drops to ≤ reorder_level, then `stock.low` is emitted once (not on every subsequent movement) until acknowledged or replenished. |
| INV-T-12 | Given a price change, then `product_price_history` has a new row and the previous invoice lines are unchanged. |

## 18. Migration & rollout

- **Catalogue first** (before R2, because RX needs it): export from the clinic's current system or supplier invoices; map generic names + drug classes with the doctor; import with dry-run
- **Opening stock** (before R3): a closed day or a weekend; count sheets printed by shelf; two people count; entered same day; reconciliation that night
- First month: weekly cycle count of top-20 products; investigate every variance — the goal is to find *process* problems (e.g. samples given without recording) before they compound
- Historical movements are not migrated; opening balances are the starting ledger

## 19. Out of scope

- Suppliers, purchase orders, goods receipt notes → V1 `PUR`
- Stock transfer between branches, branch pricing, central purchasing → V2 `BRN`
- Cold-chain sensor integration → V3
- Serial-number tracking → not planned
- Consignment stock → not planned
- Automated reorder to supplier → V2

## 20. Open questions

| ID | Question | Who | Answer |
|---|---|---|---|
| INV-Q-01 | Roughly how many SKUs? How many are batched vs consumables? | Pilot clinic | **Not answered.** Built for a few thousand, which is an order of magnitude above a GP clinic; the FEFO index and the on-hand view are the two things that would care, and both are indexed for it. |
| INV-Q-02 | Do they track batch/expiry today at all? | Pilot clinic | **Not answered, and the system does not require them to.** `is_batched = false` gives a product one synthetic `NB` batch per branch, so the ledger has no special case and a clinic that tracks nothing still gets correct totals. Turning batching on for a product later is a setting, not a migration. |
| INV-Q-03 | Is there an existing stock list to import (format)? | Pilot clinic | **Not answered, and both halves are now built.** The catalogue imports from CSV, and so does an opening count: `sku, batch_no, expiry, quantity, cost`, with a dry run that names every problem before anything is written. The import fills in a count rather than posting stock, so a person still approves it. |
| INV-Q-04 | Selling price per product (list) or per batch (markup on cost)? | Pilot clinic owner | **Built for both, defaulting to per product.** `price_basis` is on the product and `selling_price` on the batch; nothing reads the batch price yet because nothing bills. `INV-OPEN-08`. |
| INV-Q-05 | When can an opening count happen? Who counts? | Pilot clinic | **Not answered; the machinery is ready.** An `OPENING` count expects nothing, takes either typed entry or a spreadsheet, and posts `OPENING` movements on approval. What is missing is a closed day and somebody to sign it off — `INV-OPEN-01`. |
| INV-Q-06 | Do they hold cold-chain items (vaccines, insulin)? | Pilot clinic | **Assumed yes**, because the procedure list includes two vaccines. `is_cold_chain` is on the product and shown on the receiving and perform screens. No sensors, as §19 says. |
| INV-Q-07 | Do they use barcode scanners; do supplier packs carry GS1 barcodes with batch/expiry? | Pilot clinic | **Not answered.** A scanned barcode resolves a product exactly, over a GIN index. Parsing a GS1 barcode into batch and expiry is not built — `INV-OPEN-07`. |

## 21. Definition of done

- [x] **All Must requirements implemented** — the ledger, batches, receiving, adjustments, expiry write-off, physical counts, alerts, on-hand and movement history. `INV-F-17`'s CSV *export* is the one piece missing (`INV-OPEN-16`); everything else is built, including the Shoulds — quarantine, reorder suggestions and days of cover.
- [ ] **INV-T-01 … T-12 green** — eleven of the twelve. Only `T-04` is outstanding, and it cannot pass until the unprivileged role exists on a real host (`INV-OPEN-03`); it is an operations step, not code. 48 tests in `test/stock.e2e-spec.ts`, plus 10 unit tests on movement kinds and expiry parsing.
- [ ] **`move()` is the only write path — verified by grants and a grep** — true by construction and by module boundary: `StockModule` exports `LedgerService` and not `StockService`. It is **not** yet verified by a database grant, which is what would make it true against a mistake rather than against a convention. `INV-OPEN-03`.
- [x] **Reconciliation job scheduled, with a recorded zero-mismatch run** — 04:15 nightly, per tenant, and a run is recorded whether or not anything was wrong. It logs at error level and alerts nowhere, which is `CON-OPEN-02`'s problem restated.
- [x] **Catalogue loaded with `generic_name` on 100% of medicines** — enforced: the prescribing service refuses a medicine without one, so it cannot quietly stop being true. Drug classes on the seeded list; the clinic's own list is `RX-OPEN-01`.
- [ ] **Opening stock count completed and signed off** — `INV-OPEN-01`.
- [ ] **One week of live use with top-10 products matching physical count** — `INV-OPEN-01`, after R3.
- [x] **Open questions answered** — §20, four of seven with "asked, not answered, here is what was built in the meantime".

### Traceability

| Requirement | Where it lives | Proved by |
|---|---|---|
| INV-F-01 … F-07 catalogue | `CatalogueService` | 24 tests in `test/catalogue.e2e-spec.ts` |
| INV-F-05 retirement blocked | `ProductRetirementRegistry` + `StockModule` | "a product with stock on the shelf cannot be withdrawn" |
| INV-F-06 search with on-hand | `ProductStockLookup` | "a product search says how many are on the shelf" |
| INV-F-08 batches, month expiry | `StockService.batchFor`, `parseExpiry` | INV-T-06, plus 5 unit tests on leap years and refusals |
| INV-F-09 synthetic batch | `LedgerService.nonBatched` | "gives an unbatched product one synthetic batch per branch" |
| INV-F-10 the ledger | `stock_movement`, `DIRECTION` | A unit test asserts every enum member has a direction and a label |
| INV-F-11 `move()` | `LedgerService.move` | INV-T-01, T-02, T-03 |
| INV-F-12 stock-in | `StockService.receive` | 7 tests, including all-or-nothing |
| INV-F-13 adjustments | `StockService.adjust` | Reason required, from a controlled list |
| INV-F-14 expiry write-off | `StockService.writeOffExpired` | Refuses a batch that has not expired |
| INV-F-15 quarantine | `releaseQuarantine`, `quarantine` | "releases held stock back to the shelf, or out of the building" |
| INV-F-16 physical count | `StockCountService` | INV-T-08, plus blind entry, discovered batches and the opening case |
| INV-F-17 movement history | `StockService.movements` | INV-T-01's balance sequence. CSV export is `INV-OPEN-16` |
| INV-F-18 on-hand view | `StockService.onHandView` | "shows the on-hand view with its batches and nearest expiry" |
| INV-F-19 … F-20 alerts | `StockAlertService`, `stock_alert_state` | INV-T-11: once on the way down, not on every movement |
| INV-F-21 reconciliation | `StockReconciliationJob` | INV-T-05 |
| INV-F-22 days of cover, reorder | `reorderSuggestions` | "works out days of cover from what actually left" |
| INV-F-23 cold-chain flag | Shown on receiving and on the perform form | — |
| INV-R-01 the invariant | `move()` writes both under one lock | INV-T-05 catches a violation planted directly |
| INV-R-02 one write path | Module boundary | Not yet a grant. `INV-OPEN-03` |
| INV-R-03 row lock | `SELECT … FOR UPDATE` | INV-T-03: six simultaneous, exactly one wins |
| INV-R-04 never negative | `CHECK` + service | INV-T-02 |
| INV-R-05 `balance_after` | `move()` | The balance sequence test |
| INV-R-06 append-only | Trigger | "a movement cannot be edited or deleted, whatever asks" |
| INV-R-07 FEFO excludes expired and blocked | `suggestFefo` | "never offers a blocked batch" |
| INV-R-08 reauth over threshold | `recentlyReauthenticated`, `inventory.adjustReauthThresholdSen` | INV-T-09, both directions |
| INV-R-09 price history | `recordPrice` | Catalogue tests |
| INV-R-11 generic required | Service refusal | RX's own tests |
| INV-R-12 scoping | Schema + RLS | Tenant isolation suite |

## 22. Notes worth keeping

1. **There is one write path, and the module boundary is what enforces
   it.** `StockModule` exports `LedgerService` and deliberately does not
   export `StockService`: other modules move stock, they do not receive
   deliveries. That is a convention a compiler checks. It is not yet a
   convention the *database* checks, which is the difference between
   "nobody does this" and "nobody can", and `INV-OPEN-03` is that gap.

2. **The quantity on a batch is a cache, and it is treated as one.** The
   truth is the sum of the movements. They are written together under
   one lock so they cannot part company through the application, and a
   job recomputes the sum every night because "cannot through the
   application" is not the same as "cannot".

3. **Reconciliation never corrects anything.** A job that silently fixes
   a mismatch destroys the evidence of how the mismatch happened, and the
   how is the only part that stops it happening again. It logs, it
   records a run, and it waits for a human to count the shelf.

4. **The sign of a movement lives in one table, not at the call sites.**
   A caller passes a positive quantity and a type; `DIRECTION` decides
   which way it goes. A caller that has to remember to pass −3 is a
   caller that will one day pass 3, and the failure is silent until a
   stock count. A unit test asserts that every member of the enum has a
   direction, so adding one cannot leave it undefined and turn the
   arithmetic into `NaN`.

5. **Discrete stock rounds nothing; FEFO refuses to half-plan.** Asked
   for fifty when the branch has thirty, `suggestFefo` returns the plan
   *and* the shortfall rather than a plan for thirty. The caller has to
   decide what to do about the twenty, and a list that quietly covers
   less than was asked for hides the decision.

6. **First to expire, not first in.** A delivery that arrives today with
   a short date should leave before one received last month with a long
   one. Getting this backwards does not fail; it just quietly writes off
   medicine that was fine.

7. **A month-stamped expiry means the end of that month.** Blister packs
   say "03/2027". Reading that as the first of March throws away thirty
   days of usable stock every time.

8. **A batch's status is derived, never set.** A trigger recomputes it
   from the quantity and the date on every write, because a status
   somebody has to remember to update is a status that drifts. `BLOCKED`
   is the exception, because a recall is a human decision and nothing
   should be able to un-recall something by selling the last of it.

9. **The catalogue knows nothing about stock, and that survived adding
   stock.** On-hand appears beside a product in a search because
   `StockModule` registers a lookup, not because the catalogue learned
   what a batch is. The same shape as the branch-deactivation and
   consultation-sign registries, for the same reason: the dependency
   points one way and stays there.

10. **An alert fires on the transition, not on the state.** On-hand
    dropping to the reorder level is news; every subsequent dispense
    from an already-low shelf is not. Without that distinction a busy
    morning produces forty identical events and whoever reads them
    stops reading them. The state is therefore remembered: a row
    appears when the condition starts being true, is refreshed quietly
    while it stays true, and disappears when it stops — at which point
    a recurrence is news again. Acknowledging hides it without
    pretending the shelf is full.

11. **Critical supersedes low, and the nearest expiry band wins.** A
    shelf below its minimum is also below its reorder level; a batch
    thirty days out is also ninety days out. Reporting both is
    reporting the same fact twice, which is how a list becomes
    wallpaper.

12. **A count freezes what it expected before anybody starts
    counting.** Otherwise a dispense during the count becomes a
    variance, and the clinic spends an afternoon investigating a
    difference the system caused. Both numbers are kept, and the
    difference is posted as an ordinary ledger movement referencing the
    session — never a silent overwrite — so the nightly reconciliation
    still balances afterwards and an auditor can get from a movement
    back to the sheet.

13. **A blank is not a zero.** A count will not submit with a line
    uncounted, because "we did not get to that shelf" and "there are
    none" produce very different adjustments and look identical in an
    empty box.

14. **Only one count per branch at a time.** Two people counting the
    same shelves against two frozen snapshots produce two different
    truths, and approving both applies the difference twice. A partial
    unique index, because the schema language cannot say it.

15. **The opening import refuses the whole file rather than half of
    it.** A partially imported opening balance cannot be told from a
    complete one afterwards, and that is the worst possible state to
    start a clinic's inventory in.

16. **"No information" and "none in stock" are different answers.** The
    search result carries `stockKnown`, and shows nothing rather than
    zero when the stock module has not registered. A prescriber told
    "0 on hand" who then finds a full box has learnt not to believe the
    number, and that lesson is expensive to unteach.
