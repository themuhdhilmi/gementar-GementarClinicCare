# e-Invoice — MyInvois (EIV)

| | |
|---|---|
| **Version** | V1 (may be urgent — see §20) |
| **Status** | Not started |
| **Spec sections** | 22 |
| **Depends on** | BIL, PAY, PAT, PNL, TEN, NTF, AUD |
| **Depended on by** | FIN |
| **Est. effort** | ~50 h |

> `../05-safety-and-compliance.md` §6. **Verify the clinic's revenue band and mandate date with LHDN's current guidance before scheduling this module.** Thresholds and dates have moved more than once; nothing here asserts a date.

---

## 1. Purpose & business value

Compliance with LHDN's MyInvois e-Invoice regime: validated e-Invoices for buyers who request them, consolidated e-Invoices for the rest, credit/debit notes, and a clean audit of submission status. Built on V0's gapless numbering and immutable invoices, which exist partly for this reason.

## 2. Actors & permissions

| Action | ADMIN | FRONTDESK | Others |
|---|:-:|:-:|:-:|
| Capture buyer TIN/ID at billing | ✓ | ✓ | – |
| `einvoice.submit` — submit individual / consolidated | ✓ | – | – |
| Handle rejections, resubmit | ✓ | – | – |
| Configure MyInvois credentials, tenant TIN/MSIC | ✓ | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| EIV-F-01 | Tenant e-Invoice profile: TIN, business registration, MSIC code, SST no. (if any), address in the required structure, contact; MyInvois API client credentials (sandbox + production) stored encrypted; per-tenant enable flag and go-live date. | Must |
| EIV-F-02 | Buyer details capture at billing (optional per invoice): buyer type (individual / business / government / foreign), TIN (or general TIN for individuals per LHDN rules), identification (IC/passport/BRN), name, address, contact, SST no. — validated format; stored on the invoice (`buyer_tin` + `buyer_details jsonb`). Patient's TIN/ID reusable from PAT (new nullable fields). | Must |
| EIV-F-03 | Mapping invoice → UBL 2.1 JSON per MyInvois SDK: document type (invoice / credit note / debit note / refund note), line items with classification codes, tax types/rates, totals, payment mode, supplier/buyer parties; unit and currency codes. | Must |
| EIV-F-04 | **Individual e-Invoice**: submit on issue (or on request within the allowed window) when buyer details are present; poll/receive validation result; store LHDN UUID, long ID, validation link, QR; print QR + UUID on the invoice/receipt (DOC). | Must |
| EIV-F-05 | **Consolidated e-Invoice**: monthly (or per LHDN cadence) aggregation of invoices without buyer requests, per branch, using the general-public TIN rules; generated within the statutory window; submitted; status tracked; excluded invoices listed. | Must |
| EIV-F-06 | Validation errors and rejections surfaced with field-level messages; correction flow (edit buyer details → resubmit; structural errors → fix mapping); rejected documents cannot be silently dropped — they stay in a worklist until resolved or explicitly excluded with reason. | Must |
| EIV-F-07 | Credit note / refund note e-Invoices for voids/refunds referencing the original UUID (FIN credit notes); cancellation within the LHDN cancellation window where applicable. | Must |
| EIV-F-08 | Status dashboard: submitted / validated / rejected / pending per period; consolidated status; API health. | Must |
| EIV-F-09 | Digital signature of documents where required by the MyInvois flow (certificate handling per LHDN spec); certificate expiry alerts. | Must (if required for the chosen submission path) |
| EIV-F-10 | Retry with backoff on API errors; idempotent submissions keyed on invoice + document type; rate-limit aware. | Must |
| EIV-F-11 | Sandbox mode toggle per tenant for testing; clear visual indicator. | Must |
| EIV-F-12 | Buyer request after the fact ("I need an e-Invoice for this receipt") within the allowed window: capture details, submit individual, and exclude from the consolidated. | Should |

## 4. Key workflows

Corporate patient asks for e-Invoice → cashier captures TIN/BRN → issue → EIV submits → validated in seconds → receipt reprint shows QR · Month end → consolidated job builds per-branch document from all non-individual invoices → submit → validated · Rejection: "invalid TIN" → worklist → cashier calls buyer → corrected → resubmitted · Void with credit note → credit note e-Invoice referencing the original.

## 5. Data model

```
einvoice_profile      tenant_id pk, tin, brn, msic, sst_no, address jsonb, contact jsonb, client_id_enc, client_secret_enc, cert_key, cert_expiry, mode enum(SANDBOX, PRODUCTION), enabled bool, go_live_date
einvoice_document     id, tenant_id, branch_id, kind enum(INVOICE, CREDIT_NOTE, DEBIT_NOTE, REFUND_NOTE, CONSOLIDATED), invoice_id (nullable for consolidated),
                      credit_note_id, period_from, period_to, payload jsonb, payload_hash, status enum(PENDING, SUBMITTED, VALID, INVALID, CANCELLED, EXCLUDED),
                      submission_uid, lhdn_uuid, long_id, validation_link, qr_payload, submitted_at, validated_at, error jsonb, attempts int, last_attempt_at,
                      excluded_reason, created_by
                      UNIQUE (invoice_id, kind) WHERE invoice_id IS NOT NULL
einvoice_consolidated_line   id, document_id, invoice_id, amount
patient (additions)   tin, tin_type, id_for_einvoice, einvoice_address jsonb
invoice (V0 columns)  buyer_tin, buyer_details jsonb, einvoice_status, einvoice_uuid, einvoice_long_id, einvoice_qr, einvoice_submitted_at
```

