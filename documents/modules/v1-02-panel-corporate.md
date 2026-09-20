# Panel & Corporate (PNL)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 14 |
| **Depends on** | PAT, BIL, PAY, ENC, DOC, FIN, NTF, AUD |
| **Depended on by** | MEM (corporate), FIN, EIV, RPT |
| **Est. effort** | ~80 h |

> If the pilot's panel share is large, a minimal path (payer on invoice + statement) may need to land in V0 Phase 4 — see `../07-pilot-and-risks.md` risk 8.

---

## 1. Purpose & business value

Third-party payers: insurance panels (via TPAs/MCOs) and corporate accounts whose employees are treated on credit. For many Malaysian GP clinics this is 30–60% of visits. Getting it wrong means unpaid claims, angry HR departments and a receivables mess. This module models eligibility, coverage rules, co-payments, claims and statements so the front desk knows *before the consultation* what is covered, and the owner knows *at month end* what is owed.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `panel.read` — see patient's payer, coverage, balance | ✓ | ✓ | ✓ | ✓ |
| `panel.verify` — verify eligibility, attach GL/reference at check-in | ✓ | – | – | ✓ |
| `panel.manage` — payers, corporate accounts, employees, coverage rules | ✓ | – | – | – |
| `claim.manage` — submit, update status, reconcile payments | ✓ | – | – | – |
| Statement generation and sending | ✓ | – | – | – |

## 3. Functional requirements

### Payers
| ID | Requirement | Priority |
|---|---|---|
| PNL-F-01 | Payer record: type (`PANEL_INSURER`, `TPA_MCO`, `CORPORATE`, `GOVERNMENT`), name, registration/TIN, contacts, billing address, payment terms (days), claim method (`PORTAL`, `EMAIL`, `PAPER`, `API` later), required claim fields (e.g. GL number, employee ID, policy no.), statement cycle (weekly/monthly), status. | Must |
| PNL-F-02 | **Coverage rules** per payer (versioned): consultation covered (yes/no/limit), medicine covered (yes/no/limit/formulary list/excluded categories), procedure coverage (list/limit), per-visit cap, per-month/year cap per member, co-payment (amount or %, per component), excluded diagnoses/services, requires GL/pre-authorisation above amount, MC limits, dependants covered. | Must |
| PNL-F-03 | Corporate account: company, contacts, credit limit, employees list (linked to patients; employee ID; dependants), department cost centres, PO/reference requirements, statement recipients. | Must |
| PNL-F-04 | Employee eligibility: status (active/terminated with date), coverage tier, annual limit tracking. Bulk import/update from HR CSV. | Must |

### At the visit
| ID | Requirement | Priority |
|---|---|---|
| PNL-F-05 | Patient–payer association (many allowed; one default); check-in shows payer, coverage summary, remaining limits, and required references; FRONTDESK selects payer for the encounter and captures GL/reference/pre-auth. | Must |
| PNL-F-06 | Eligibility verification record (manual in V1: who called/checked, reference, timestamp; API in V3). | Must |
| PNL-F-07 | Billing: invoice `payer_type = PANEL/CORPORATE`, `payer_id`; coverage engine splits each line into **payer portion** and **patient portion** (co-pay, excess over caps, excluded items) → two settlement targets on one invoice: patient pays their portion at the counter (PAY); payer portion becomes a **claim**. | Must |
| PNL-F-08 | Excluded items and over-cap amounts are shown at billing before issue so the patient can decide (pay or decline the item). | Must |
| PNL-F-09 | Panel-specific documents: claim form (payer template), corporate guarantee letter acknowledgement, itemised bill with diagnosis (payer requirement; consent captured). | Must |

### Claims & receivables
| ID | Requirement | Priority |
|---|---|---|
| PNL-F-10 | Claim per invoice-payer: amount, status (`DRAFT` → `SUBMITTED` → `ACKNOWLEDGED` → `APPROVED`/`PARTIALLY_APPROVED`/`REJECTED` → `PAID`/`WRITTEN_OFF`), submission batch, payer reference, rejection reason, resubmission link. | Must |
| PNL-F-11 | Submission batches per payer per cycle: export (CSV/PDF/payer format), mark submitted, track ageing. | Must |
| PNL-F-12 | Payment reconciliation: record a payer remittance (amount, reference, date) and allocate across claims (full/partial/short-pay with reason); unallocated remainder tracked. | Must |
| PNL-F-13 | Statements per payer/corporate per cycle: outstanding claims, ageing, totals; PDF; send via NTF; statement history. | Must |
| PNL-F-14 | Receivables ageing and dunning list (FIN). Credit limit warning for corporates at check-in. | Must |
| PNL-F-15 | Rejected claim handling: convert to patient-payable (with consent) or write off (ADMIN, reason). | Must |

