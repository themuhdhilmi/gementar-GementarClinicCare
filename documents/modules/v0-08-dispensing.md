# Pharmacy / Dispensing (DSP)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 3 |
| **Spec sections** | 8 |
| **Depends on** | RX, INV, ENC, PAT, AUD |
| **Depended on by** | BIL, ENC, RPT |
| **Est. effort** | ~35 h |

---

## 1. Purpose & business value

What actually leaves the shelf. Dispensing is where a prescription meets physical stock: a batch is chosen (earliest expiry first), the label is printed, the quantity leaves the ledger, and the bill gets its medicine lines. Everything that makes inventory trustworthy or untrustworthy happens in this module's transaction.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `dispense.perform` — prepare, dispense, partial, print label | ✓ | ✓ | ✓ | ✓ |
| `dispense.substitute` | ✓ | ✓ | – | ✓ |
| `dispense.cancel` (undo before handover) / return | ✓ | ✓ | – | – |
| Override FEFO batch suggestion | ✓ | ✓ | ✓ | ✓ (reason) |
| Controlled-drug register entry | ✓ | ✓ | ✓ | ✓ (with witness field) |
| View pharmacy queue | ✓ | ✓ | ✓ | ✓ |

If the pilot has a dedicated dispenser, split a `DISPENSER` role from FRONTDESK (IAM-Q-01).

## 3. Functional requirements

### Queue & preparation
| ID | Requirement | Priority |
|---|---|---|
| DSP-F-01 | Pharmacy queue lists encounters at `PHARMACY_WAITING`/`DISPENSING` with queue no, patient, item count, controlled flag, "updated" badge if RX amended since first viewed, elapsed time. | Must |
| DSP-F-02 | Opening an encounter starts a **dispense session** (`DISPENSING`); the dispense view shows each current RX item with: product, prescribed qty, label text, allergy status (from PAT, not RX notes), suggested batch (FEFO), on-hand per batch, expiry. | Must |
| DSP-F-03 | FEFO suggestion: for each item, the batch at this branch with the **earliest expiry that has enough quantity**; if no single batch suffices, split across batches earliest-first. Expired batches are never suggested and cannot be selected. | Must |
| DSP-F-04 | Batch override: dispenser may pick another non-expired batch; a reason is required if the chosen batch expires later than a suggested one with sufficient stock ("physical stock mismatch", "damaged", "other"). | Must |
| DSP-F-05 | Quantity adjust per item: **partial dispense** (less than prescribed, reason: insufficient stock / patient request / cost) leaves the item `PARTIAL` with remaining qty visible for a later top-up; **over-dispense** is not allowed beyond prescribed qty (pack rounding exception, DSP-F-06). | Must |
| DSP-F-06 | Pack rounding: if the product's `dispense_unit` is a pack (bottle, tube, inhaler), quantity rounds to whole packs; the rounding is shown and billed as the pack. | Must |
| DSP-F-07 | **Substitute**: replace the product with another (same generic + strength suggested first; different generic requires `dispense.substitute` and a reason, and flags the doctor); original item kept as `SUBSTITUTED`, new dispense item references it. | Must |
| DSP-F-08 | **External / not dispensed**: mark item as `EXTERNAL` (patient to obtain elsewhere) or `DECLINED` (patient refused) with reason; no stock movement; not billed. | Must |
| DSP-F-09 | Items amended by the doctor after the session opened are highlighted; a dispensed-against-superseded-version item requires explicit acknowledgement or return. | Must |

