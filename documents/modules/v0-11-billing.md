# Billing (BIL)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 4 |
| **Spec sections** | 12 |
| **Depends on** | ENC, CON, DSP, PRC, PAT, TEN, AUD |
| **Depended on by** | PAY, DOC, RPT, EIV, FIN, MEM, PNL |
| **Est. effort** | ~40 h |

> Money rules: `../05-safety-and-compliance.md` §5. Integer sen everywhere.

---

## 1. Purpose & business value

Turn a visit into an invoice that is correct to the sen, every time, and that can be explained line by line to a patient at the counter and to an auditor a year later. Billing sits between the clinical modules (which say what happened) and payment (which collects). It owns the invoice, its lines, its discounts, its numbering, and its immutability once issued.

Small persistent wrongness — a total that disagrees with the receipt, a discount that changes on reprint — is what destroys a clinic's trust in software. This module is designed so that cannot happen.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `invoice.read` | ✓ | ✓ | – | ✓ |
| `invoice.issue` — finalise draft into an issued invoice | ✓ | – | – | ✓ |
| `invoice.discount` (≤ cap) | ✓ | – | – | ✓ |
| Discount above cap | ✓ | – | – | – |
| Add / edit manual lines on a draft | ✓ | – | – | ✓ |
| `invoice.void` | ✓ | – | – | – |
| Reissue after void | ✓ | – | – | ✓ |
| Configure numbering, fees, discount cap (`admin.settings`) | ✓ | – | – | – |

## 3. Functional requirements

### Draft assembly
| ID | Requirement | Priority |
|---|---|---|
| BIL-F-01 | Every encounter has at most one `DRAFT` invoice, created lazily on the first billable event or when the cashier opens billing. | Must |
| BIL-F-02 | Lines are added automatically from events: **consultation fee** on `consultation.signed` (fee from tenant/branch/doctor fee schedule and encounter type), **medicine** lines on `dispense.completed` (qty × snapshot unit price), **procedure** lines on `procedure.performed`, **document** fees (MC, medical report) on `document.issued` where the document type has a fee. | Must |
| BIL-F-03 | Manual lines (FRONTDESK/ADMIN): from a `billable_item` catalogue (e.g. "Medical report fee", "Dressing pack", "Injection fee") or free-text with `invoice.discount`-level permission; each with qty, unit price, reason. | Must |
| BIL-F-04 | Line edit on a draft: qty and price on **manual** lines only; auto lines are read-only (change the source — undo dispense, void procedure); auto lines may be removed only via their source. | Must |
| BIL-F-05 | Fee schedule: consultation fee by (branch, encounter type, doctor override, time band e.g. after-hours), configurable by ADMIN; applied at sign time with the rule recorded on the line. | Must |
| BIL-F-06 | Draft shows live totals; auto-refreshes on events (SSE). | Must |

### Discounts
| ID | Requirement | Priority |
|---|---|---|
| BIL-F-07 | Line discount: amount (sen) or percentage; percentage computed to sen, rounded half-up, **stored as amount**; `discount_source` (`MANUAL`, `MEMBERSHIP` (V1), `PANEL` (V1), `PROMO` (V1), `STAFF`, `SENIOR`, `GOODWILL`) and reason. | Must |
| BIL-F-08 | Invoice-level discount: amount or %, allocated pro-rata across lines to the sen with a deterministic remainder rule (largest-line-first), stored per line, so line totals always sum to the invoice. | Must |
| BIL-F-09 | Discount cap for FRONTDESK: tenant setting `billing.max_discount_pct_frontdesk` (default 10%) and `billing.max_discount_amount_frontdesk`; above cap requires ADMIN (same-screen elevation with ADMIN credentials, audited). | Must |
| BIL-F-10 | Every discount is audited with source, reason, actor and value. | Must |