## 4. Key workflows

**Panel visit**: check-in → payer = "TPA X", GL no. captured → consult → billing: consultation covered, 2 meds covered, 1 excluded (patient pays RM 12), co-pay RM 5 → patient pays RM 17 → claim RM 78 created → month end: batch → submit → remittance → allocate → paid.

**Corporate**: employee verified against list → limit remaining RM 340 → bill RM 95 all to corporate → statement monthly → corporate pays by transfer → allocate.

**Rejection**: claim rejected "GL expired" → resubmit with new GL or convert to patient-payable → call patient (NTF).

## 5. Data model

```
payer                       id, tenant_id, type, name, reg_no, tin, contacts jsonb, address, payment_terms_days, claim_method,
                            required_fields jsonb, statement_cycle, status
payer_coverage_version      id, payer_id, version, rules jsonb, effective_from, effective_to
corporate_account           id, tenant_id, payer_id, company_name, credit_limit bigint, po_required bool, statement_recipients jsonb, status
corporate_employee          id, corporate_account_id, patient_id, employee_no, department, tier, status, start_date, end_date, annual_limit bigint
patient_payer               id, patient_id, payer_id, corporate_employee_id, policy_no, member_no, is_default, valid_from, valid_to
encounter_payer             id, encounter_id, payer_id, patient_payer_id, gl_no, preauth_no, reference, verified_by, verified_at, notes
invoice_settlement          id, invoice_id, target enum(PATIENT, PAYER), payer_id, amount bigint, status
                            -- Σ amounts = invoice grand_total (+rounding on PATIENT cash leg)
invoice_line_coverage       id, invoice_line_id, payer_amount bigint, patient_amount bigint, rule_applied text, excluded bool, reason
claim                       id, tenant_id, branch_id, invoice_id, payer_id, settlement_id, claim_no, amount bigint, approved_amount bigint,
                            paid_amount bigint, status, batch_id, payer_ref, submitted_at, decided_at, rejection_reason,
                            resubmission_of_id, written_off_by, write_off_reason
claim_batch                 id, tenant_id, payer_id, cycle_label, status, exported_at, submitted_at, export_key, claim_count, total
payer_remittance            id, tenant_id, payer_id, amount, received_at, reference, method, unallocated bigint, recorded_by
remittance_allocation       id, remittance_id, claim_id, amount, short_pay_reason
payer_statement             id, tenant_id, payer_id, period_from, period_to, total_outstanding, storage_key, sent_at
```

BIL uses `invoice.payer_type/payer_id` (V0 columns) and gains `invoice_settlement` rows; PAY collects only against the PATIENT settlement.

## 6. State machines