## 6. State machines

Document: `PENDING → SUBMITTED → VALID | INVALID`; `INVALID → PENDING` (resubmit) | `EXCLUDED`; `VALID → CANCELLED` (within window).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| EIV-R-01 | An invoice included in a consolidated document cannot also have an individual document, and vice versa. | Service + unique partial index |
| EIV-R-02 | Payloads are generated from the immutable issued invoice; a payload hash is stored; regeneration must reproduce the hash unless mapping version changes (recorded). | Service |
| EIV-R-03 | Credentials and certificates are encrypted at rest with the platform KMS key; never logged. | Service |
| EIV-R-04 | Submission is asynchronous (queue, NTF infrastructure); issuing an invoice never waits on LHDN. | Job |
| EIV-R-05 | A rejected document remains in the worklist until VALID or EXCLUDED with reason by ADMIN. | Service |
| EIV-R-06 | Consolidated documents are generated only after the period closes and only once per branch per period (regeneration requires cancelling the prior). | Service |

## 8. API surface

`/einvoice/profile` get/put + `/test-connection` · `PUT /invoices/:id/buyer` · `POST /invoices/:id/einvoice` (submit individual) · `GET /einvoice/documents?status&period` · `POST /einvoice/documents/:id/resubmit|exclude|cancel` · `POST /einvoice/consolidated?branch&period` · `GET /einvoice/dashboard` · webhook/poll handler for validation results.

## 9. Domain events

**Emits:** `einvoice.submitted`, `einvoice.validated`, `einvoice.rejected`, `einvoice.cancelled`, `einvoice.consolidated_generated`, `einvoice.cert_expiring`
**Consumes:** `invoice.issued` (queue if buyer details present), `invoice.voided` / `credit_note.issued` (FIN), period scheduler

## 10. Audit events

Profile/credential changes (values redacted), every submission with result, exclusions with reason, cancellations.

## 11. Screens & UX requirements

Buyer details capture (at billing; "request e-Invoice" toggle; TIN validation feedback) · e-Invoice worklist (rejections with messages, fix-and-resubmit inline) · Consolidated run page (period, preview totals, submit, status) · Dashboard tiles · Profile/settings with sandbox switch and connection test · Invoice/receipt templates show QR + UUID when VALID.

## 12. Validation

TIN format per LHDN rules by buyer type; IC/passport/BRN formats; MSIC code list; address fields required by the schema; classification codes from the official list; amounts reconcile to the invoice to the sen.

## 13. Non-functional requirements

Submission job latency ≤ 60 s from issue under normal API conditions · consolidated generation for 5 000 invoices ≤ 5 min · retries with exponential backoff up to 24 h · zero PHI beyond what the schema requires is sent (no diagnoses).

## 14. Edge cases & failure modes

LHDN API down at month end (queue and retry; dashboard warning; statutory window tracking) · buyer gives TIN after consolidated submitted (handle per LHDN guidance; likely no reissue — record) · invoice voided after VALID (credit note / cancellation within window) · rounding adjustment representation in UBL (as a separate line/allowance per spec) · foreign patient without TIN (foreign buyer rules) · certificate expiry (alert 60/30/7 days) · sandbox data leaking into production (mode is per environment + per tenant, with UI banner).

## 15. Compliance

This module *is* a compliance obligation; mapping must follow the current MyInvois SDK and guidelines; retain submitted payloads and responses for the statutory period; changes to mapping are versioned and audited.

## 16. Reporting outputs

Submissions by status/period; consolidated coverage (% of invoices); rejection reasons; time-to-validation.

## 17. Acceptance tests (representative)

EIV-T-01 issued invoice with buyer TIN → document SUBMITTED → (sandbox) VALID with UUID stored and QR renderable · T-02 invoice in consolidated cannot get individual document · T-03 rejection → worklist; resubmit after fix → VALID · T-04 void with credit note → credit note document references original UUID · T-05 payload totals equal invoice totals to the sen · T-06 API outage → retries, no duplicate submissions.

## 18. Migration & rollout

Register on MyInvois sandbox; map and test with the clinic's real invoice patterns; obtain client credentials/certificate; go-live on the mandate date (or earlier voluntarily); first consolidated run reviewed with the accountant.

## 19. Out of scope

Self-billed e-Invoices for supplier scenarios → V2 · e-Invoice for membership/corporate statements beyond invoices → with FIN · intermediary/agent scenarios → not planned.

## 20. Open questions

EIV-Q-01 **revenue band and mandate date for the pilot** · Q-02 do they issue e-Invoices today via the LHDN portal · Q-03 accountant's preference for consolidated cadence · Q-04 whether corporate/panel invoices need individual e-Invoices (likely yes).

## 21. Definition of done

- [ ] Sandbox end-to-end validated for invoice, consolidated, credit note
- [ ] Must requirements implemented; EIV-T-01 … T-06 green
- [ ] Production credentials configured; go-live date recorded; first consolidated run reviewed
- [ ] Open questions answered
