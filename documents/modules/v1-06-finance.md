# Finance (FIN)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 21 |
| **Depends on** | BIL, PAY, INV, PUR, PNL, MEM, EIV, RPT, AUD |
| **Depended on by** | ANL, BRN (consolidation), INT (accounting) |
| **Est. effort** | ~60 h |

---

## 1. Purpose & business value

Beyond the daily till: what the business actually made. Receivables (panel/corporate), payables (suppliers), expenses, credit notes and refunds as proper documents, COGS from the stock ledger, and a profit view per branch/doctor/service line — exported cleanly to the accountant. FIN does not replace accounting software; it makes the clinic's numbers correct and exportable so the accountant's job is reconciliation, not reconstruction.

## 2. Actors & permissions

| Action | ADMIN | FINANCE (V1 RBC role) | Others |
|---|:-:|:-:|:-:|
| `finance.read` — all financial reports | ✓ | ✓ | – |
| `finance.write` — expenses, credit notes, refunds, payables payments, period close | ✓ | ✓ | – |
| Export to accounting | ✓ | ✓ | – |
| Chart of accounts / mapping config | ✓ | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FIN-F-01 | **Credit notes**: against an issued invoice (full or partial, line-referenced), numbered series, reason, effect on receivable/refundable balance; **refund documents** linked to PAY refunds; replaces V0's void-and-reissue for post-payment corrections. e-Invoice credit/refund notes via EIV. | Must |
| FIN-F-02 | **Receivables**: patient outstanding (PAY), panel/corporate claims (PNL) unified into an AR ledger with ageing, dunning lists, write-offs (reason, approval). | Must |
| FIN-F-03 | **Payables**: supplier invoices (PUR) and recorded expenses; AP ageing; payment runs; bank/transfer references. | Must |
| FIN-F-04 | **Expenses**: categories (rent, utilities, salaries [summary], consumables not via stock, marketing, locum fees, equipment), amount, date, branch, supplier/payee, attachment (receipt image), recurring templates, approval over threshold. | Must |
| FIN-F-05 | **COGS**: from `stock_movement` (DISPENSE/CONSUME at `unit_cost`) per period; shrinkage (adjustments/expiry/damage) reported separately. | Must |
| FIN-F-06 | **Revenue analysis**: by branch, doctor, service line (consultation / medicine / procedure / document / membership / other), payer type; gross vs net of discounts; per period. | Must |
| FIN-F-07 | **Profitability**: revenue − COGS − expenses per branch per period (management view, not statutory); gross margin on medicines. | Must |
| FIN-F-08 | **Doctor revenue and commission basis**: revenue attributed to the attending doctor per line type; export for HR commission (HR module computes). | Should |
| FIN-F-09 | **Period close** (monthly): locks financial documents dated in the period from further void/credit (adjustments go in the next period with reference); snapshot of key totals; reopen requires ADMIN + reason. | Must |
| FIN-F-10 | **Accounting export**: journal-style CSV per period mapped to a configurable chart of accounts (sales by line type, discounts, tax, cash/bank/card clearing, AR, AP, COGS, stock, expenses); formats for common MY accounting packages (generic CSV first; specific templates as needed). | Must |
| FIN-F-11 | **Bank reconciliation helper**: card/QR/transfer settlements matched to bank statement lines (CSV import) by amount/date/reference; unmatched list. | Should |
| FIN-F-12 | Cash controls roll-up: sessions, variances, drops, by cashier per period (from PAY). | Must |

## 4. Key workflows

Month end → close cash sessions → review discounts/voids → generate credit notes for disputes → period close → accounting export CSV → accountant imports · Panel remittance (PNL) → AR reduced → ageing updated · Expense: rent RM 4 000 → recurring template posts monthly → approval → paid → AP cleared.

## 5. Data model

```
credit_note            id, tenant_id, branch_id, invoice_id, credit_note_no, status, subtotal, tax, total, reason, lines jsonb (line refs + amounts), issued_by, issued_at, einvoice fields, applied_to enum(REFUND, AR_BALANCE)
refund_document        id, tenant_id, payment_id (PAY negative), credit_note_id, refund_no, method, amount, issued_at
ar_ledger              id, tenant_id, branch_id, party_type enum(PATIENT, PAYER), party_id, doc_type, doc_id, debit bigint, credit bigint, balance_after, at
ap_ledger              id, tenant_id, branch_id, party_type enum(SUPPLIER, PAYEE), party_id, doc_type, doc_id, debit, credit, balance_after, at
expense_category       id, tenant_id, code, name, account_code, active
expense                id, tenant_id, branch_id, category_id, payee_id/name, amount, tax, date, description, attachment_key, status enum(DRAFT, PENDING_APPROVAL, APPROVED, PAID, REJECTED), recurring_template_id, approved_by, paid_at, payment_ref
expense_recurring      id, tenant_id, branch_id, category_id, amount, day_of_month, payee, active, next_run
fiscal_period          id, tenant_id, year, month, status enum(OPEN, CLOSED), closed_by, closed_at, snapshot jsonb, reopened_by, reopen_reason
account_mapping        id, tenant_id, key (e.g. SALES_CONSULTATION, DISCOUNTS, CASH_CLEARING, AR_PANEL, COGS_MEDICINE, STOCK, AP_SUPPLIER, EXPENSE:<cat>), account_code, account_name
accounting_export      id, tenant_id, period_id, format, storage_key, generated_by, generated_at, totals jsonb
bank_statement_line    id, tenant_id, branch_id, date, amount, reference, description, matched_to_type, matched_to_id, import_batch
write_off              id, tenant_id, party_type, party_id, doc_type, doc_id, amount, reason, approved_by, at
```