Claim: `DRAFT → SUBMITTED → ACKNOWLEDGED → (APPROVED | PARTIALLY_APPROVED | REJECTED) → (PAID | WRITTEN_OFF)`; `REJECTED → DRAFT` (resubmission creates a new claim linked). Employee: `ACTIVE → TERMINATED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PNL-R-01 | `Σ invoice_settlement.amount = invoice.grand_total`; patient cash rounding applies only to the PATIENT settlement. | Service + CHECK via trigger |
| PNL-R-02 | Coverage is evaluated server-side from the payer's coverage version in force on the encounter date and recorded per line (`rule_applied`). | Coverage engine |
| PNL-R-03 | A claim is created only when the invoice is ISSUED and only for the PAYER settlement amount; voiding the invoice cancels the claim (if not yet paid) or requires a credit note (FIN). | Service |
| PNL-R-04 | Remittance allocations ≤ claim approved amount; short-pay requires a reason; unallocated remittance is visible until resolved. | Service |
| PNL-R-05 | Corporate credit limit check at check-in and at issue; exceeding requires ADMIN override (audited). | Service |
| PNL-R-06 | Diagnosis on claim documents requires recorded patient consent (PDPA — payer receives clinical data). | DOC payload guard |
| PNL-R-07 | Employee terminated → new encounters cannot bill to that corporate; existing claims unaffected. | Service |

## 8. API surface

`/payers` CRUD + `/coverage-versions`; `/corporate-accounts` CRUD + `/employees` (+ import); `/patients/:id/payers`; `POST /encounters/:id/payer` (select/verify); `GET /invoices/:id/coverage-preview`; `/claims` list/filter; `POST /claims/:id/submit|status|write-off|resubmit`; `/claim-batches` create/export/mark-submitted; `/remittances` create + `/allocate`; `/payers/:id/statements` generate/list/send; `/reports/receivables`.

## 9. Domain events

**Emits:** `payer.updated`, `coverage.changed`, `employee.imported`, `encounter.payer_set`, `claim.created`, `claim.submitted`, `claim.status_changed`, `claim.paid`, `claim.written_off`, `remittance.recorded`, `statement.generated`, `credit_limit.warning`
**Consumes:** `invoice.issued` (create claim), `invoice.voided`, `payment.received` (patient portion), `encounter.created`

## 10. Audit events

All §9; coverage rule changes (before/after); overrides of credit limit; write-offs with reason; statement sends.

## 11. Screens & UX requirements

Check-in payer panel (payer picker, coverage summary, limits, GL/reference fields, verify) · Billing coverage view (per line: payer/patient split, excluded badge with reason; patient-due total prominent) · Claims workbench (filters by payer/status/age; bulk submit; batch export) · Remittance entry with allocation grid (auto-match by claim no./amount) · Corporate/payer admin (rules builder with test-against-sample-invoice) · Statements (generate, preview, send, history) · Receivables ageing dashboard tiles (FIN).

## 12. Validation

GL/reference required per payer config; co-pay 0–100% or ≥ 0 amount; caps ≥ 0; remittance allocations ≤ approved; write-off reason ≥ 10 chars; employee import dedupe by employee_no.

## 13. Non-functional requirements

Coverage evaluation ≤ 50 ms per invoice; claims list for 12 months ≤ 500 ms; batch export of 2 000 claims ≤ 30 s; statement PDF ≤ 3 s.

## 14. Edge cases & failure modes

Patient has two payers (choose per encounter; secondary coverage not automated) · payer changes rules mid-month (version by encounter date) · claim partially approved (patient asked to pay the difference or write-off, policy per payer) · corporate pays lump sum for several months (allocate across; unallocated carried) · invoice void after claim submitted (claim cancelled; payer notified on next statement; credit note via FIN) · patient refuses diagnosis disclosure (bill as self-pay).

## 15. Compliance

Sharing diagnoses with payers requires patient consent (PDPA) — captured per payer association; itemised bills to payers follow the payer's contract; receivables and write-offs feed the accountant (FIN); corporate invoices may be in e-Invoice scope (EIV).

## 16. Reporting outputs

Panel vs self-pay mix; claims by status/age; approval and rejection rates by payer; receivables ageing; remittances; write-offs; corporate utilisation vs limits.

## 17. Acceptance tests (representative)

PNL-T-01 payer covers consult + meds, excludes vitamins, co-pay RM 5 → settlements split to the sen · T-02 issue → claim created for payer amount · T-03 remittance short-pays by RM 10 with reason → claim PARTIALLY paid; unallocated 0 · T-04 corporate over credit limit → 409 unless ADMIN override · T-05 invoice void before submission → claim cancelled · T-06 employee terminated → new encounter cannot select corporate · T-07 statement totals = Σ outstanding claims for the period.

## 18. Migration & rollout

Import payer list, coverage rules (as understood by the clinic — expect gaps), corporate employees; enter opening outstanding claims as receivables (FIN); parallel-run one statement cycle against their current spreadsheet.

## 19. Out of scope

TPA/insurer API eligibility and claim submission → V3 `INT` · secondary/coordination of benefits · pre-authorisation workflows with payer → V2.

## 20. Open questions

PNL-Q-01 which payers, and what share of visits · Q-02 how claims are submitted today (portal/email/paper) per payer · Q-03 typical coverage rules and co-pays · Q-04 outstanding receivables today · Q-05 do payers require diagnosis on the bill.

## 21. Definition of done

- [ ] Must requirements implemented; PNL-T-01 … T-07 green
- [ ] Coverage rules for the pilot's top payers configured and tested against real past invoices
- [ ] One statement cycle run and reconciled with the clinic's records
- [ ] Open questions answered
