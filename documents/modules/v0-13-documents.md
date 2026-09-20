# Documents (DOC)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 2 (MC, referral, Rx printout) · Phase 4 (invoice, receipt) |
| **Spec sections** | 20 |
| **Depends on** | CON, RX, BIL, PAY, PAT, TEN, AUD |
| **Depended on by** | EIV, PPT, NTF |
| **Est. effort** | ~10 h (+ Phase 0 printing spike) |

---

## 1. Purpose & business value

The paper the patient walks out with: MC, referral letter, prescription, invoice, receipt, labels. Each is generated from a signed or issued record, numbered, stored so a reprint is byte-identical, and printed on the clinic's letterhead. Printing is also the single highest-likelihood technical risk in the project (`../07-pilot-and-risks.md`), which is why the rendering and printing approach is settled in a Phase 0 spike, not in Phase 4.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `document.issue` — generate MC / referral / Rx printout | ✓ | ✓ | – | ✓ (Rx printout, invoice, receipt only) |
| Issue MC / referral / medical letter | – | ✓ | – | – |
| `document.reprint` | ✓ | ✓ | ✓ | ✓ |
| Manage templates and letterhead (`admin.settings`) | ✓ | – | – | – |
| View patient's documents (`patient.read`; clinical docs need `clinical.read`) | ✓ | ✓ | ✓ | ✓/– |

## 3. Functional requirements

### Rendering & printing (Phase 0 spike output)
| ID | Requirement | Priority |
|---|---|---|
| DOC-F-01 | One rendering pipeline: HTML template (per document type, per tenant override) → PDF via headless Chromium (Playwright) in a worker process → stored in object storage → served for print/download. Decide in the spike whether thermal receipts/labels go through the same pipeline or a raw ESC/POS path; record the decision here. | Must |
| DOC-F-02 | Print targets: A4 laser (letters, invoices), 80/58 mm thermal (receipts, queue tickets), label printer (medication labels, 50×30 / 70×40). Each target has a template family and a tested CSS `@page` setup or raw driver. | Must |
| DOC-F-03 | Browser print path must work with zero dialog on kiosk-configured stations (Chrome `--kiosk-printing`) for receipts and labels; letters may show the dialog. If browser printing proves unreliable in the spike, a small local print agent (HTTP → printer) is the fallback and its spec is added here. | Must |
| DOC-F-04 | Every generated document is stored (`document` row + PDF) and reprints serve the stored file — never regenerated from live data. | Must |

### Document types (V0)
| ID | Requirement | Priority |
|---|---|---|
| DOC-F-05 | **Medical Certificate (MC)**: number series per branch (`<BRANCH>-MC-<YYYY>-<seq>`, gapless), patient name + ID (full IC — MCs are identity documents; confirm DOC-Q-02), date(s) unfit from/to and number of days, "fit for light duty" variant, diagnosis optional (patient choice, default omitted), doctor name + MMC/APC no. + signature (image or typed), clinic stamp block, issue timestamp, QR with verification code (V1 public verification page; V0 stores the code). Issued only from a signed consultation by its doctor. | Must |
| DOC-F-06 | **Referral letter**: to (specialist/hospital/free text), reason, summary (prefilled from consultation: complaint, findings, diagnosis, current meds), urgency, doctor signature block, numbered. | Must |
| DOC-F-07 | **Prescription printout** (for external filling): patient, items (from RX), doctor block, controlled-drug fields when applicable, numbered. | Must |
| DOC-F-08 | **Invoice** and **Receipt**: per BIL/PAY specs; A4 and thermal templates. | Must |
| DOC-F-09 | **Medication label**: per DSP; label template per branch. | Must |
| DOC-F-10 | **Queue ticket**: optional thermal slip on check-in (ENC). | Should |
| DOC-F-11 | **Medical report / letter (generic)**: free-form letter with letterhead and signature, typed by the doctor, numbered, fee-bearing (BIL `DOCUMENT` line via billable item). | Should |
| DOC-F-12 | **Lab request** (free text) for external labs, on letterhead. | Should |
| DOC-F-13 | **Consultation record print**: signed record with amendments (CON-F-19). | Should |

