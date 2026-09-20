# Payment (PAY)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 4 |
| **Spec sections** | 13 |
| **Depends on** | BIL, ENC, IAM, AUD |
| **Depended on by** | RPT, FIN, DOC, LOY, WLT |
| **Est. effort** | ~25 h |

---

## 1. Purpose & business value

Take the money, record exactly how it was taken, and prove at the end of the day that the drawer balances. The receipt is the document patients keep; the end-of-day close is the moment the owner decides whether to trust the system. Both must be right to the sen — including Malaysia's 5-sen cash rounding, which is a property of the *payment method*, not the invoice.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `payment.take` — record a payment, print receipt | ✓ | – | – | ✓ |
| `payment.void` — void a payment (same day) | ✓ | – | – | – |
| Record refund (V0: as part of void/reissue) | ✓ | – | – | – |
| `eod.close` — open/close cash session, count drawer | ✓ | – | – | ✓ |
| Approve a cash session with variance above threshold | ✓ | – | – | – |
| Configure payment methods, rounding, thresholds | ✓ | – | – | – |

## 3. Functional requirements

### Cash sessions (drawer)
| ID | Requirement | Priority |
|---|---|---|
| PAY-F-01 | A **cash session** per branch per drawer per day: opened with a float amount by the cashier; all cash payments attach to the open session; closed with a counted amount; variance computed. Payments cannot be taken without an open session (non-cash methods too, for attribution). | Must |
| PAY-F-02 | Multiple sessions per day allowed (shift change): close one, open another; a session can be `SUSPENDED` (break) and resumed. | Should |
| PAY-F-03 | Session close shows expected cash (float + cash in − cash out/refunds), counted cash (denomination breakdown optional), variance; a variance beyond `payment.variance_approval_sen` (default RM 10) requires ADMIN approval with note. Variance is recorded, never silently corrected. | Must |
| PAY-F-04 | Cash drops (mid-day removal to safe) and petty-cash outs recorded as session movements with reason. | Should |
| PAY-F-05 | End-of-day summary per session: by method totals, invoice count, voids, refunds, variance; printable Z-report; `eod.closed` event. | Must |

### Taking payment
| ID | Requirement | Priority |
|---|---|---|
| PAY-F-06 | Methods in V0: `CASH`, `CARD` (manual terminal — record last 4 + approval code optional), `DUITNOW_QR` (static/dynamic QR displayed; record reference), `BANK_TRANSFER` (reference), `EWALLET` (TnG etc., reference), `CHEQUE` (rare; number). Methods enabled per branch. | Must |
| PAY-F-07 | **Split payment**: several payments against one invoice, any mix of methods, until balance 0. | Must |
| PAY-F-08 | **Partial payment**: allowed when tenant setting permits; invoice `PARTIAL` with balance; encounter may complete only with ADMIN override (ENC-F-10) recording the outstanding amount; outstanding list on dashboard. | Must |
| PAY-F-09 | **Cash rounding (Malaysia)**: when the *cash portion* settles the invoice, the amount due in cash is rounded to the nearest 5 sen per the BNM mechanism (1,2 → 0; 3,4 → 5; 6,7 → 5; 8,9 → 10); the rounding difference is written to `invoice.rounding_adjustment` and shown as a receipt line. Non-cash methods pay exact. Split: rounding applies only to the final cash leg that settles the remaining balance. | Must |
| PAY-F-10 | Cash tendered and change computed and recorded. | Must |
| PAY-F-11 | Idempotency key on every payment; retried request returns the original payment. | Must |
| PAY-F-12 | Overpayment blocked (exceeds balance after rounding). | Must |
| PAY-F-13 | On payment: update invoice `amount_paid`, `balance`, status (`PARTIAL`/`PAID`), `paid_at`; emit `payment.received`; ENC advances when balance 0. | Must |

### Receipts
| ID | Requirement | Priority |
|---|---|---|
| PAY-F-14 | Receipt per payment (and a consolidated receipt when an invoice is fully paid in one go): receipt number series per branch (`<BRANCH>-RCP-<YYYY>-<seq>`, gapless), invoice ref, lines summary (or full invoice on the same document per tenant setting), method, tendered/change, rounding, balance, cashier, time; printable on thermal 80/58 mm and A4. | Must |
| PAY-F-15 | Reprint audited and marked "COPY". | Must |
| PAY-F-16 | E-receipt: PDF stored (DOC), sendable via NTF in V1. | Should |

### Void & refund
| ID | Requirement | Priority |
|---|---|---|
| PAY-F-17 | Void a payment (ADMIN, reason, reauth) **same day only** and only while its cash session is open (or with ADMIN reopening the session); reverses invoice paid amounts; cash void records cash returned in the session. Cross-day corrections use refund. | Must |
| PAY-F-18 | Refund (ADMIN, reason): a negative payment record against a VOID or reissued invoice, method (cash from drawer / transfer), linked to the original payment; V1 FIN adds credit notes and proper refund documents. | Must |

