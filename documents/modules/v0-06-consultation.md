# Consultation / EMR (CON)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 2 |
| **Spec sections** | 6, 31 |
| **Depends on** | ENC, PAT, TRI, AUD |
| **Depended on by** | RX, PRC, DOC, BIL, RPT, LAB |
| **Est. effort** | ~45 h |

> Record-integrity rules: `../05-safety-and-compliance.md` §1. This is the screen a doctor lives in for six hours a day; it gets disproportionate design effort.

---

## 1. Purpose & business value

The clinical record of a visit: what the patient said, what the doctor found, what they concluded, what they decided to do. It must be **fast to write** (or doctors go back to paper cards and the product fails), **complete enough to defend** (a signed record is a legal document), and **impossible to silently alter** after signing.

The product bet — one patient record across the whole clinic — is only as good as what doctors put here.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `clinical.read` — view consultations | ✓* | ✓ | ✓ | – |
| `clinical.write` — create/edit own drafts | – | ✓ | – | – |
| `clinical.sign` | – | ✓ (own) | – | – |
| `clinical.amend` | – | ✓ | – | – |
| Reassign a draft to another doctor | ✓ | – | – | – |
| Manage clinical templates (`admin.settings` or DOCTOR own) | ✓ | ✓ (own) | – | – |

\* break-glass, audited.

## 3. Functional requirements

### Structure & content
| ID | Requirement | Priority |
|---|---|---|
| CON-F-01 | One or more consultations per encounter (usually one; a second for a same-day review by another doctor). Each is owned by one doctor. | Must |
| CON-F-02 | Sections: **Chief complaint**, **History of presenting illness**, **Review / relevant history** (past medical, drug, family, social — free text with pulls from patient conditions/allergies), **Examination** (general + systems, free text), **Assessment** (diagnoses), **Plan** (free text + structured orders: prescription, procedures, MC, referral, follow-up). SOAP labels available as an alternative view of the same fields (S = complaint+HPI, O = exam+vitals, A = assessment, P = plan). | Must |
| CON-F-03 | Diagnoses: one primary, any number secondary; free-text description plus optional ICD-10 code from a searchable list (if licensed, CON-Q-01); status `PROVISIONAL` / `CONFIRMED`. | Must |
| CON-F-04 | Vitals from TRI shown inline (read-only card, flags highlighted, link to amend/retake). | Must |
| CON-F-05 | Patient header with allergies (red if severe, amber if not recorded), active conditions, age/sex, weight for paediatrics — always visible, never behind a click or scroll. | Must |
| CON-F-06 | Previous consultations for the patient listed in a side panel (date, doctor, primary diagnosis, one-line plan); click to view full; "copy forward" of history sections into the current draft with a visible marker. | Must |
| CON-F-07 | Clinical templates: per-tenant and per-doctor text templates for common presentations (URTI, gastroenteritis, hypertension review …) that prefill sections; template use recorded on the record. | Must |
| CON-F-08 | Quick phrases / macros (`.nad` → "No abnormality detected") per doctor. | Should |
| CON-F-09 | Attach images/files to the consultation (wound photos, ECG scans) — stored via PAT documents linked to the consultation. | Should |
| CON-F-10 | Orders from the plan: **Prescription** (opens RX panel inline), **Procedure** (PRC picker), **MC** (days, from date, reason category → DOC), **Referral** (to, reason → DOC), **Follow-up** (date, note → ENC), **Lab** (free-text request → DOC in V0). | Must |
| CON-F-11 | Follow-up and review reminders shown on the patient's next visit ("Due for BP review since …"). | Should |