### Management
| ID | Requirement | Priority |
|---|---|---|
| DOC-F-14 | Letterhead per branch (logo, name, address, phone, registration no.) from TEN; header/footer applied to all A4 documents. | Must |
| DOC-F-15 | Templates are versioned; a document records the template version used. Tenant overrides (wording, layout tweaks) are supported via a constrained set of editable blocks, not raw HTML in V0. | Must |
| DOC-F-16 | Doctor signature: uploaded image (PNG, transparent) per doctor, or typed name; the document stores which was used. | Must |
| DOC-F-17 | Language: MC and receipt in MS + EN (bilingual layout); others EN default with MS option. | Must |
| DOC-F-18 | Document list on the patient record and on the encounter; filter by type; view/print/download; issue-time metadata (who, when, printed count). | Must |
| DOC-F-19 | Cancel a document (e.g. MC issued in error): status `CANCELLED` with reason; number retained; a replacement is a new document referencing the cancelled one; cancelled documents print with a "CANCELLED" watermark if ever reprinted. | Must |
| DOC-F-20 | Verification code for MC and referral: random 10-char code stored; V1 adds a public verification URL (employer checks MC authenticity). | Should |

## 4. Key workflows

**MC from consultation**
1. Doctor plan → `M` → MC dialog: days (2), from (today), fit-for-light-duty (no), include diagnosis (no) → Issue
2. Number allocated, PDF rendered, stored; print dialog / auto-print; document appears on encounter and patient record; BIL adds fee line if configured

**Receipt at payment**
1. PAY records payment → DOC renders receipt to thermal template → kiosk print, no dialog → stored PDF

**Reprint**
1. Patient lost MC → Patient → Documents → MC → Reprint → stored PDF prints with "COPY" overlay → audited

**Cancel & replace**
1. Wrong dates on MC → Cancel (reason) → Issue new MC → references cancelled

## 5. Data model

```
document
  id              uuid pk
  tenant_id       uuid not null
  branch_id       uuid not null
  patient_id      uuid → patient
  encounter_id    uuid → encounter
  type            enum(MC, REFERRAL, RX_PRINT, INVOICE, RECEIPT, LABEL, QUEUE_TICKET, MEDICAL_LETTER, LAB_REQUEST, CONSULT_RECORD, OTHER) not null
  document_no     text                          -- for numbered types
  series_year int, series_seq int
  status          enum(ISSUED, CANCELLED) not null default 'ISSUED'
  source_type     text, source_id uuid          -- consultation / prescription / invoice / payment / dispense_item
  template_key    text not null, template_version int not null
  language        text not null
  storage_key     text not null                 -- PDF (or print payload for raw thermal)
  content_hash    text not null
  payload         jsonb not null                -- the data used to render (for audit / re-render in a new template)
  verification_code text
  issued_by       uuid not null, issued_by_name text, issued_at timestamptz not null
  signature_kind  enum(IMAGE, TYPED, NONE)
  print_count     int not null default 0, last_printed_at timestamptz
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text, replaced_by_id uuid → document
  fee_line_id     uuid → invoice_line
  UNIQUE (tenant_id, document_no) WHERE document_no IS NOT NULL
  INDEX (patient_id, type, issued_at desc)
  INDEX (encounter_id)
  INDEX (verification_code)

document_series   (tenant_id, branch_id, type, year) pk, next_seq

document_template
  id uuid pk, tenant_id (null = platform default), key text, version int, target enum(A4, THERMAL_80, THERMAL_58, LABEL_50x30, LABEL_70x40),
  html text, css text, editable_blocks jsonb, active bool
  UNIQUE (coalesce(tenant_id,'00000000-…'), key, version)

doctor_signature
  user_id pk, tenant_id, storage_key text, uploaded_at, active bool

mc_detail   (typed projection for reporting / verification)
  document_id pk, from_date date, to_date date, days int, light_duty bool, diagnosis_included bool
```

## 6. State machines