### Tax
| ID | Requirement | Priority |
|---|---|---|
| BIL-F-11 | Tax engine per line: `tax_code` from the billable item / product / procedure (`NONE`, `SST_6`, `SST_8`, custom rate), computed to sen per line, summed to `tax_total`; most GP services and medicines are not SST-taxable — default `NONE`, confirm with the clinic's accountant (BIL-Q-02). Prices are tax-inclusive or exclusive per tenant setting. | Must |
| BIL-F-12 | Tax registration details (SST number) on the tenant for printing when applicable. | Should |

### Issue & immutability
| ID | Requirement | Priority |
|---|---|---|
| BIL-F-13 | **Issue**: assigns the next invoice number from a **gapless, per-branch series** (`<BRANCHCODE>-INV-<YYYY>-<000000>`), sets `issued_at`, snapshots patient name/ID (masked form for print) and payer, computes and freezes all totals, sets status `ISSUED`. The draft's lines become immutable. | Must |
| BIL-F-14 | After issue, **nothing on the invoice or its lines changes** except: `amount_paid`/`balance`/`status` (driven by PAY), `rounding_adjustment` (set by PAY when cash is used), `voided_*`, e-Invoice fields (V1). | Must |
| BIL-F-15 | **Void** (ADMIN, reason, reauth): status `VOID`; all payments must be voided/refunded first (PAY) or the void is blocked; voided numbers stay in the series (gapless with a void marker). | Must |
| BIL-F-16 | **Reissue**: create a new draft from a voided invoice's lines (pre-populated, editable), issue with a new number; the new invoice references the voided one and vice versa. | Must |
| BIL-F-17 | Encounter completion requires the invoice `PAID` (or `ISSUED` with balance 0), or ADMIN override "complete with outstanding" recording an outstanding balance (PAY). | Must |
| BIL-F-18 | Invoices can exist without an encounter (`STANDALONE`, e.g. selling an OTC item at the counter to a walk-up) — requires `invoice.issue`; patient optional (`WALK_UP` with name only) — tenant setting to allow. | Should |
| BIL-F-19 | Printable invoice (DOC): letterhead, invoice no, date, patient, lines with discounts, subtotal, discount, tax, rounding, total, payments, balance, "PAID" stamp; reprint audited and marked "COPY". | Must |
| BIL-F-20 | Nullable forward-compat columns present from V0: `payer_type`/`payer_id` (V1 PNL), `membership_id` (V1 MEM), e-Invoice fields (V1 EIV), `buyer_tin`. | Must |

## 4. Key workflows

**Standard cashier flow**
1. Encounter reaches `PAYMENT_WAITING` → cashier queue → open → draft shows: Consultation RM 40, Amoxicillin ×15 RM 18, Paracetamol ×10 RM 3, Nebuliser RM 25 → subtotal RM 86.00
2. Patient is a senior → line/invoice discount 10% `SENIOR` → RM 8.60 → total RM 77.40
3. Issue → `KL01-INV-2026-000482` → hand to PAY (same screen)

**Above-cap discount**
1. FRONTDESK enters 25% → blocked "requires ADMIN" → ADMIN enters credentials in the elevation dialog → discount applied, audited as ADMIN-approved

**Correction after issue**
1. Wrong item billed, already issued, unpaid → ADMIN void (reason) → reissue draft prefilled → remove line → issue new number

**Correction after payment**
1. Void payments first (PAY, cash returned) → void invoice → reissue → take payment again. (Credit notes replace this dance in V1.)

## 5. Data model