### Dispense & handover
| ID | Requirement | Priority |
|---|---|---|
| DSP-F-10 | **Dispense** action (per item or all): in one transaction — lock selected batch rows, verify quantity, write `stock_movement` (−qty, `DISPENSE`, ref = dispense item), decrement `quantity_on_hand`, create `dispense_item`, update RX item status, emit `dispense.completed`/`partial`. | Must |
| DSP-F-11 | Idempotency key on dispense; a retried request returns the original result. | Must |
| DSP-F-12 | Label printing per dispense item: patient name, date, product + strength, `label_text` (dose/frequency/instructions in patient language), qty, expiry, batch, clinic name/phone, "Keep out of reach of children" and product-specific warnings; reprint allowed and counted. | Must |
| DSP-F-13 | Counselling checklist (optional, tenant setting): tick "counselled" per item or per session; recorded with dispenser. | Should |
| DSP-F-14 | Session completion: all items in a terminal state → prescription `COMPLETED` (or remains `ACTIVE` with `PARTIAL` items) → encounter routes on (ENC). | Must |
| DSP-F-15 | Medicine lines are pushed to the encounter's draft invoice (BIL) at dispense time using batch selling price (or product price per tenant setting), with qty actually dispensed. | Must |
| DSP-F-16 | **Undo** (before handover, same session, ≤ 15 min): reverses the stock movement with a `DISPENSE_REVERSAL` entry, removes invoice lines, returns item to `ACTIVE`; audited. | Must |
| DSP-F-17 | **Return** (after handover): patient returns medication; creates `RETURN` movement to a **quarantine** location (not back to saleable stock) with reason; credit handled via BIL void/credit (V1 credit note; V0 = void + reissue). | Should |

### Controlled drugs
| ID | Requirement | Priority |
|---|---|---|
| DSP-F-18 | Dispensing an `is_controlled` item requires a **register entry**: patient name + IC (unmasked, audited), prescriber, product, batch, qty, running balance, dispenser, optional witness; entries append-only; register printable per product per period. | Must (if the pilot dispenses controlled items — DSP-Q-01) |
| DSP-F-19 | Running balance per controlled product per branch reconciled against the ledger; mismatch alerts. | Must (as above) |

## 4. Key workflows

**Standard**
1. Dispenser: Pharmacy queue → open A-017 → session opens, 3 items, all FEFO-suggested, all in stock
2. Review labels (already generated) → "Dispense all" → 3 labels print → stock moves → invoice lines created
3. "Complete" → encounter to `PAYMENT_WAITING` → next

**Partial stock**
1. Item 2 prescribed 30 tabs, on hand 12 across 2 batches → suggestion splits 10 + 2 → dispenser accepts → item `PARTIAL` (18 remaining) or reduces to 12 with reason "insufficient stock"
2. Patient told to return; remaining dispensed later from the same prescription (new session, same encounter, ADMIN reopens or a standalone "top-up dispense" flow within 7 days)

**Substitute**
1. Prescribed brand X 500 mg out of stock → "Substitute" → suggests generic Y 500 mg (same generic) → confirm → new item, original `SUBSTITUTED`, doctor notified on next open of the record

**Undo**
1. Wrong batch scanned → "Undo" on the item within 15 min → reversal movement, label marked void, re-dispense correctly

**Controlled**
1. Item flagged → register modal → IC unmasked (audited) → witness (optional) → dispense → register row with running balance

## 5. Data model