### Drafting, signing, amending
| ID | Requirement | Priority |
|---|---|---|
| CON-F-12 | A consultation is created as `DRAFT` when the doctor starts; autosaved to the server every 5 s while dirty and on blur; the draft survives browser crash, machine change and doctor logout. | Must |
| CON-F-13 | Drafts are visible only to their author (and ADMIN for reassignment). | Must |
| CON-F-14 | **Sign**: requires at least a chief complaint and one diagnosis (tenant-configurable minimum); records `signed_by`, `signed_at`, `signed_ip`; locks the record and its associated triage. Signing is a deliberate action with a confirm step showing a summary. | Must |
| CON-F-15 | After signing, the record is **immutable**. Any change is an **amendment**: new content + mandatory reason + author + time; the original is preserved and both are shown. | Must |
| CON-F-16 | Amendments are typed: `ADDENDUM` (adds information, original unchanged), `CORRECTION` (supersedes a field, original struck through). | Must |
| CON-F-17 | Unsigned drafts older than 24 h are listed on the doctor's home and the admin dashboard; the encounter cannot complete (ENC-F-10). | Must |
| CON-F-18 | Cancel a draft (doctor, reason) — retained as `CANCELLED`, not deleted. | Must |
| CON-F-19 | Printable / PDF view of the signed record with amendment history and clinic letterhead (DOC). | Should |

### Doctor experience
| ID | Requirement | Priority |
|---|---|---|
| CON-F-20 | The whole workspace is operable without a mouse: section jump keys, template picker, RX picker, sign. | Must |
| CON-F-21 | Median time to document a straightforward URTI with a prescription ≤ 90 s for a trained doctor, measured. | Must |
| CON-F-22 | No modal-on-modal; at most one overlay at a time. | Must |
| CON-F-23 | Draft indicator and last-saved time always visible. | Must |

## 4. Key workflows

**Straightforward visit**
1. Doctor: queue → Call next → workspace opens with header, vitals, last visits, empty draft
2. `T` → template "URTI" → sections prefilled → edits in 20 s
3. Assessment: type "urti" → ICD suggestion J06.9 → Enter
4. Plan: `R` → RX panel → 3 items (see RX) → `M` → MC 2 days → `Esc`
5. `Ctrl+Enter` → sign summary → confirm → encounter routes to pharmacy

**Chronic review**
1. Workspace shows "Due for HbA1c review" reminder and last 5 BP readings trend
2. Copy-forward of last plan → edit → sign

**Post-sign correction**
1. Doctor realises dose was wrong after signing (RX item already dispensed? → see RX/DSP rules)
2. Open record → "Amend" → type CORRECTION → field → new value → reason "Transcription error" → save
3. Record shows original struck through with amendment note; audit entry; DOC regenerates any printed doc with amendment marker

**Draft recovery**
1. Doctor's PC dies mid-consult → logs in at another PC → home shows "1 draft in progress" → opens → all content up to last autosave

## 5. Data model

```
consultation
  id                  uuid pk
  tenant_id           uuid not null
  encounter_id        uuid not null → encounter
  patient_id          uuid not null → patient
  branch_id           uuid not null
  doctor_id           uuid not null → user
  sequence            int not null default 1
  status              enum(DRAFT, SIGNED, CANCELLED) not null
  chief_complaint     text
  hpi                 text
  history             text
  examination         text
  plan_text           text
  template_id         uuid → clinical_template
  copied_from_id      uuid → consultation         -- copy-forward source
  follow_up_due       date, follow_up_note text
  started_at          timestamptz not null
  last_autosave_at    timestamptz
  signed_at           timestamptz, signed_by uuid, signed_ip inet
  cancelled_at        timestamptz, cancel_reason text
  content_hash        text                        -- sha256 of signed content, for integrity checks
  INDEX (encounter_id)
  INDEX (patient_id, signed_at desc)
  INDEX (doctor_id, status)                       -- unsigned drafts
  INDEX (tenant_id, status, started_at)           -- stale drafts

diagnosis
  id uuid pk, tenant_id, consultation_id → consultation, patient_id
  rank        enum(PRIMARY, SECONDARY) not null
  description text not null
  icd10_code  text, icd10_label text
  certainty   enum(PROVISIONAL, CONFIRMED) not null default 'PROVISIONAL'
  is_chronic  bool not null default false        -- offers to add to patient_condition
  INDEX (consultation_id)
  INDEX (tenant_id, icd10_code)                   -- reporting

consultation_amendment
  id uuid pk, tenant_id, consultation_id
  type        enum(ADDENDUM, CORRECTION) not null
  field       text                                -- for CORRECTION; null for ADDENDUM
  previous    jsonb, current jsonb not null
  reason      text not null
  amended_by  uuid not null, amended_at timestamptz not null, amended_ip inet
  INDEX (consultation_id, amended_at)

consultation_attachment
  id uuid pk, tenant_id, consultation_id, patient_document_id → patient_document, caption text

clinical_template
  id uuid pk, tenant_id
  scope       enum(TENANT, USER) not null, owner_id uuid
  name text not null, keywords text[]
  content     jsonb not null      -- { chief_complaint, hpi, history, examination, plan_text, diagnoses:[...], rx_items:[...] }
  active bool not null default true
  INDEX (tenant_id, scope, owner_id)

quick_phrase
  id uuid pk, tenant_id, user_id, trigger text, expansion text, UNIQUE (user_id, trigger)

icd10_code   -- reference table, tenant-agnostic, loaded if licensed
  code text pk, label text, chapter text, searchable tsvector
```