## 4. Key workflows

**Cash, exact rounding**
1. Invoice RM 77.40 (7740 sen) → cash → due in cash RM 77.40 (0 rounding) → tendered RM 100 → change RM 22.60 → receipt

**Cash with rounding**
1. Invoice RM 77.43 → cash → rounded RM 77.45 → `rounding_adjustment = +2` → tendered RM 80 → change RM 2.55 → receipt shows "Rounding +0.02"
2. Invoice RM 77.42 → rounded RM 77.40 → `rounding_adjustment = −2`

**Split**
1. RM 77.43 → card RM 50.00 exact → balance RM 27.43 → cash → rounded RM 27.45 → adjustment +2

**Open / close**
1. Morning: open session, float RM 200
2. Evening: close → expected RM 1 847.35 → counted RM 1 845.00 → variance −RM 2.35 → within threshold → note "coins" → close → Z-report prints → `eod.closed`

**Void**
1. Cashier took card but recorded cash → ADMIN void (reason) → re-record as card → session expected cash corrects

## 5. Data model

```
cash_session
  id              uuid pk
  tenant_id       uuid not null
  branch_id       uuid not null
  drawer_code     text not null default 'MAIN'
  status          enum(OPEN, SUSPENDED, CLOSED) not null
  opened_by       uuid not null, opened_at timestamptz not null
  float_amount    bigint not null
  closed_by       uuid, closed_at timestamptz
  expected_cash   bigint
  counted_cash    bigint
  variance        bigint
  denominations   jsonb
  variance_note   text
  approved_by     uuid, approved_at timestamptz
  totals_by_method jsonb                         -- frozen at close
  INDEX (branch_id, status)
  INDEX (branch_id, opened_at)
  UNIQUE (branch_id, drawer_code) WHERE status IN ('OPEN','SUSPENDED')

cash_session_movement
  id uuid pk, tenant_id, session_id → cash_session
  type   enum(FLOAT_IN, CASH_DROP, PETTY_OUT, PAYMENT_IN, VOID_OUT, REFUND_OUT) not null
  amount bigint not null, reference_type text, reference_id uuid, reason text, by uuid, at timestamptz

payment
  id                uuid pk
  tenant_id         uuid not null
  branch_id         uuid not null
  invoice_id        uuid not null → invoice
  session_id        uuid not null → cash_session
  receipt_no        text not null
  series_year int, series_seq int
  method            enum(CASH, CARD, DUITNOW_QR, BANK_TRANSFER, EWALLET, CHEQUE) not null
  amount            bigint not null                -- applied to invoice (after rounding for cash)
  tendered          bigint                         -- cash
  change_given      bigint                         -- cash
  rounding_applied  bigint not null default 0      -- for this payment leg
  reference         text                           -- card last4/approval, QR ref, transfer ref
  card_brand        text
  status            enum(POSTED, VOIDED) not null default 'POSTED'
  received_by       uuid not null, received_at timestamptz not null
  voided_by uuid, voided_at timestamptz, void_reason text
  refund_of_id      uuid → payment                 -- for negative refund records
  idempotency_key   text not null
  UNIQUE (tenant_id, idempotency_key)
  UNIQUE (tenant_id, receipt_no)
  UNIQUE (branch_id, series_year, series_seq)
  INDEX (invoice_id)
  INDEX (session_id, method)
  INDEX (branch_id, received_at)
  CHECK (amount <> 0)
  CHECK (rounding_applied BETWEEN -4 AND 4)

receipt_series  (tenant_id, branch_id, year) pk, next_seq

payment_method_config
  tenant_id, branch_id, method  (pk)
  enabled bool, requires_reference bool, display_name text, sort int, qr_payload text  -- static DuitNow QR
```

## 6. State machines

