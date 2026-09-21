# Documents (DOC)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Built. Open items in [v0-13-documents-end-item-OPEN.md](v0-13-documents-end-item-OPEN.md) |
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
| POST | `/prescriptions/:id/print` | `document.issue` | Rx printout. Refuses a draft prescription. |
| POST | `/invoices/:id/print` · `/payments/:id/receipt` | `document.issue` | **`POST`, not `GET`:** issuing a document writes a numbered, immutable row, which is not something a `GET` may do. The receipt is not built — `DOC-OPEN-10`. Reading one back afterwards is `GET /documents/:id/file`. |
| GET | `/documents/:id` | `patient.read` (+ `clinical.read` for clinical types) | Metadata |
| GET | `/documents/:id/file` | as above | Signed URL / stream |
| POST | `/documents/:id/print` | `document.reprint` | Increments count; audited; COPY overlay when `print_count > 0` |
| POST | `/documents/:id/cancel` | issuer or ADMIN | Reason; optional replacement flow |
| GET | `/patients/:id/issued-documents?type=` | `patient.read` | **Path changed.** §8 originally named `/patients/:id/documents`; `PAT` already owns that for files attached *to* a patient. `DOC-OPEN-14`. |
| GET | `/encounters/:id/documents` | `patient.read` | |
| CRUD | `/document-templates` | `admin.settings` | **Not built.** What exists is the branch letterhead — header text, footer text and logo — rendered onto every A4 document and editable on the branch screen. `DOC-OPEN-08`. |
| PUT | `/me/signature` · GET the same | `clinical.sign` | Upload. PNG or JPEG, verified by magic number rather than by the browser's claim. No screen yet — `DOC-OPEN-07`. |
| GET | `/verify/:code` | public | V1 (returns type, date, validity — no clinical detail). **Not built**; the code is generated, stored and printed from today so certificates issued now become verifiable later. `DOC-OPEN-13`. |

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

| ID | Question | Who | Answer, or what was built without one |
|---|---|---|---|
| DOC-Q-01 | Exact printer models: A4, receipt, label; connected how (USB/network)? | Pilot clinic | **Not answered, and it is the one that mattered.** Everything renders as deterministic HTML the browser prints, which needs no driver and no installation and works on whatever they have. Nothing has met a printer. `DOC-OPEN-01`. |
| DOC-Q-02 | Full IC on MC — confirm their current practice and any employer/regulator expectation. | Pilot clinic | **Not answered.** Built as DOC-R-08 specifies: full number on a certificate, masked on a referral, full on a prescription only when it carries a controlled drug. One line to change if they say otherwise. `DOC-OPEN-03`. |
| DOC-Q-03 | Continue existing MC/receipt numbering series? | Pilot clinic | **Not answered.** Starts at 000001 per branch, per type, per year. Continuing an existing series is one `UPDATE` before the first issue and has to be deliberate. `DOC-OPEN-04`. |
| DOC-Q-04 | MC wording/format they use today (sample). | Pilot clinic | **Not answered.** The bilingual wording is invented and plausible and has been read by nobody who issues certificates. `DOC-OPEN-02`. |
| DOC-Q-05 | Do doctors want signature images or typed blocks? | Pilot clinic doctors | **Not answered, so both work.** Upload an image and it is embedded; upload nothing and a typed block prints. The document records which it used. `DOC-OPEN-05`. |
| DOC-Q-06 | Any documents beyond this list they issue regularly? | Pilot clinic | **Not answered.** Adding a type is an enum value, a template function and a route — perhaps two hours — so this is worth asking late rather than guessing early. |

## 21. Definition of done

- [ ] **Phase 0 printing spike complete; approach recorded in DOC-F-01/03** — `DOC-OPEN-01`. The spike was specified as blocking and did not happen. Deterministic HTML printed by the browser was chosen provisionally, which is the path DOC-F-03 already specifies for receipts and labels.
- [x] **All Must requirements implemented** — except `RECEIPT`, which needs a payment to exist (`DOC-OPEN-10`), and the consultation-record printout (`DOC-OPEN-11`). Certificates, referrals, letters, lab requests, prescription printouts, invoice printouts and labels all issue.
- [x] **DOC-T-01 … T-08 green** — all eight, inside 20 tests in `test/documents.e2e-spec.ts`, plus 20 unit tests on the templates. T-06 is **not** done: it is the manual printer test and belongs to `DOC-OPEN-01`.
- [ ] **MC, referral, receipt, label printed on the clinic's printers and approved** — `DOC-OPEN-01`, `DOC-OPEN-02`.
- [x] **Integrity job covering documents** — nightly, re-reads every stored file and compares it against the hash taken at issue. Proved by altering a stored file on disk, around the database entirely, and watching the job find it.
- [x] **Open questions answered** — §20, six of six as "asked, not answered, here is what was built in the meantime".

### Traceability