```
dispense
  id                uuid pk
  tenant_id         uuid not null
  branch_id         uuid not null
  encounter_id      uuid not null → encounter
  prescription_id   uuid not null → prescription
  patient_id        uuid not null
  status            enum(OPEN, COMPLETED, CANCELLED) not null
  opened_by         uuid not null, opened_at timestamptz not null
  completed_by      uuid, completed_at timestamptz
  counselled        bool, counselled_by uuid
  notes             text
  rx_version_seen   jsonb                        -- {itemId: version} at open
  INDEX (branch_id, status)
  INDEX (prescription_id)

dispense_item
  id                    uuid pk
  tenant_id             uuid not null
  dispense_id           uuid not null → dispense
  prescription_item_id  uuid not null → prescription_item
  prescription_item_version int not null
  product_id            uuid not null → product      -- actual product (may differ if substituted)
  is_substitute         bool not null default false
  substitute_reason     text
  original_product_id   uuid → product
  quantity              numeric(10,3) not null       -- total dispensed this item
  quantity_unit         text not null
  pack_rounded          bool not null default false
  unit_price            bigint not null              -- sen, snapshot
  line_total            bigint not null              -- sen
  outcome               enum(DISPENSED, PARTIAL, EXTERNAL, DECLINED, SUBSTITUTED_OUT) not null
  outcome_reason        text
  label_text            text not null                -- snapshot
  label_prints          int not null default 0
  counselled            bool
  dispensed_by          uuid not null, dispensed_at timestamptz not null
  reversed_at           timestamptz, reversed_by uuid, reversal_reason text
  idempotency_key       text
  UNIQUE (tenant_id, idempotency_key)
  INDEX (dispense_id)
  INDEX (prescription_item_id)

dispense_item_batch      -- one dispense item may draw from several batches
  id uuid pk, tenant_id
  dispense_item_id      uuid not null → dispense_item
  batch_id              uuid not null → product_batch
  quantity              numeric(10,3) not null
  was_suggested         bool not null
  override_reason       text
  stock_movement_id     uuid not null → stock_movement
  INDEX (batch_id)

controlled_drug_register   (append-only)
  id uuid pk, tenant_id, branch_id
  product_id            uuid not null
  entry_type            enum(RECEIVE, DISPENSE, ADJUST, RETURN, DESTROY) not null
  reference_type text, reference_id uuid
  patient_id            uuid, patient_name text, patient_ic text     -- snapshot, required for DISPENSE
  prescriber_id         uuid, prescriber_name text
  batch_id              uuid, batch_no text
  quantity_in           numeric(10,3) not null default 0
  quantity_out          numeric(10,3) not null default 0
  balance_after         numeric(10,3) not null
  performed_by          uuid not null, performed_by_name text
  witness_id            uuid, witness_name text
  occurred_at           timestamptz not null
  INDEX (branch_id, product_id, occurred_at)
```

## 6. State machines