**Cash session**: `OPEN` ⇄ `SUSPENDED`; `OPEN` → `CLOSED` (terminal; ADMIN may reopen same day → `OPEN`, audited).
**Payment**: `POSTED` → `VOIDED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PAY-R-01 | `invoice.amount_paid = Σ payment.amount WHERE status = POSTED` (refunds negative). | Service in same transaction; nightly assertion |
| PAY-R-02 | Rounding is computed only for the cash leg that settles the remaining balance, only once per invoice, only within ±4 sen, and written to `invoice.rounding_adjustment`. | `RoundingService` + CHECK |
| PAY-R-03 | BNM rounding table: last digit 1,2→0; 3,4→5; 6,7→5; 8,9→10. | Unit-tested function; no other implementation |
| PAY-R-04 | No payment without an open cash session at the branch. | Service |
| PAY-R-05 | Receipt numbers gapless per branch per year, allocated under lock in the payment transaction. | `receipt_series` |
| PAY-R-06 | A voided payment's amount is excluded from invoice totals and reflected as `VOID_OUT` in the session; the receipt number is retained with a void marker. | Service |
| PAY-R-07 | Void is same-day and requires the session to be open (or ADMIN reopen). | Service |
| PAY-R-08 | Expected cash at close = float + Σ PAYMENT_IN(cash) − Σ VOID_OUT(cash) − Σ REFUND_OUT(cash) − Σ CASH_DROP − Σ PETTY_OUT. | Service; frozen at close |
| PAY-R-09 | Session close freezes `totals_by_method`; later voids require reopening (audited) so reports stay consistent. | Service |
| PAY-R-10 | Payments are immutable except `status`/void fields. | Trigger |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/branches/:b/cash-sessions/current` | `payment.take` | |
| POST | `/branches/:b/cash-sessions` | `eod.close` | `{ float, drawerCode }` |
| POST | `/cash-sessions/:id/suspend` / `resume` | `eod.close` | |
| POST | `/cash-sessions/:id/movements` | `eod.close` | Drop / petty |
| GET | `/cash-sessions/:id/preview-close` | `eod.close` | Expected totals |
| POST | `/cash-sessions/:id/close` | `eod.close` (+ ADMIN approve if over threshold) | `{ counted, denominations?, note }` |
| POST | `/cash-sessions/:id/reopen` | ADMIN + reauth | Same day |
| GET | `/cash-sessions/:id/z-report` | `eod.close` | Printable |
| GET | `/invoices/:id/payment-preview?method=CASH&amount=` | `payment.take` | Returns rounding & due |
| POST | `/invoices/:id/payments` | `payment.take` | `{ method, amount, tendered?, reference?, idempotencyKey }` |
| GET | `/invoices/:id/payments` | `invoice.read` | |
| POST | `/payments/:id/void` | `payment.void` + reauth | Reason |
| POST | `/invoices/:id/refunds` | `payment.void` + reauth | `{ amount, method, reason, refundOfId? }` |
| GET | `/payments/:id/receipt` | `payment.take` | Print payload / PDF |
| POST | `/payments/:id/receipt/reprint` | `payment.take` | Audited |
| GET | `/branches/:b/outstanding` | `invoice.read` | PARTIAL/ISSUED with balance |
| CRUD | `/branches/:b/payment-methods` | `admin.settings` | |

## 9. Domain events

**Emits:** `cash_session.opened`, `cash_session.closed` (= `eod.closed`), `cash_session.reopened`, `payment.received` `{ invoiceId, amount, method, balanceAfter }`, `payment.voided`, `payment.refunded`, `receipt.issued`, `receipt.reprinted`
**Consumes:** `invoice.issued` (payment screen readiness), `invoice.voided` (block further payments)

## 10. Audit events

All §9; session close with expected/counted/variance/note/approver; voids and refunds with reason; reprints; payment-method config changes.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Payment panel (on the billing screen after issue) | Big balance; method buttons (enabled per branch); cash: tendered input with quick-tender buttons (exact, RM 50, RM 100), live change and rounding line; card/QR/transfer: reference field; "Take payment" → receipt prints → next patient; `Enter` = exact cash |
| DuitNow QR | Static QR image displayed full-screen on a customer-facing toggle (dynamic in V1) |
| Split | Add leg → remaining balance updates; rounding applies at the final cash leg only |
| Open session | Float entry; drawer select |
| Close session | Expected vs counted; denomination helper; variance colour; note; approve; Z-report print |
| Outstanding | List with patient, invoice, balance, days; take payment from here |
| Receipt | 80 mm thermal template: clinic header, receipt no, date/time, invoice no, patient, lines (or summary), subtotal/discount/total, rounding, method, tendered/change, balance, cashier, footer; A4 variant |

## 12. Validation