```
invoice
  id                  uuid pk
  tenant_id           uuid not null
  branch_id           uuid not null
  encounter_id        uuid → encounter          -- null for STANDALONE
  patient_id          uuid → patient            -- null for WALK_UP
  walkup_name         text
  kind                enum(ENCOUNTER, STANDALONE) not null
  invoice_no          text                      -- null while DRAFT
  series_year         int
  series_seq          int
  status              enum(DRAFT, ISSUED, PARTIAL, PAID, VOID) not null
  currency            char(3) not null default 'MYR'
  tax_mode            enum(INCLUSIVE, EXCLUSIVE) not null
  subtotal            bigint not null default 0    -- Σ line (qty × unit_price) before discounts
  discount_total      bigint not null default 0    -- Σ line discount_amount
  tax_total           bigint not null default 0
  rounding_adjustment bigint not null default 0    -- set by PAY for cash; ±1..±2 sen typically
  grand_total         bigint not null default 0    -- subtotal - discount_total + tax_total (excl. rounding)
  amount_paid         bigint not null default 0
  balance             bigint not null default 0    -- grand_total + rounding_adjustment - amount_paid
  invoice_discount_pct numeric(5,2), invoice_discount_reason text, invoice_discount_source text
  payer_type          enum(PATIENT, PANEL, CORPORATE) not null default 'PATIENT'   -- V1 uses PANEL/CORPORATE
  payer_id            uuid
  membership_id       uuid                      -- V1
  patient_name_snapshot text, patient_id_masked_snapshot text
  buyer_tin           text                      -- V1 EIV
  einvoice_status     text, einvoice_uuid text, einvoice_long_id text, einvoice_qr text, einvoice_submitted_at timestamptz   -- V1
  issued_at           timestamptz, issued_by uuid
  paid_at             timestamptz
  voided_at           timestamptz, voided_by uuid, void_reason text
  reissued_from_id    uuid → invoice, reissued_as_id uuid → invoice
  notes               text
  UNIQUE (tenant_id, invoice_no)
  UNIQUE (branch_id, series_year, series_seq)
  UNIQUE (encounter_id) WHERE status = 'DRAFT'
  INDEX (branch_id, status, issued_at)
  INDEX (patient_id, issued_at desc)
  CHECK (grand_total = subtotal - discount_total + tax_total)
  CHECK (balance = grand_total + rounding_adjustment - amount_paid)

invoice_line
  id                  uuid pk
  tenant_id           uuid not null
  invoice_id          uuid not null → invoice
  line_no             int not null
  line_type           enum(CONSULTATION, MEDICINE, PROCEDURE, DOCUMENT, ITEM, MANUAL) not null
  source_type         text, source_id uuid          -- dispense_item / encounter_procedure / consultation / document / billable_item
  description         text not null
  quantity            numeric(12,3) not null
  quantity_unit       text
  unit_price          bigint not null               -- sen
  gross               bigint not null               -- quantity × unit_price, rounded half-up
  discount_pct        numeric(5,2)
  discount_amount     bigint not null default 0     -- includes allocated invoice-level discount
  discount_source     text
  discount_reason     text
  discount_by         uuid
  tax_code            text not null default 'NONE'
  tax_rate_bp         int not null default 0        -- basis points
  tax_amount          bigint not null default 0
  line_total          bigint not null               -- gross - discount_amount + tax_amount (exclusive) or gross - discount (inclusive)
  fee_rule            text                          -- e.g. 'CONSULT:WALK_IN:AFTER_HOURS'
  is_auto             bool not null
  UNIQUE (invoice_id, line_no)
  INDEX (source_type, source_id)
  CHECK (gross = round(quantity * unit_price))
  CHECK (discount_amount >= 0 AND discount_amount <= gross)

invoice_series
  tenant_id, branch_id, year  (pk)
  next_seq int not null
  -- allocated with SELECT ... FOR UPDATE inside the issue transaction

billable_item   (tenant catalogue for manual lines)
  id uuid pk, tenant_id, code text, name text, default_price bigint, tax_code text, category text, status
  UNIQUE (tenant_id, code)

fee_schedule
  id uuid pk, tenant_id, branch_id (nullable = all), encounter_type text (nullable = all),
  doctor_id uuid (nullable = all), time_band enum(ANY, AFTER_HOURS, WEEKEND, PUBLIC_HOLIDAY),
  fee bigint not null, tax_code text, effective_from date, effective_to date, priority int
  -- most specific match wins

invoice_void_log   -- convenience projection of voids for reporting; audit has full detail
```