| Requirement | Where it lives | Proved by |
|---|---|---|
| DOC-F-01 rendering approach | `templates.ts`, pure functions to HTML | Provisional. `DOC-OPEN-01` |
| DOC-F-02 letterhead per branch | `letterheadFor`, logo inlined as a data URI | "the branch letterhead and its logo reach the paper" |
| DOC-F-03 print target per type | `TARGET_FOR`, `@page` per template | A4, 80 mm and 50×30 mm templates exist; none has met paper |
| DOC-F-04 stored and reprintable | `storage.put`, `file()` | DOC-T-03 |
| DOC-F-05 medical certificate | `issueMc`, `mc_detail` | DOC-T-02 |
| DOC-F-06 referral | `issueReferral` | DOC-T-07, and the unsigned-consultation refusal |
| DOC-F-07 prescription printout | `issueRxPrint` | Refuses a draft prescription; controlled drugs carry the full IC |
| DOC-F-08 invoice and receipt | `issueInvoicePrint` | Invoice only. Receipt is `DOC-OPEN-10` |
| DOC-F-09 dispensing label | `issueLabel`, `labelPage` | Issues from the dispensed item, with batch and expiry |
| DOC-F-10 queue ticket | **Not built.** In the enum, nothing issues one | — |
| DOC-F-11 letter with a fee | `issueLetter`, `feeFor`, `ChargeRegistry` | DOC-T-02's fee line |
| DOC-F-12 lab request | `issueLabRequest` | Shares the letter template and its own series |
| DOC-F-15 deterministic templates | Pure functions of the payload | 20 unit tests |
| DOC-F-16 doctor signature | `uploadSignature`, `signatureFor` | Both paths: image embedded, typed block otherwise |
| DOC-F-18 print count and reprints | `markPrinted` | "the first print is not a reprint; the second is audited" |
| DOC-F-19 cancel with a reason | `cancel` | DOC-T-05 |
| DOC-R-01 only from a signed record | `signedConsultation` | DOC-T-01 |
| DOC-R-02 immutable once issued | Two triggers | "an issued document cannot be edited or deleted", by direct SQL |
| DOC-R-03 gapless numbering | `nextNumber` under `UPDATE … RETURNING` | DOC-T-04: twenty at once, consecutive |
| DOC-R-04 a cancelled number stays spent | `cancel` leaves `document_no` | DOC-T-05 |
| DOC-R-05 issuer or administrator | `signedConsultation`, `cancel` | "another doctor cannot issue on the signing doctor's name" |
| DOC-R-06 stored files still match | `verifyIntegrity`, `DocumentIntegrityJob` | DOC-T-08 |
| DOC-R-07 render outside the transaction | `@NoRequestTransaction`, `finish()` | The slow-work lint, and `assertOutsideScope` in `storage.put` |
| DOC-R-08 identity on paper | `issueMc`, `issueRxPrint`, `maskIdentity` | "a certificate carries the full identity number, a referral does not" |
| DOC §14 backdating | `issueMc` | Bounded at 7 days, refuses without a reason, records the reason |
| DOC §15 who may read | `mayRead` | DOC-T-07, in the list as well as the detail |

## 22. Notes worth keeping

1. **The order of operations is the whole design.** DOC-R-07 asks for
   render-then-number, and the reason only shows up in the failure case.
   Read the payload in a short transaction; render and write the file
   with nothing open; allocate the number and write the row in a second
   short transaction. If the renderer throws or the disk is full,
   nothing has been written and — the part that matters — no number has
   been consumed, so a retry is safe and the series stays gapless. The
   obvious order, row first, is exactly the dangling-row failure
   `PAT-OPEN-05` records for uploads. These routes opt out of the
   request transaction to get it, which is why they carry
   `@NoRequestTransaction` with the reason written on them.

2. **The watermark is not in the file.** DOC-T-03 wants a reprint to be
   byte-identical to the original, and a COPY stamp baked into the
   stored HTML would make the hash describe the copy rather than the
   document. So `withOverlay` adds it when the document is served. The
   same reasoning applies to the document number, which is not known at
   render time and is stamped into an empty slot on the way out — the
   stored bytes stay equal to what was rendered, and the paper still
   carries a serial number.

3. **The fee is a billable item, not a setting.** A clinic that charges
   for a certificate creates a billable item coded `DOC_MC`; one that
   does not, does not. There is no separate "charge for MCs" switch to
   forget to turn on, because the priced item *is* the switch. The cost
   is discoverability — `DOC-OPEN-17` — and it belongs in the
   administration screen billing still owes.

4. **A signature is sniffed, not trusted.** The uploaded image ends up
   base64'd into a data URI inside a document the clinic prints and a
   patient's employer reads. The browser's `Content-Type` is a claim; an
   SVG is a script host. What counts is the first eight bytes, so PNG
   and JPEG are accepted by magic number and everything else is refused.

5. **Two things called "documents".** `PAT` already owned
   `/patients/:id/documents` — the files brought in and scanned. These
   are the ones the clinic issued: numbered, immutable, reprintable. The
   API keeps them apart (`/issued-documents`) and the patient screen
   shows both in separate cards, because the distinction is real and
   nobody at a front desk will ever think about it. `DOC-OPEN-14`.

6. **The thing that is missing is the thing the spec put first.**
   DOC-F-01 makes the printing spike blocking. It was not done, and
   every paper-shaped decision below it is therefore provisional. The
   code is honest about this — the templates are pure functions with a
   version number, and a PDF renderer slots in behind the same seam
   because what a reprint serves is the stored artefact either way — but
   an afternoon with their printers would settle more than another week
   here would.