- Amount > 0 (refund < 0 via refund endpoint); ≤ balance (after rounding for cash)
- Cash: tendered ≥ due
- Reference required when method config says so
- Float ≥ 0; counted ≥ 0
- Void reason ≥ 10 chars

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| PAY-N-01 | Payment transaction ≤ 150 ms incl. receipt number allocation. |
| PAY-N-02 | Receipt print dispatch ≤ 1 s; printer failure does not roll back the payment. |
| PAY-N-03 | Rounding function has exhaustive unit tests for all 10 last-digit cases and split scenarios. |
| PAY-N-04 | Nightly assertion: for every invoice, `amount_paid` equals Σ posted payments; mismatches alert. |
| PAY-N-05 | Z-report totals reconcile to the sen with RPT daily sales for the same session. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Invoice RM 0.02 paid in cash | Rounds to RM 0.00; adjustment −2; payment amount 0 is invalid → record as `PAID` with a zero-amount "rounding settlement" (special-cased: allowed only when rounded due = 0). |
| Customer pays RM 77.45 cash for a RM 77.43 invoice, then wants a card refund | Not supported in V0; cash refund from drawer. |
| Card terminal declined after cashier recorded CARD | Void payment (same day), re-take. |
| Cashier closes session with a payment in flight | Close acquires a lock; in-flight payment attaches to the next session or fails with "session closed — reopen". |
| No session opened in the morning | First payment attempt prompts to open a session inline (with float). |
| Two drawers | `drawer_code`; each cashier opens their own. |
| Payment to a VOID invoice | Blocked. |
| Rounding when a membership/panel pays part (V1) | Only the patient's cash leg rounds; rules unchanged. |
| Power cut after payment saved but before receipt printed | Reprint from invoice view; marked COPY only if a print was confirmed earlier (first successful print is not a copy). |
| Counterfeit/short-change disputes | Out of scope; variance note. |

## 15. Compliance

- BNM rounding mechanism applied correctly for cash and shown on the receipt.
- Gapless receipt numbering; immutability of payment records.
- Cash session close with variance recording provides the cash control an accountant expects.
- Card details: only last 4 + brand + approval code; never PAN or CVV (PCI scope avoided).

## 16. Reporting outputs

- Daily collections by method, by session, by cashier (RPT; FIN)
- Rounding adjustments total per day (should be near zero over time)
- Variance history per cashier
- Outstanding balances ageing
- Voids and refunds with reasons

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| PAY-T-01 | Given invoice 7743 sen and CASH, then due 7745, `rounding_adjustment = +2`; given 7742, then due 7740, adjustment −2; given 7741, then 7740, −1; given 7748, then 7750, +2. |
| PAY-T-02 | Given invoice 7743, CARD 5000 then CASH, then card exact, cash due 2745, adjustment +2, invoice PAID, balance 0. |
| PAY-T-03 | Given CARD 7743 only, then no rounding and PAID. |
| PAY-T-04 | Given no open session, when paying, then 409 session-required. |
| PAY-T-05 | Given the same idempotency key twice, then one payment row and identical responses. |
| PAY-T-06 | Given 30 concurrent payments at one branch, then 30 consecutive receipt numbers. |
| PAY-T-07 | Given a session with float 20000, cash payments 150000, a void of 5000 cash and a drop of 100000, then expected cash = 65000. |
| PAY-T-08 | Given variance −1500 with threshold 1000, when FRONTDESK closes, then 403 approval-required; with ADMIN approval and note, then CLOSED. |
| PAY-T-09 | Given a payment voided, then invoice `amount_paid` decreases, status reverts (PAID→ISSUED/PARTIAL), and the session has a `VOID_OUT`. |
| PAY-T-10 | Given a payment from yesterday, when voided today, then 409; when refunded, then a negative payment linked to the original exists. |
| PAY-T-11 | Given a direct SQL update of `payment.amount`, then the trigger rejects. |

## 18. Migration & rollout

- R4 with BIL; three days parallel with the existing till; Z-report reconciled nightly to the sen against their cash count
- Receipt printer and template verified in the Phase 0 spike; thermal paper width confirmed
- Static DuitNow QR image obtained from the clinic's bank
- Opening outstanding balances from the old system: tracked on paper until V1 FIN opening receivables

## 19. Out of scope

- Payment gateway / dynamic DuitNow / card terminal integration → V1 `FIN`/`INT`
- Credit notes and refund documents → V1 `FIN`
- Membership credit, prepaid wallet → V1/V2 `MEM`/`WLT`
- Panel/corporate settlement → V1 `PNL`
- Instalments → not planned
- Multi-currency → not planned

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| PAY-Q-01 | Payment methods in use and rough mix; card terminal provider. | Pilot clinic |
| PAY-Q-02 | Receipt printer model and paper width; do they want full invoice lines on the receipt? | Pilot clinic |
| PAY-Q-03 | One drawer or several; shift changes? | Pilot clinic |
| PAY-Q-04 | Acceptable variance before owner approval. | Pilot clinic owner |
| PAY-Q-05 | Do they allow partial payment / credit to regular patients today? | Pilot clinic owner |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] PAY-T-01 … T-11 green
- [ ] Rounding function exhaustively tested and reviewed against real receipts from the clinic's current till
- [ ] Receipt printed on the clinic's printer; template approved by the owner
- [ ] Three consecutive days reconciled to the sen
- [ ] Nightly `amount_paid` assertion running
- [ ] Open questions answered