## 6. State machines

```
DRAFT ──issue──► ISSUED ──payment──► PARTIAL ──payment──► PAID
                   │                    │                    │
                   └──void (no payments)┴──void (after payment voids)───► VOID
DRAFT ──discard──► (deleted; drafts are the only deletable invoice rows)
```

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| BIL-R-01 | All amounts are `bigint` sen; no numeric/float arithmetic in application money code. | `Money` utility type; lint bans `number` arithmetic on fields named `*_sen`/`amount`/`total` |
| BIL-R-02 | `gross = round_half_up(quantity × unit_price)` per line; totals are sums of stored line values, never recomputed from percentages. | CHECK constraints + service |
| BIL-R-03 | Invoice-level % discount is allocated to lines to the sen; allocation is deterministic and documented (largest-remainder, ties by `line_no`); `Σ line.discount_amount = discount_total`. | Service + test |
| BIL-R-04 | `grand_total = subtotal − discount_total + tax_total`; `balance = grand_total + rounding_adjustment − amount_paid`. | CHECK constraints |
| BIL-R-05 | Once `ISSUED`, invoice and lines are immutable except the PAY-driven columns. | Service + **DB trigger** on `invoice` (allowed-columns list) and `invoice_line` (no update/delete when parent not DRAFT) |
| BIL-R-06 | Invoice numbers are gapless per branch per year and allocated under `FOR UPDATE` inside the issue transaction; a failed issue rolls back the allocation. | `invoice_series` |
| BIL-R-07 | Void requires zero non-voided payments. | Service |
| BIL-R-08 | Auto lines are created/removed only by their source events; the API rejects manual edits to `is_auto` lines. | Service |
| BIL-R-09 | Discounts above the FRONTDESK cap require an ADMIN elevation recorded on the line (`discount_by` = the ADMIN). | Service |
| BIL-R-10 | Rounding adjustment is only ever set by PAY for cash settlement and only within ±4 sen. | Service + CHECK |
| BIL-R-11 | Unit price on MEDICINE lines comes from the `dispense_item` snapshot, never from the live product price. | BIL consumer of `dispense.completed` |
| BIL-R-12 | `line_no` is contiguous from 1 on issue (draft may have gaps from removed lines; renumbered at issue). | Service |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/encounters/:id/invoice` | `invoice.read` | Draft or issued |
| POST | `/encounters/:id/invoice` | `invoice.issue` | Ensure draft exists |
| GET | `/invoices/:id` | `invoice.read` | |
| POST | `/invoices/:id/lines` | `invoice.issue` | Manual line |
| PATCH | `/invoices/:id/lines/:lid` | `invoice.issue` | Manual lines only; DRAFT only |
| DELETE | `/invoices/:id/lines/:lid` | `invoice.issue` | Manual lines only |
| PUT | `/invoices/:id/lines/:lid/discount` | `invoice.discount` (+ elevation) | `{ pct? | amount?, source, reason }` |
| PUT | `/invoices/:id/discount` | `invoice.discount` (+ elevation) | Invoice-level |
| DELETE | `/invoices/:id/discount` | `invoice.discount` | |
| POST | `/invoices/:id/issue` | `invoice.issue` | Idempotency key; returns number |
| POST | `/invoices/:id/void` | `invoice.void` + reauth | Reason |
| POST | `/invoices/:id/reissue` | `invoice.issue` | Creates draft |
| POST | `/branches/:b/invoices/standalone` | `invoice.issue` | Walk-up sale |
| GET | `/branches/:b/invoices?status=&from=&to=&patientId=` | `invoice.read` | |
| GET | `/invoices/:id/print` | `document.issue` | PDF via DOC |
| POST | `/elevate` | ADMIN credentials | Returns short-lived elevation token for the elevation dialog |
| CRUD | `/billable-items` | `admin.settings` | |
| CRUD | `/fee-schedule` | `admin.settings` | |

## 9. Domain events

**Emits:** `invoice.draft_created`, `invoice.line_added`, `invoice.line_removed`, `invoice.discounted`, `invoice.issued` `{ invoiceId, invoiceNo, grandTotal, encounterId }`, `invoice.voided`, `invoice.reissued`, `invoice.status_changed` (PARTIAL/PAID, driven by PAY)
**Consumes:** `consultation.signed` (fee line), `dispense.completed`/`dispense.partial` (medicine lines), `dispense.undone` (remove line), `procedure.performed` (line), `procedure.voided` (remove line), `document.issued` (fee line if applicable), `payment.received`/`payment.voided` (update paid/balance/status), `encounter.cancelled` (discard draft)

## 10. Audit events

`invoice.issued` (full snapshot), `invoice.voided` (reason), `invoice.discounted` (line/invoice, source, reason, actor, elevation), `invoice.manual_line_added/edited/removed`, `invoice.reprinted`, fee-schedule and billable-item changes.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Cashier queue | Encounters at `PAYMENT_WAITING`; opens billing screen |
| Billing screen | Patient header; line table (type icon, description, qty, price, discount, total); auto lines locked with source link; "+ item" for manual; discount controls per line and invoice; totals panel (subtotal, discount, tax, total) big and right-aligned; "Issue & take payment" primary; keyboard: `D` discount, `I` add item, `Enter` issue |
| Elevation dialog | ADMIN email + password (+ MFA) inline; result shown as "approved by <name>" on the line |
| Invoice view | Read-only; payments list; balance; print; void/reissue for ADMIN |
| Admin → Fees | Fee schedule table with specificity ordering; billable items; discount cap |

## 12. Validation

- Manual line: description 2–200; qty > 0; unit price ≥ 0; ≤ 20 manual lines
- Discount pct 0–100 (2 dp); amount 0–gross
- Reason required for any discount ≥ tenant `billing.discount_reason_threshold_pct` (default 5%)
- Void reason ≥ 10 chars
- Issue requires ≥ 1 line and grand_total ≥ 0

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| BIL-N-01 | Issue transaction ≤ 150 ms including series allocation. |
| BIL-N-02 | 50 concurrent issues at one branch produce 50 consecutive numbers with no gap or duplicate. |
| BIL-N-03 | Money arithmetic unit-tested with property-based tests (allocation sums, rounding). |
| BIL-N-04 | Draft refresh on event ≤ 1 s on the cashier screen. |
| BIL-N-05 | Immutability trigger tested by direct SQL in CI. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| 10% of RM 0.05 | Discount rounds to RM 0.01 (half-up of 0.5 sen); documented. |
| Invoice discount 33.33% across 3 lines of RM 10 | Allocation: each RM 3.33, remainder 1 sen → largest line (tie → line 1) gets RM 3.34; Σ = RM 10.00 ✓. |
| Dispense undone after invoice issued | Undo blocked (DSP-R); ADMIN must void/reissue. |
| Patient disputes a line after payment | Void payment(s) → void invoice → reissue → repay; V1 credit note simplifies. |
| Year rollover at midnight with an open draft | Series keyed on issue date's year; the draft issues into the new year's series. |
| Series counter row missing for a new branch/year | Created lazily under lock on first issue. |
| Consultation fee for a follow-up within 7 days | Fee schedule rule `FOLLOW_UP` (encounter type) with a lower/zero fee; the doctor sets encounter type or the cashier changes it before issue (audited). |
| Tax-inclusive pricing | Line total = gross − discount; tax_amount derived backwards for reporting; never changes the customer-facing total. |
| Standalone sale to non-patient | `WALK_UP` with name; no encounter; still numbered and paid via PAY. |
| Discount on a MEDICINE line for a controlled drug | Allowed; no special rule. |

## 15. Compliance

- Gapless numbering and immutability satisfy Malaysian record-keeping expectations and are prerequisites for e-Invoice (EIV).
- Discount and void audit trail is the financial control the owner and accountant will ask for.
- SST treatment to be confirmed with the clinic's accountant; the engine supports it either way.
- Printed invoices show the masked ID unless the document type requires full ID.

## 16. Reporting outputs

- Sales by day / line type / doctor / branch (RPT; FIN)
- Discount totals by source and actor; voids with reasons
- Average invoice value; lines per invoice
- Outstanding balances (with PAY)
- Tax collected (if applicable)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| BIL-T-01 | Given `dispense.completed` with 15 × RM 1.20, then a MEDICINE line exists with gross 1800 sen and the draft subtotal reflects it. |
| BIL-T-02 | Given lines RM 10/RM 10/RM 10 and a 33.33% invoice discount, then line discounts are 334/333/333 sen and `discount_total = 1000`. |
| BIL-T-03 | Given FRONTDESK applies 15% with cap 10%, then 403 elevation-required; with a valid ADMIN elevation, then applied and `discount_by` = ADMIN. |
| BIL-T-04 | Given 50 concurrent issues at branch KL01 in 2026, then numbers 000001–000050 exactly. |
| BIL-T-05 | Given an ISSUED invoice, when a line is PATCHed or a direct SQL update of `description` runs, then 409 / trigger error respectively. |
| BIL-T-06 | Given an ISSUED invoice with one non-voided payment, when voided, then 409; after the payment is voided, then VOID succeeds and the number remains in the series. |
| BIL-T-07 | Given a VOID invoice, when reissued, then a new DRAFT with the same lines exists, and on issue it gets the next number and both invoices cross-reference. |
| BIL-T-08 | Given a fee schedule with a doctor-specific after-hours fee, when that doctor signs at 21:30, then the CONSULTATION line uses that fee and records the rule. |
| BIL-T-09 | Given tax mode INCLUSIVE and a line with `SST_8`, then `line_total` equals gross − discount and `tax_amount` is the derived component. |
| BIL-T-10 | Property test: for random lines and discounts, `Σ line_total = grand_total` and every amount is an integer. |

## 18. Migration & rollout

- R4: cashier issues invoices in the system; their existing POS/cash book runs in parallel for 3 days; totals reconciled each evening
- Fee schedule, billable items, discount cap and tax mode configured with the owner before R4
- Historical invoices not migrated; outstanding balances from the old system entered as opening receivables in V1 FIN (or tracked manually until then)
- Invoice numbering: agree whether to continue their existing series (BIL-Q-03)

## 19. Out of scope

- Credit notes, refunds as documents → V1 `FIN`/`PAY`
- Panel/corporate payer, split billing, claims → V1 `PNL`
- Membership discounts and entitlements → V1 `MEM`
- Promo codes, vouchers → V2 `LOY`
- Packages / prepaid sessions → V2 `PKG`
- e-Invoice submission → V1 `EIV`
- Quotations / estimates → V2

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| BIL-Q-01 | Consultation fee structure: flat, by doctor, by time, follow-up rate? | Pilot clinic owner |
| BIL-Q-02 | SST applicability to any of their services/items — confirm with accountant. | Pilot clinic owner |
| BIL-Q-03 | Continue existing invoice numbering series or start fresh? | Pilot clinic owner |
| BIL-Q-04 | Typical discounts given and by whom; acceptable cap for front desk. | Pilot clinic owner |
| BIL-Q-05 | Do they sell OTC items to walk-ups without registration? | Pilot clinic |
| BIL-Q-06 | Price display: tax-inclusive? | Pilot clinic owner |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] BIL-T-01 … T-10 green (T-04/T-05 against real Postgres)
- [ ] Money utility with property tests merged; lint rule active
- [ ] Immutability trigger in place and tested by direct SQL
- [ ] Fee schedule and discount cap configured for the pilot
- [ ] 3 days of parallel running reconciled to the sen against the old POS
- [ ] Open questions answered