## 6. State machines

```
DRAFT ──sign──► SIGNED ──amend──► SIGNED (+ amendment rows)
  │
  └──cancel──► CANCELLED
```
No path out of SIGNED or CANCELLED.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| CON-R-01 | Once `status = SIGNED`, no column of `consultation` or its `diagnosis` rows may change except via amendment rows. | Service refuses; **DB trigger** `BEFORE UPDATE` raises if `OLD.status='SIGNED'` and any clinical column differs; `diagnosis` trigger checks parent status |
| CON-R-02 | `content_hash` computed at sign over canonical JSON of clinical fields + diagnoses; a nightly job re-verifies and alerts on mismatch. | Service + job |
| CON-R-03 | Only the owning doctor may sign; ADMIN can reassign a draft but never sign. | Service |
| CON-R-04 | Amendment `reason` ≥ 10 characters. | Validation |
| CON-R-05 | Every read of a consultation is audited `clinical.viewed`. | Controller |
| CON-R-06 | A draft belongs to one encounter; the encounter must be `IN_CONSULTATION` to create/edit (ADMIN reassignment excepted). | Service |
| CON-R-07 | Signing emits `consultation.signed` with the set of orders; ENC routes the encounter; CON never writes encounter status. | Event |
| CON-R-08 | Copy-forward content is marked in the record (`copied_from_id`) and visually on screen so a stale history is not mistaken for today's. | Service + UI |
| CON-R-09 | Template use never auto-signs; a doctor must review. | UI |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/encounters/:id/consultations` | `clinical.write` | Creates DRAFT; 409 if the doctor already has a draft here |
| GET | `/consultations/:id` | `clinical.read` | Audited |
| PATCH | `/consultations/:id` | `clinical.write` (owner) | Autosave; partial; 409 if not DRAFT |
| PUT | `/consultations/:id/diagnoses` | `clinical.write` | Replace set (DRAFT only) |
| POST | `/consultations/:id/sign` | `clinical.sign` (owner) | Validates minimums; returns routing outcome |
| POST | `/consultations/:id/cancel` | `clinical.write` (owner) | Reason |
| POST | `/consultations/:id/amend` | `clinical.amend` | `{ type, field?, current, reason }` |
| POST | `/consultations/:id/reassign` | ADMIN + reauth | DRAFT only |
| GET | `/consultations/:id/print` | `clinical.read` | PDF via DOC |
| GET | `/patients/:id/consultations` | `clinical.read` | Summaries |
| GET | `/consultations/:id/orders` | `clinical.read` | Linked RX/PRC/DOC/follow-up |
| GET | `/me/drafts` | `clinical.write` | Unsigned drafts |
| CRUD | `/clinical-templates` | DOCTOR (own) / `admin.settings` (tenant) | |
| CRUD | `/me/quick-phrases` | DOCTOR | |
| GET | `/icd10/search?q=` | `clinical.write` | If loaded |

## 9. Domain events

**Emits:** `consultation.created`, `consultation.signed` `{ encounterId, hasRx, hasProcedures, mcIssued, referralIssued, followUpDue }`, `consultation.amended`, `consultation.cancelled`, `diagnosis.recorded`
**Consumes:** `triage.recorded` (refresh vitals card), `encounter.status_changed` (workspace state)

## 10. Audit events

All §9 with before/after; `clinical.viewed` on every read; `consultation.reassigned`; `template.used` (light).

## 11. Screens & UX requirements

| Area | Requirements |
|---|---|
| Layout | Three columns on ≥ 1366 px: left = patient context (header, vitals card, allergies, conditions, previous visits); centre = the note (sections stacked, always all visible, no tabs); right = orders panel (RX items, procedures, MC, referral, follow-up). On smaller screens the right panel becomes a drawer. |
| Keyboard | `Alt+1..6` jump to sections; `T` templates; `R` prescription; `P` procedure; `M` MC; `F` follow-up; `Ctrl+Enter` sign; `Esc` closes any overlay |
| Diagnosis input | Type-ahead over ICD (if loaded) and the doctor's recent diagnoses; free-text always accepted |
| Sign dialog | Summary: diagnoses, RX items with allergy status, procedures, documents to issue; "Sign & route" |
| Signed view | Read-only, amendments inline with strike-through/addendum styling, "Amend" button, print |
| Drafts list | On doctor home: patient, started, last saved, open |
| Templates manager | Name, keywords, section content, embedded RX items; preview |

## 12. Validation

- Sign minimum: chief complaint non-empty; ≥ 1 diagnosis; RX items (if any) valid per RX
- Section text ≤ 20 000 chars each
- Diagnosis description 2–200 chars; ICD code must exist in reference table if provided
- Amendment reason ≥ 10 chars
- Follow-up date ≥ today

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| CON-N-01 | Workspace initial load ≤ 800 ms including previous-visit summaries (single aggregated query). |
| CON-N-02 | Autosave PATCH ≤ 100 ms server time; client debounced; conflict-free (last-write-wins on a single-owner draft). |
| CON-N-03 | Documenting a standard case ≤ 90 s median (CON-F-21) — measured during R2 shadowing with a stopwatch. |
| CON-N-04 | Integrity job verifies 100% of signed records nightly within the maintenance window. |
| CON-N-05 | Immutability trigger tested by direct SQL in CI (not just via the API). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Doctor forgets to sign, goes home | Draft listed on home + admin dashboard; encounter stuck at `IN_CONSULTATION`; FRONTDESK can move the patient on to pharmacy/payment with an ADMIN force-transition (audited) if the RX was already saved; the draft is signed next morning with `signed_at` reflecting reality. |
| Locum doctor leaves with unsigned drafts | ADMIN reassigns to another doctor who reviews and signs, or cancels with reason. The reassignment is audited and the record shows both doctors. |
| Two doctors on the same patient same day | Second consultation with `sequence = 2`; both visible. |
| Wrong patient chart opened | Cancel draft with reason "wrong patient"; nothing signed. |
| Dose error found after dispensing | Amendment on CON and RX; DSP has its own return/re-dispense flow; the amendment reason references the dispense. |
| ICD list not licensed | Free-text diagnoses; `icd10_code` null; reporting groups by description text; V1 adds mapping. |
| Autosave fails (network) | Client keeps a local copy and shows "unsaved" prominently; retries; on reconnect syncs. Local copy is cleared after successful sync (it is not a permanent offline mode). |
| Doctor tries to edit a signed record via API | 409 with "use amend". |
| Direct DB update on signed record | Trigger raises. |
| Template contains RX for a drug the patient is allergic to | RX allergy check runs on template application; items are added with the warning visible, not silently. |

## 15. Compliance

- Signed record immutability + amendment trail = the core of medical-record integrity (`../05` §1).
- View auditing supports "who accessed" queries.
- Records retained for the clinical retention period; never deleted with the patient (soft delete keeps links).
- Signature is an authenticated user action with IP and time; a qualified electronic signature is not required for internal records, but the sign step is designed to be defensible as the doctor's deliberate act.

## 16. Reporting outputs

- Consultations per doctor per day; median documentation time (from `started_at`→`signed_at`) (RPT)
- Top diagnoses by ICD / description (RPT)
- Unsigned drafts > 24 h (admin dashboard)
- Amendment rate per doctor (clinical governance, ANL)
- Follow-ups due (RPT; NTF in V1)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| CON-T-01 | Given a DRAFT, when PATCHed every 5 s for a minute, then all changes persist and `last_autosave_at` advances. |
| CON-T-02 | Given a DRAFT with no diagnosis, when signed, then 422 naming the missing minimum. |
| CON-T-03 | Given a signed record, when PATCHed, then 409; when `UPDATE consultation SET hpi=…` is run directly in SQL, then the trigger raises. |
| CON-T-04 | Given a signed record, when amended (CORRECTION, field hpi), then an amendment row holds previous and current, the consultation row is unchanged, and the read view shows both. |
| CON-T-05 | Given a signed record, when a byte of a clinical column is changed via a privileged role, then the nightly integrity job reports a hash mismatch. |
| CON-T-06 | Given DOCTOR A's draft, when DOCTOR B reads it, then 404; when ADMIN reads it, then 200 with `audit.break_glass`. |
| CON-T-07 | Given a template with 2 RX items, when applied to a patient allergic to one, then the item is added with an allergy warning attached and `rx.warning_raised` is emitted. |
| CON-T-08 | Given a signed consultation with an RX, then `consultation.signed` carries `hasRx = true` and ENC moves the encounter to `PHARMACY_WAITING` (or `PAYMENT_WAITING` per setting). |
| CON-T-09 | Given a stale draft (25 h), then it appears on the admin dashboard and the encounter cannot complete. |
| CON-T-10 | Given the R2 shadowing session, then median documentation time for a standard case is ≤ 90 s. |

## 18. Migration & rollout

- R2: doctors document in the system; paper cards retained read-only for history until the clinic decides
- Build the clinic's top-20 templates **with** the doctor before R2, not after
- Load ICD-10 if licensing is resolved (CON-Q-01), otherwise free-text at launch
- Shadow one full session per doctor; time it; fix the slowest interaction before R3
- Legacy clinical notes are **not** migrated as consultations; scanned cards can be attached as patient documents

## 19. Out of scope

- Drug–drug interaction alerts → V2 (licensed DB)
- Structured examination forms, body diagrams → V2
- Structured lab results and trending → V2 `LAB`
- Clinical decision support, risk scores → V3
- Voice dictation / AI summarisation → V3
- Problem-oriented record across visits (problem list beyond conditions) → V2

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| CON-Q-01 | Is a usable ICD-10 (or ICD-10-CM) list available under acceptable licensing? MOH Malaysia uses ICD-10; check terms. | You |
| CON-Q-02 | Top 20 presentations for templates; does the doctor already have written templates? | Pilot clinic doctor |
| CON-Q-03 | Minimum content to sign — is "one diagnosis" acceptable, or do they want exam mandatory? | Pilot clinic doctor |
| CON-Q-04 | Screen size at the doctor's desk (drives the layout breakpoint). | Pilot clinic |
| CON-Q-05 | Do they want SOAP labels or the sectioned layout as default? | Pilot clinic doctor |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] CON-T-01 … T-10 green (T-03 includes the direct-SQL trigger test)
- [ ] Integrity job running nightly with alerting
- [ ] Top-20 templates loaded for the pilot
- [ ] Documentation time measured and recorded here
- [ ] Keyboard map documented in-app (`?` overlay)
- [ ] Open questions answered