Document: `ISSUED` → `CANCELLED` (with optional `replaced_by_id`).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| DOC-R-01 | Documents are generated only from signed/issued sources: MC/referral from a `SIGNED` consultation; Rx print from an `ACTIVE`+ prescription; invoice from `ISSUED`; receipt from a `POSTED` payment. | Service |
| DOC-R-02 | A stored document is never regenerated; reprint serves the stored file. Template changes affect only new documents. | Service |
| DOC-R-03 | Numbered types use gapless per-branch-per-year series allocated under lock in the issue transaction. | `document_series` |
| DOC-R-04 | Cancelled documents keep their number; the replacement gets a new one and both cross-reference. | Service |
| DOC-R-05 | MC can only be issued by the consultation's doctor (or an ADMIN-reassigned signer). | Service |
| DOC-R-06 | `content_hash` computed at issue; nightly job verifies stored files (with CON integrity job). | Job |
| DOC-R-07 | Rendering runs outside the tenant transaction (TEN-F-17): gather payload in-tx, render out-of-tx, store, then write `document` in a short tx. | Service structure |
| DOC-R-08 | Full IC appears only on document types that require it (MC, controlled Rx); all others use the masked form. | Template payload builder |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/consultations/:id/documents/mc` | DOCTOR `document.issue` | `{ fromDate, days, lightDuty, includeDiagnosis, language }` |
| POST | `/consultations/:id/documents/referral` | DOCTOR | `{ to, reason, summary, urgency }` |
| POST | `/consultations/:id/documents/letter` | DOCTOR | Free-form; fee item optional |
| POST | `/consultations/:id/documents/lab-request` | DOCTOR | |
| POST | `/prescriptions/:id/print` | `document.issue` | Rx printout |
| GET | `/invoices/:id/print` · `/payments/:id/receipt` | (BIL/PAY perms) | Returns stored document |
| GET | `/documents/:id` | `patient.read` (+ `clinical.read` for clinical types) | Metadata |
| GET | `/documents/:id/file` | as above | Signed URL / stream |
| POST | `/documents/:id/print` | `document.reprint` | Increments count; audited; COPY overlay when `print_count > 0` |
| POST | `/documents/:id/cancel` | issuer or ADMIN | Reason; optional replacement flow |
| GET | `/patients/:id/documents?type=` | `patient.read` | |
| GET | `/encounters/:id/documents` | `patient.read` | |
| CRUD | `/document-templates` | `admin.settings` | Editable blocks only in V0 |
| PUT | `/me/signature` | DOCTOR | Upload |
| GET | `/verify/:code` | public | V1 (returns type, date, validity — no clinical detail) |

Print dispatch is client-side (kiosk print) or via the local print agent if the spike chooses it; the API returns a print-ready payload either way.

## 9. Domain events

**Emits:** `document.issued` `{ type, documentId, patientId, encounterId, feeItemCode? }`, `document.printed`, `document.reprinted`, `document.cancelled`
**Consumes:** `consultation.signed` (enable MC/referral), `invoice.issued` (render invoice), `payment.received` (render receipt), `dispense.completed` (render labels), `consultation.amended` (flag existing CONSULT_RECORD prints as superseded)

## 10. Audit events

All §9; template changes; signature uploads; every reprint with actor; MC issue carries from/to/days.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| MC dialog | Days stepper, from date (default today), to date auto; light duty toggle; include diagnosis toggle (default off); preview pane; Issue & print |
| Referral dialog | To (recent recipients type-ahead), reason, editable summary prefilled, urgency; preview; Issue & print |
| Documents tab (patient / encounter) | Table: type, number, date, issued by, prints; view (inline PDF), print, cancel |
| Templates admin | Per type: preview with sample data; editable blocks (footer text, MC wording variants); letterhead preview |
| Print status toast | "Printing MC…" → "Printed" / "Printer error — retry / choose printer" |

## 12. Validation

- MC: days 1–30 (tenant max); from date within ±7 days of today; to = from + days − 1
- Referral: `to` 2–200 chars; reason required
- Letter: body ≤ 10 000 chars
- Signature image ≤ 500 KB PNG
- Cancel reason ≥ 10 chars

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| DOC-N-01 | A4 PDF render ≤ 1.5 s p95; thermal payload ≤ 200 ms. |
| DOC-N-02 | Renderer isolated in a worker (crash does not take the API down); 2 concurrent renders per CPU. |
| DOC-N-03 | Stored PDFs encrypted at rest; signed URLs 5 min; no PHI in object keys. |
| DOC-N-04 | Templates render identically on repeated runs (deterministic; fonts embedded). |
| DOC-N-05 | Print path tested on the clinic's exact printer models with real paper/labels before R2 (letters/labels) and R4 (receipts). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Printer offline at MC issue | Document is issued and stored; print retried; "Print later" from the documents tab. |
| MC backdated request | Allowed within −7 days with a reason captured; audited; tenant may set to 0. |
| Doctor has no signature image | Typed signature block with name + registration; document records `TYPED`. |
| Renderer crash mid-issue | Transaction not yet written (DOC-R-07); retry safe; series number not consumed (allocated in the final short tx). |
| Template edited after documents exist | Old documents unchanged; new use new version. |
| Patient requests MC without diagnosis after one was issued with it | Cancel + replace. |
| Referral to a recipient not in list | Free text; added to recent list. |
| Very long invoice (30 lines) on thermal | Template paginates; A4 offered. |
| Label printer runs out mid-batch | Per-label print status; reprint remaining from DSP. |

## 15. Compliance

- MC is a legal document; numbering, doctor identification (MMC/APC), immutability and cancellation trail matter.
- Full IC on MC (identity) vs masked elsewhere (PDPA minimisation) — DOC-R-08.
- Referral letters carry clinical information — treated as clinical documents (`clinical.read`).
- Stored documents are part of the medical record and follow its retention.

## 16. Reporting outputs

- MCs issued per doctor per day; days certified (governance)
- Referrals by recipient
- Document fees billed (FIN)
- Print failure rate (ops)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| DOC-T-01 | Given an unsigned consultation, when MC is requested, then 409. |
| DOC-T-02 | Given a signed consultation, when MC (2 days from today) is issued, then a `document` with gapless number exists, `mc_detail` has to = from + 1, the PDF is stored, and BIL has a fee line if configured. |
| DOC-T-03 | Given an issued MC, when the template is changed and the MC reprinted, then the reprinted bytes equal the original and carry a COPY overlay applied at print time (not baked into the stored file). |
| DOC-T-04 | Given 20 concurrent MC issues at a branch, then 20 consecutive numbers. |
| DOC-T-05 | Given an MC cancelled and replaced, then both documents cross-reference; the cancelled one reprints with CANCELLED watermark. |
| DOC-T-06 | Given a receipt, then the thermal payload prints correctly on the clinic's printer with no dialog (manual test recorded). |
| DOC-T-07 | Given a referral, then FRONTDESK cannot view it (403) and DOCTOR can. |
| DOC-T-08 | Given a nightly integrity run, when a stored PDF is altered, then a mismatch alert is raised. |

## 18. Migration & rollout

- **Phase 0 spike (blocking)**: obtain the clinic's printer models; print a real MC on A4, a real receipt on thermal, a real label; choose browser-kiosk vs print-agent; write the decision into DOC-F-01/03
- Letterhead artwork and doctor signatures collected before R2
- MC wording reviewed by the doctor (bilingual)
- Old MC/receipt series: decide whether to continue numbering (DOC-Q-03)

## 19. Out of scope

- Public MC verification page → V1
- Signed consent forms with e-signature capture → V1
- Corporate guarantee letters, panel forms → V1 `PNL`
- Membership documents/cards → V1 `MEM`
- Immunisation certificate → V1
- Rich template editor → V2 `ADM`
- Digital signatures (PKI) → V3

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| DOC-Q-01 | Exact printer models: A4, receipt, label; connected how (USB/network)? | Pilot clinic |
| DOC-Q-02 | Full IC on MC — confirm their current practice and any employer/regulator expectation. | Pilot clinic |
| DOC-Q-03 | Continue existing MC/receipt numbering series? | Pilot clinic |
| DOC-Q-04 | MC wording/format they use today (sample). | Pilot clinic |
| DOC-Q-05 | Do doctors want signature images or typed blocks? | Pilot clinic doctors |
| DOC-Q-06 | Any documents beyond this list they issue regularly? | Pilot clinic |

## 21. Definition of done

- [ ] Phase 0 printing spike complete; approach recorded in DOC-F-01/03
- [ ] All Must requirements implemented
- [ ] DOC-T-01 … T-08 green (T-06 recorded as a manual test with photo)
- [ ] MC, referral, receipt, label printed on the clinic's printers and approved
- [ ] Integrity job covering documents
- [ ] Open questions answered