**Dispense session**: `OPEN` → `COMPLETED` | `CANCELLED` (nothing dispensed; returns encounter to `PHARMACY_WAITING`).
**Dispense item**: created directly in a terminal `outcome`; `reversed_at` marks an undo (row retained).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| DSP-R-01 | Stock moves **only** in `DispenseService.dispense()` and `undo()`, each a single transaction with `SELECT … FOR UPDATE` on every affected `product_batch`. | Service; INV ledger API requires a lock token |
| DSP-R-02 | A batch with `expiry_date < today` cannot be selected. | Service + INV check |
| DSP-R-03 | `Σ dispense_item_batch.quantity = dispense_item.quantity`. | DB constraint via trigger |
| DSP-R-04 | Dispensed quantity ≤ prescribed quantity (current version) except pack rounding, which is flagged. | Service |
| DSP-R-05 | Undo is only possible while the session is `OPEN` and within 15 min; after that, use return. | Service |
| DSP-R-06 | Invoice lines are created from `dispense_item` (actual), never from `prescription_item` (intent). | BIL consumes `dispense.completed` |
| DSP-R-07 | Every batch override records `override_reason`; FEFO compliance rate is reported. | Service |
| DSP-R-08 | Controlled items cannot be dispensed without a register row in the same transaction. | Service + trigger on `dispense_item` where product.is_controlled |
| DSP-R-09 | `unit_price` snapshot at dispense time; later price changes do not affect the invoice. | Service |
| DSP-R-10 | The dispenser view never shows consultation notes or diagnoses. | RX dispense-view DTO |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/branches/:b/pharmacy/queue` | `dispense.perform` | |
| POST | `/encounters/:id/dispense` | `dispense.perform` | Open session; returns items with FEFO suggestions |
| GET | `/dispenses/:id` | `dispense.perform` | |
| POST | `/dispenses/:id/items/:rxItemId/dispense` | `dispense.perform` | `{ batches:[{batchId, qty, overrideReason?}], quantity, outcome, reason?, idempotencyKey, register? }` |
| POST | `/dispenses/:id/dispense-all` | `dispense.perform` | Accept all suggestions; idempotency key |
| POST | `/dispenses/:id/items/:rxItemId/substitute` | `dispense.substitute` | `{ productId, reason }` |
| POST | `/dispenses/:id/items/:rxItemId/external` | `dispense.perform` | |
| POST | `/dispenses/:id/items/:rxItemId/decline` | `dispense.perform` | |
| POST | `/dispense-items/:id/undo` | `dispense.cancel` | ≤ 15 min |
| POST | `/dispense-items/:id/label` | `dispense.perform` | Print/reprint; returns print payload |
| POST | `/dispenses/:id/complete` | `dispense.perform` | |
| POST | `/dispenses/:id/cancel` | `dispense.perform` | Nothing dispensed |
| POST | `/dispense-items/:id/return` | `dispense.cancel` | To quarantine |
| GET | `/branches/:b/controlled-register?productId=&from=&to=` | `stock.read` + audited | Printable |
| GET | `/products/:id/batches?branchId=` | `dispense.perform` | On-hand per batch |

## 9. Domain events

**Emits:** `dispense.opened`, `dispense.completed` `{ items:[{rxItemId, productId, qty, unitPrice, lineTotal}] }`, `dispense.partial`, `dispense.item_substituted`, `dispense.item_external`, `dispense.item_declined`, `dispense.undone`, `dispense.returned`, `dispense.session_completed`, `controlled.dispensed`
**Consumes:** `prescription.activated` (queue), `prescription.item_amended` (badge), `prescription.item_cancelled`, `encounter.cancelled`

## 10. Audit events

All §9; batch overrides with reason; `patient.id_unmasked` for controlled register; label reprints beyond the first.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Pharmacy queue | Rows: queue no, patient, items, flags (controlled ⚠, amended ↻, allergy ●), waiting time; `Space` opens head |
| Dispense session | Patient header with allergies; items as cards: product, prescribed qty, suggested batch(es) with expiry + on-hand, qty input, outcome buttons; big "Dispense all" when every item is clean; per-item "Dispense"; label preview; barcode scan field (batch barcode → selects batch) |
| Substitute picker | Same-generic first, then class, with stock |
| Register modal | Unmask IC button (audited), witness select, quantity, balance preview |
| Label | 50×30 mm or 70×40 mm thermal (DSP-Q-02); template per branch |

## 12. Validation

- Quantity > 0, ≤ prescribed (pack-rounding exception flagged)
- Batch belongs to product and branch; not expired; on-hand ≥ qty (checked under lock)
- Substitute product must be `type = MEDICINE`, active
- Reasons required where specified; ≥ 3 chars
- Register: patient IC required for DISPENSE; witness required if tenant setting `controlled.witness_required`

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| DSP-N-01 | Dispense transaction ≤ 300 ms for a 5-item prescription including lock acquisition. |
| DSP-N-02 | Concurrent dispenses on the same batch serialise correctly with no negative stock (tested with 20 parallel requests). |
| DSP-N-03 | Label print job dispatched ≤ 1 s after dispense; printer failure does not roll back the dispense (label reprint path). |
| DSP-N-04 | FEFO suggestion computed in one query per session, not per item. |
| DSP-N-05 | Register query for a product over a year ≤ 200 ms. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Two dispensers, same batch, last 10 tabs | Row lock: first succeeds; second sees updated on-hand and must re-select. |
| Physical stock lower than system | Dispense what exists with override reason "physical mismatch"; INV alerts for an adjustment; do not let the dispenser adjust stock from here. |
| Printer offline | Dispense proceeds; label queued; "reprint" available; encounter cannot be completed until labels printed (tenant setting `dispense.require_label`, default on). |
| Doctor amends RX mid-session | Item highlighted; if already dispensed → prompt undo/return; else re-suggest. |
| Patient leaves without collecting | Session `CANCELLED` if nothing dispensed; else `COMPLETED` with undispensed items `DECLINED` reason "left". |
| Batch barcode not in system | Manual batch select; INV flag to add barcode. |
| Same product prescribed twice (intentional) | Two items, two dispense items; FEFO computed sequentially so on-hand is not double-counted. |
| Expired batch is the only stock | Cannot dispense; item `EXTERNAL`/`PARTIAL`; INV expiry alert should have fired. |
| Return of a partially used pack | Quarantine movement of the returned qty; no credit automatically. |
| Undo after invoice already paid | Undo blocked; use return + BIL void/reissue. |

## 15. Compliance

- Controlled-drug register (DSP-F-18/19) supports Poisons Act / Dangerous Drugs Act inspection — **format to be confirmed** (DSP-Q-01).
- Labels carry the information a patient needs to take medicine safely; language per patient.
- Dispenser DTO minimises clinical exposure (DSP-R-10).
- IC unmask for the register is audited.

## 16. Reporting outputs

- Dispensed quantities by product/day; medicine revenue lines (RPT/FIN)
- FEFO compliance rate; override reasons
- Partial and external rates (stock planning input; PUR in V1)
- Substitution rate by product
- Controlled-drug register per product/period (printable)
- Dispense time per session (queue performance)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| DSP-T-01 | Given batches B1 (exp 2027-01, qty 10) and B2 (exp 2026-11, qty 30), when 15 tabs are needed, then the suggestion is B2×15. |
| DSP-T-02 | Given B1 (exp 2026-11, qty 10) and B2 (exp 2027-01, qty 30), when 15 are needed, then the suggestion is B1×10 + B2×5. |
| DSP-T-03 | Given an expired batch, when selected, then 422. |
| DSP-T-04 | Given a dispense of 15 from B2, then `stock_movement` has −15 with ref = dispense item, `quantity_on_hand` decreased by 15, and both happened in one transaction (verified by forcing a failure after the movement insert → nothing persists). |
| DSP-T-05 | Given 20 parallel dispenses of 1 from a batch with 10, then exactly 10 succeed and on-hand is 0, never negative. |
| DSP-T-06 | Given the same idempotency key sent twice, then one dispense item exists and both responses are identical. |
| DSP-T-07 | Given a dispense, then BIL receives `dispense.completed` and the draft invoice has a line with the snapshot unit price. |
| DSP-T-08 | Given an undo within 15 min, then a `DISPENSE_REVERSAL` movement exists, on-hand is restored, and the invoice line is removed. |
| DSP-T-09 | Given a controlled item, when dispensed without a register payload, then 422; with it, then a register row exists with correct running balance. |
| DSP-T-10 | Given a non-suggested batch chosen while a suggested one had stock, when no reason is given, then 422. |
| DSP-T-11 | Given a substitute with a different generic by FRONTDESK, then 403; by DOCTOR with reason, then original `SUBSTITUTED_OUT` and new item created. |
| DSP-T-12 | Given the dispenser DTO, then it contains no `hpi`, `examination` or diagnosis fields. |

## 18. Migration & rollout

- R3 with INV; requires opening stock count complete and batches loaded
- Label printer model confirmed in Phase 0 spike; template tested with real labels before R3
- First week: daily physical spot-count of the 10 fastest-moving products against the system
- Controlled-drug register: if applicable, parallel-run the paper register for 2 weeks

## 19. Out of scope

- Delivery / pickup for telemedicine → V3 `TEL`
- Automated dispensing cabinets, robotics → not planned
- Compounding records → not planned
- Pharmacist clinical interventions log → V2

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| DSP-Q-01 | Do they dispense controlled substances? What register format does their inspector expect? | Pilot clinic |
| DSP-Q-02 | Label printer model and label size in use. | Pilot clinic |
| DSP-Q-03 | Do they use batch barcodes / scanners? | Pilot clinic |
| DSP-Q-04 | Who dispenses — pharmacist, dispenser, doctor? (Affects roles.) | Pilot clinic |
| DSP-Q-05 | Is counselling documented today? | Pilot clinic |
| DSP-Q-06 | Selling price from batch (cost-based) or from product (list)? | Pilot clinic owner |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] DSP-T-01 … T-12 green (T-04/T-05 against real Postgres)
- [ ] Label printed on the clinic's actual printer with real label stock; template approved
- [ ] One week of live dispensing with stock matching physical count for top-10 products
- [ ] Controlled register reviewed against inspector expectations (if applicable)
- [ ] Open questions answered