## 6. State machines

Expense: `DRAFT → PENDING_APPROVAL → APPROVED → PAID`; `→ REJECTED`. Period: `OPEN → CLOSED → OPEN` (reopen, audited). Credit note: `ISSUED` (immutable) → `CANCELLED` (same day, unapplied only).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| FIN-R-01 | AR/AP ledgers are append-only projections written in the same transaction as their source documents; balances derived. | Services in BIL/PAY/PNL/PUR call FIN ledger writer |
| FIN-R-02 | A credit note ≤ invoice balance + refundable paid amount; line references must exist on the invoice. | Service |
| FIN-R-03 | Documents dated in a CLOSED period cannot be voided/credited; corrections are new documents in an OPEN period referencing them. | Service |
| FIN-R-04 | COGS uses movement `unit_cost` snapshots; never current batch cost. | View definition |
| FIN-R-05 | Accounting export totals reconcile to RPT daily sales/collections and to the AR/AP ledgers for the period; the export job asserts this before writing the file. | Job |
| FIN-R-06 | Every write-off has a reason and an approver distinct from the requester when `finance.segregation = true`. | Service |

## 8. API surface

`/credit-notes` create/get/cancel · `/refund-documents` · `/ar?party&age` · `/ap?age` · `/expenses` CRUD + `/submit|approve|reject|pay` · `/expense-recurring` · `/periods` list + `/close|reopen` · `/account-mappings` · `POST /accounting-exports` + get file · `/bank-statements/import` + `/match` · `/reports/finance/revenue|profit|cogs|cash-controls|doctor-revenue`.

## 9. Domain events

**Emits:** `credit_note.issued`, `refund.documented`, `expense.approved`, `expense.paid`, `period.closed`, `period.reopened`, `write_off.recorded`, `accounting_export.generated`
**Consumes:** `invoice.issued/voided`, `payment.received/voided/refunded`, `claim.*`, `remittance.recorded`, `supplier_invoice.*`, `stock.moved`, `membership.*` (revenue lines)

## 10. Audit events

All §9; account mapping changes; period reopen with reason; write-offs.

## 11. Screens & UX requirements

Finance home (period selector; revenue/COGS/expenses/profit tiles; AR/AP ageing) · Credit note dialog from invoice · Expenses list and entry with receipt photo · Approvals inbox · Period close checklist (open sessions, unmatched remittances, pending approvals) · Export page with reconciliation summary before download · Bank matching grid.

## 12. Validation

Credit note amounts ≤ limits; expense amount > 0 with category; period close blocked while any cash session in the period is open; mapping keys all assigned before first export.

## 13. Non-functional requirements

Period export for 10 k documents ≤ 2 min; AR ageing ≤ 500 ms; all figures integer sen; reconciliation assertions in CI on seeded data.

## 14. Edge cases & failure modes

Credit note after e-Invoice validated (EIV credit note flow) · expense paid from petty cash (PAY session PETTY_OUT linked) · locum fees as expense vs HR payroll (expense in V1; HR later) · multi-branch shared expenses (allocation % per branch, V2 BRN) · reopened period changes exported figures (export marked superseded; regenerate).

## 15. Compliance

Financial records retained per Companies Act/tax requirements (confirm 7 years); credit/refund notes numbered and immutable; exports auditable; SST reporting support if applicable.

## 16. Reporting outputs

Revenue/COGS/expenses/profit by branch/period; margin by product category; AR/AP ageing; cash controls; doctor revenue; discounts and write-offs; export history.

## 17. Acceptance tests (representative)

FIN-T-01 credit note reduces AR and, if refund, links to a PAY refund · T-02 period close blocks void of an invoice in that period · T-03 export totals = RPT sales + collections + AR delta for the period · T-04 COGS for a period equals Σ(dispense/consume qty × unit_cost) · T-05 expense over threshold requires approval by a different user · T-06 write-off requires reason and approver.

## 18. Migration & rollout

Opening AR (patients, payers) and AP (suppliers) balances entered as opening documents; chart of accounts mapping agreed with the accountant; first period export reviewed side-by-side with their current books.

## 19. Out of scope

Full double-entry general ledger, statutory financial statements → accounting software · payroll → V2/V3 · fixed assets/depreciation → not planned · direct accounting API integration → V3 `INT`.

## 20. Open questions

FIN-Q-01 accounting package and import format · Q-02 expense categories they track · Q-03 who approves expenses · Q-04 opening balances availability · Q-05 commission basis for doctors (for FIN-F-08).

## 21. Definition of done

- [ ] Must requirements implemented; FIN-T-01 … T-06 green
- [ ] First month-end closed and exported; accountant confirms reconciliation
- [ ] Open questions answered
