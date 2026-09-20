# Patient Registry (PAT)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 1 |
| **Spec sections** | 1 |
| **Depends on** | IAM, TEN, AUD |
| **Depended on by** | ENC, TRI, CON, RX, BIL, DOC, MEM, PNL, APT, PPT |
| **Est. effort** | ~35 h |

---

## 1. Purpose & business value

One patient, one record, across every branch of the tenant — the promise the whole product rests on. This module is the master data for that record: identity, contact, and the two clinical facts that must be right before a doctor prescribes anything (allergies, chronic conditions).

It is also the most-used screen in the clinic. A receptionist will search for a patient several hundred times a day. If that search is slow or fussy, the clinic will feel it in the waiting room within an hour of go-live. The search path gets engineering attention out of proportion to its apparent simplicity.

## 2. Actors & permissions

| Actor | Uses PAT to |
|---|---|
| FRONTDESK | Register, search, edit demographics and contacts, attach documents |
| NURSE | Search, view, record allergies and conditions |
| DOCTOR | Search, view full record, record/verify allergies and conditions |
| ADMIN | All of the above; merge duplicates; export a patient's data |

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `patient.read` (demographics, visits) | ✓ | ✓ | ✓ | ✓ |
| `patient.write` (demographics, contacts, documents) | ✓ | ✓ | ✓ | ✓ |
| Record allergy / condition | ✓ | ✓ | ✓ | – |
| **Verify** allergy (clinical confirmation) | – | ✓ | – | – |
| `patient.unmask_id` | ✓ | ✓ | – | ✓ |
| `patient.merge` | ✓ | – | – | – |
| `patient.export` | ✓ | – | – | – |
| View clinical tab (`clinical.read`) | ✓* | ✓ | ✓ | – |

\* break-glass, audited.

## 3. Functional requirements

### Registration & identity
| ID | Requirement | Priority |
|---|---|---|
| PAT-F-01 | Register a patient with: full name, ID type (`MYKAD`, `MYKID`, `PASSPORT`, `ARMY`, `POLICE`, `OTHER`, `NONE`), ID number, date of birth, gender, nationality, phone. Everything else optional. | Must |
| PAT-F-02 | For `MYKAD`/`MYKID`, derive date of birth and gender from the IC (`YYMMDD-PB-###G`) and prefill; the user can override with a warning. Validate the checksum of the date portion (valid calendar date). | Must |
| PAT-F-03 | Generate a human-readable MRN per tenant: `<PREFIX>-<zero-padded sequence>` (e.g. `GC-000123`), configurable prefix, gapless not required. Immutable. | Must |
| PAT-F-04 | Duplicate detection at registration: exact match on `(id_type, id_number)` blocks with a link to the existing record; fuzzy match on name + DOB or phone shows a "possible duplicates" panel before save. | Must |
| PAT-F-05 | `NONE` id type allowed (infants, undocumented) with a mandatory note; flagged for later completion. | Must |
| PAT-F-06 | Photo capture (webcam/upload) for the record. | Could |

### Demographics & contact
| ID | Requirement | Priority |
|---|---|---|
| PAT-F-07 | Address (Malaysian format: line 1/2, postcode, city, state), email, preferred language (`MS`, `EN`, `ZH`, `TA`, other), occupation, marital status, race/ethnicity (optional, for clinical use only). | Must |
| PAT-F-08 | Emergency contact: name, relationship, phone. Multiple allowed; one primary. | Must |
| PAT-F-09 | Communication preferences and consents: SMS/WhatsApp/email reminders (each opt-in), marketing (opt-in, default off). Stored with timestamp and who recorded it. | Must |
| PAT-F-10 | Patient notes: free-text, non-clinical (e.g. "prefers Mandarin", "hard of hearing"), visible on the header banner. | Must |

### Clinical master data
| ID | Requirement | Priority |
|---|---|---|
| PAT-F-11 | Allergies: substance (free text or linked catalogue product / drug class), reaction, severity (`MILD`, `MODERATE`, `SEVERE`, `LIFE_THREATENING`), type (`DRUG`, `FOOD`, `ENVIRONMENT`, `OTHER`), status (`UNVERIFIED`, `VERIFIED`, `REFUTED`), recorded by, verified by, notes. | Must |
| PAT-F-12 | "No known drug allergies" (NKDA) is an explicit recorded state, distinct from "not asked". The header shows one of: NKDA / n allergies / **Not recorded** (amber). | Must |
| PAT-F-13 | Chronic conditions: condition (free text, optional ICD-10), onset date, status (`ACTIVE`, `RESOLVED`), notes. | Must |
| PAT-F-14 | Allergies and conditions are visible on every clinical screen header (TRI, CON, RX, DSP) without a click. | Must |
| PAT-F-15 | Removing an allergy is a soft action (`REFUTED` with reason), never a delete; history is retained. | Must |

### Search
| ID | Requirement | Priority |
|---|---|---|
| PAT-F-16 | Single search box accepting: MRN, IC/passport (full or last 4+), phone (any format), name (partial, any word order). Results ranked: exact ID/MRN match first, then phone, then name. | Must |
| PAT-F-17 | Search returns in ≤ 300 ms p95 at 100 000 patients, showing name, masked ID, age/gender, phone, last visit, allergy badge. | Must |
| PAT-F-18 | Keyboard-only flow: type → arrow → Enter opens the record; Enter on a single exact match opens it directly. | Must |
| PAT-F-19 | Recent patients (last 20 opened by this user at this branch) shown when the box is empty. | Should |
| PAT-F-20 | Name search is diacritic- and case-insensitive and tolerates common Malay/Chinese/Tamil name orderings ("bin", "binti", "a/l", "a/p" ignored for matching). | Should |

### Record
| ID | Requirement | Priority |
|---|---|---|
| PAT-F-21 | Patient record page with tabs: Summary, Visits, Clinical (allergies, conditions, consultations — gated by `clinical.read`), Documents, Billing (V0: invoices), Access history (ADMIN). | Must |
| PAT-F-22 | Visit history lists encounters with date, branch, doctor, diagnosis summary, invoice total, status; links to each. | Must |
| PAT-F-23 | Document attachments: upload (PDF, JPG, PNG ≤ 20 MB), typed (`ID_COPY`, `REFERRAL_IN`, `LAB_RESULT`, `CONSENT`, `OTHER`), stored in object storage, virus-scanned in V1. | Must |
| PAT-F-24 | ID number masked by default (`•••••-••-1234`); unmask button reveals for 30 s and is audited. Full ID printed only on documents that require it. | Must |
| PAT-F-25 | Soft delete with reason (ADMIN); deleted patients are excluded from search but remain linked to historical encounters and invoices. | Must |
| PAT-F-26 | Merge duplicates (ADMIN): choose survivor, all encounters/invoices/documents/allergies re-pointed, loser marked `MERGED_INTO`, fully audited, reversible within 30 days. | Should (needed early — see §18) |
| PAT-F-27 | Per-patient data export (JSON + PDF summary) for PDPA access requests. | Should |
| PAT-F-28 | Bulk import from CSV with dry-run, validation report, duplicate handling policy, and reconciliation output. | Must (for the pilot migration) |

## 4. Key workflows

**Walk-in, existing patient (the 200-times-a-day path)**
1. Receptionist types last 4 of IC or phone → result appears → Enter
2. Record header shows name, age, allergies, notes, last visit
3. "Check in" button → ENC creates encounter (one click, no form)

**Walk-in, new patient**
1. Search finds nothing → "Register new" (prefilled with the search text if it looks like an IC or phone)
2. Scan/type IC → DOB, gender prefilled → name, phone → possible duplicates panel → Save
3. Optional: allergies now (FRONTDESK can record `UNVERIFIED`; nurse/doctor verifies at triage/consult)
4. Check in

**Allergy recorded at consultation**
1. Doctor adds allergy from the consultation header → `VERIFIED` immediately (doctor-recorded)
2. `patient.allergy_added` → RX re-checks any open prescription items for conflicts

**Data migration (once)**
1. Export from old system → mapping script → dry-run → validation report to clinic
2. Clinic cleans obvious issues → import → reconciliation report (counts, duplicates merged, rows rejected with reasons)
3. Allergies from free text imported as `UNVERIFIED` with source note

## 5. Data model

```
patient
  id                uuid pk
  tenant_id         uuid not null
  mrn               text not null
  name              text not null
  name_normalised   text not null            -- lowercased, diacritics stripped, particles removed; for search
  id_type           enum(MYKAD, MYKID, PASSPORT, ARMY, POLICE, OTHER, NONE) not null
  id_number         text                     -- stored plain; masked on read except with permission
  id_number_last4   text                     -- for search without unmasking
  passport_country  char(2)
  passport_expiry   date
  date_of_birth     date
  dob_estimated     bool not null default false
  gender            enum(MALE, FEMALE, OTHER, UNKNOWN) not null
  nationality       char(2) not null default 'MY'
  race              text
  religion          text
  marital_status    enum(SINGLE, MARRIED, DIVORCED, WIDOWED, UNKNOWN)
  occupation        text
  preferred_language text
  phone             text                     -- E.164
  phone_alt         text
  email             citext
  address_line1 text, address_line2 text, postcode text, city text, state text, country char(2)
  blood_group       enum(A+,A-,B+,B-,AB+,AB-,O+,O-,UNKNOWN)
  nkda_recorded     bool                     -- null = not asked; true = NKDA; false = has allergies
  nkda_recorded_by  uuid, nkda_recorded_at timestamptz
  notes             text
  photo_key         text
  status            enum(ACTIVE, DECEASED, MERGED, DELETED) not null default 'ACTIVE'
  merged_into_id    uuid → patient
  deceased_at       date
  deleted_at        timestamptz, deleted_reason text
  source            text                     -- 'MANUAL' | 'IMPORT:<batch>'
  UNIQUE (tenant_id, mrn)
  UNIQUE (tenant_id, id_type, id_number) WHERE id_type <> 'NONE' AND status IN ('ACTIVE','DECEASED')
  INDEX (tenant_id, phone)
  INDEX (tenant_id, id_number_last4)
  INDEX gin (tenant_id, name_normalised gin_trgm_ops)   -- pg_trgm
  INDEX (tenant_id, status)

patient_contact
  id uuid pk, tenant_id uuid not null, patient_id uuid not null → patient
  name text not null, relationship text, phone text not null, is_primary bool not null default false
  INDEX (patient_id)

patient_consent
  id uuid pk, tenant_id, patient_id
  channel  enum(SMS, WHATSAPP, EMAIL)
  purpose  enum(REMINDERS, MARKETING)
  granted  bool not null
  recorded_by uuid, recorded_at timestamptz not null, source text
  UNIQUE (patient_id, channel, purpose)   -- latest wins; history in audit

patient_allergy
  id uuid pk, tenant_id, patient_id
  type        enum(DRUG, FOOD, ENVIRONMENT, OTHER) not null
  substance   text not null
  product_id  uuid → product            -- optional link to catalogue
  drug_class  text                      -- for class-level matching (RX)
  reaction    text
  severity    enum(MILD, MODERATE, SEVERE, LIFE_THREATENING)
  status      enum(UNVERIFIED, VERIFIED, REFUTED) not null
  recorded_by uuid not null, recorded_at timestamptz not null
  verified_by uuid, verified_at timestamptz
  refuted_by uuid, refuted_at timestamptz, refuted_reason text
  notes text
  INDEX (patient_id, status)

patient_condition
  id uuid pk, tenant_id, patient_id
  condition   text not null
  icd10_code  text
  onset_date  date
  status      enum(ACTIVE, RESOLVED) not null default 'ACTIVE'
  recorded_by uuid not null, recorded_at timestamptz not null
  resolved_at date, notes text
  INDEX (patient_id, status)

patient_document
  id uuid pk, tenant_id, patient_id
  type        enum(ID_COPY, REFERRAL_IN, LAB_RESULT, CONSENT, PHOTO, OTHER) not null
  filename    text not null, mime text not null, size_bytes int not null
  storage_key text not null
  uploaded_by uuid not null, uploaded_at timestamptz not null
  scanned_at  timestamptz, scan_result text     -- V1 AV
  deleted_at  timestamptz
  INDEX (patient_id, type)

patient_import_batch
  id uuid pk, tenant_id, filename text, row_count int, imported int, skipped int, merged int
  report_key text, run_by uuid, run_at timestamptz, dry_run bool

mrn_sequence   -- per-tenant sequence, e.g. table (tenant_id pk, next int) updated with FOR UPDATE
```

## 6. State machines

**Patient status**
```
ACTIVE ──► DECEASED
  │
  ├──► MERGED (merged_into_id set; excluded from search; reversible 30 d)
  └──► DELETED (soft; admin, reason; excluded from search; links preserved)
```

**Allergy status**: `UNVERIFIED` → `VERIFIED` | `REFUTED`; `VERIFIED` → `REFUTED` (with reason).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PAT-R-01 | One active patient per `(tenant, id_type, id_number)` where id_type ≠ NONE. | Partial unique index |
| PAT-R-02 | MRN is immutable and never reused, including after merge/delete. | Service; no update path |
| PAT-R-03 | Allergies are never hard-deleted; removal = `REFUTED` with reason. | Service; no DELETE grant on `patient_allergy` |
| PAT-R-04 | Imported allergies are always `UNVERIFIED` until a clinician verifies. | Import script |
| PAT-R-05 | ID number is returned masked unless the caller holds `patient.unmask_id` and explicitly requests unmask; every unmask is audited. | Controller + DTO serialiser |
| PAT-R-06 | Merge re-points every FK to the survivor inside one transaction and records a reversible manifest. | Merge service |
| PAT-R-07 | A patient with `nkda_recorded IS NULL` shows an amber "allergies not recorded" state on all clinical screens; RX shows a blocking-style warning (overridable) when prescribing to such a patient. | UI + RX |
| PAT-R-08 | Patient is tenant-scoped; no `branch_id`. Visits carry the branch. | Schema |
| PAT-R-09 | `name_normalised` is maintained by a trigger, never by the application. | DB trigger |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/patients/search?q=` | `patient.read` | Ranked, ≤ 20 results, ≤ 300 ms |
| GET | `/patients/recent` | `patient.read` | Per user+branch |
| POST | `/patients` | `patient.write` | Returns duplicate candidates with 409 unless `?force=true` after review |
| POST | `/patients/check-duplicates` | `patient.write` | Pre-save check |
| GET | `/patients/:id` | `patient.read` | Masked ID |
| GET | `/patients/:id?unmask=true` | `patient.unmask_id` | Audited |
| PATCH | `/patients/:id` | `patient.write` | Demographics; ID change requires reason |
| GET | `/patients/:id/visits` | `patient.read` | |
| GET | `/patients/:id/clinical-summary` | `clinical.read` | Allergies, conditions, last 5 diagnoses; audited as `clinical.viewed` |
| POST/PATCH | `/patients/:id/contacts[/:cid]` | `patient.write` | |
| PUT | `/patients/:id/consents` | `patient.write` | |
| POST | `/patients/:id/allergies` | `triage.write` or `clinical.write` | Doctor → VERIFIED; others → UNVERIFIED |
| POST | `/patients/:id/allergies/:aid/verify` | `clinical.write` | |
| POST | `/patients/:id/allergies/:aid/refute` | `clinical.write` | Reason required |
| PUT | `/patients/:id/nkda` | `triage.write` or `clinical.write` | |
| POST/PATCH | `/patients/:id/conditions[/:cid]` | `triage.write` or `clinical.write` | |
| POST | `/patients/:id/documents` | `patient.write` | Multipart |
| GET | `/patients/:id/documents/:did` | `patient.read` | Signed URL, 5 min |
| DELETE | `/patients/:id/documents/:did` | `patient.write` | Soft |
| POST | `/patients/:id/merge` | `patient.merge` + reauth | Body: `{ loserId }` |
| POST | `/patients/:id/unmerge` | `patient.merge` + reauth | Within 30 d |
| POST | `/patients/:id/delete` | `patient.merge` + reauth | Soft, reason |
| POST | `/patients/:id/export` | `patient.export` + reauth | Async; audited |
| POST | `/patients/import` | `admin.settings` | CSV, `?dryRun=true` |
| GET | `/patients/import/:batchId` | `admin.settings` | Report |

## 9. Domain events

**Emits:** `patient.registered`, `patient.updated`, `patient.merged`, `patient.deleted`, `patient.allergy_added`, `patient.allergy_verified`, `patient.allergy_refuted`, `patient.condition_changed`, `patient.consent_changed`, `patient.imported`
**Consumes:** `encounter.completed` (updates denormalised `last_visit_at` for search display)

## 10. Audit events

All of §9 with before/after; plus `patient.id_unmasked`, `patient.exported`, `clinical.viewed` (on clinical-summary and clinical tab), `patient.document_viewed` (signed URL issuance).

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Search (reception home) | One box, autofocus on load and on `/` key; results as you type (debounced 150 ms); each row: name, masked ID, age/sex, phone, last visit, allergy badge (red if any severe, amber if not recorded); Enter opens; `N` opens register with query prefilled |
| Register | Single scrollable form; IC field first with auto-derive; duplicates panel slides in before save; Save + Check-in as one action |
| Patient header (shared component) | Name, MRN, age/sex, masked ID with unmask, phone, **allergies chip**, conditions chip, notes icon; sticky on every patient-context screen |
| Record → Summary | Demographics, contacts, consents, notes; inline edit |
| Record → Visits | Table, newest first, click to open encounter |
| Record → Clinical | Allergies (with verify/refute), conditions, consultation list — only rendered with `clinical.read` |
| Record → Documents | Grid with type filter, upload drop-zone, preview |
| Merge | Side-by-side comparison, pick survivor, field-level choose-where-different, confirm with reauth |
| Import | Upload → dry-run report (errors per row, duplicate policy) → run → reconciliation |

## 12. Validation

- Name: 2–150 chars; trimmed; internal double spaces collapsed
- MyKad: `^\d{6}-?\d{2}-?\d{4}$`, date portion valid, stored without hyphens, displayed with
- Passport: 5–20 alphanumerics + country
- Phone: normalised to E.164; MY numbers from `01x…` / `+601x…`; landline allowed
- DOB: not in future; not > 120 years ago; required unless id_type NONE (then `dob_estimated` allowed)
- Postcode: 5 digits for MY
- Email: optional, valid, lowercase
- Allergy substance: 2–120 chars; severity required for DRUG type
- Document: mime allow-list, ≤ 20 MB, filename sanitised

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| PAT-N-01 | Search p95 ≤ 300 ms at 100 k patients; p99 ≤ 600 ms. Load-tested before R1. |
| PAT-N-02 | Register-to-check-in ≤ 60 s for a trained receptionist with IC in hand. |
| PAT-N-03 | Header component renders allergies from the same query as the patient, never a second round-trip. |
| PAT-N-04 | Documents stored with server-side encryption; signed URLs expire in 5 min. |
| PAT-N-05 | Import of 50 000 rows completes in < 10 min with progress. |
| PAT-N-06 | ID numbers never appear in URLs, logs, error reports or analytics. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Patient has MyKad and later a different IC (e.g. MyKid → MyKad at 12) | ID change with reason, old ID retained in `patient_identifier_history` (audit before/after suffices in V0; V1 adds an identifiers table). Search matches old ID via audit-backed lookup in V1. |
| Two patients genuinely share a passport number (different countries) | Uniqueness includes `passport_country` for PASSPORT type. |
| Newborn without ID | `MYKID`/`NONE`, DOB required, flagged for completion; duplicate check on name+DOB+mother's phone. |
| Foreign worker with expired passport | Allowed; `passport_expiry` shown amber. |
| Deceased patient | Status `DECEASED`; excluded from queue check-in; record readable. |
| Name search "Ahmad" returns 400 results | Cap at 20 with "refine your search"; ranking by recency of last visit. |
| Same phone for a whole family | Expected. Phone search returns all; not a duplicate signal alone. |
| Merge chosen wrongly | Unmerge within 30 days from manifest; after that, ADMIN contacts support. |
| Import CSV has 30% duplicates | Dry-run report lists them with the proposed action (skip / merge into existing / create). Clinic decides policy per batch. |
| Allergy recorded against brand name | Store as given; RX matches on `drug_class` and `product.generic_name` when linked; unlinked free-text allergies produce a "check manually" warning on every prescription. |
| FRONTDESK opens Clinical tab | Tab not rendered; API returns 403; nothing is audited as viewed. |

## 15. Compliance

- Patient record = sensitive personal data (PDPA). Masking, access gating, view auditing, export, retention (`../05-safety-and-compliance.md` §3).
- Consents recorded with timestamp and recorder; marketing default off.
- Race/religion optional and used only where clinically relevant; never on printed documents unless required.
- Photo is personal data; same controls.

## 16. Reporting outputs

- New patients per day/week/month; new vs returning (RPT)
- Patients with allergies not recorded (clinical quality, RPT)
- Duplicate candidates count (admin dashboard)
- Consent coverage for reminders (NTF readiness, V1)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| PAT-T-01 | Given a MyKad `900101-14-5678`, when registering, then DOB `1990-01-01` and gender `FEMALE` are prefilled. |
| PAT-T-02 | Given an existing patient with that IC, when registering again, then 409 with the existing record linked. |
| PAT-T-03 | Given 100 000 seeded patients, when searching by last 4 of IC, then results ≤ 300 ms p95 and the exact match ranks first. |
| PAT-T-04 | Given search "ali bin ahmad", when patient "Ahmad Ali" exists, then it is returned. |
| PAT-T-05 | Given FRONTDESK, when reading a patient, then `id_number` is masked; when requesting unmask, then full value returned and `patient.id_unmasked` audited. |
| PAT-T-06 | Given NURSE records an allergy, then status `UNVERIFIED`; given DOCTOR records one, then `VERIFIED`. |
| PAT-T-07 | Given an allergy is refuted, then it is not deleted and appears in history with reason. |
| PAT-T-08 | Given patient A merged into B, then all of A's encounters, invoices, documents, allergies reference B; A has status MERGED; unmerge within 30 d restores exactly. |
| PAT-T-09 | Given a CSV with 3 invalid rows and 2 duplicates, when dry-run, then the report lists all 5 with reasons and nothing is written. |
| PAT-T-10 | Given a patient with `nkda_recorded = null`, then the header shows "Allergies not recorded" in amber on TRI, CON, RX, DSP. |
| PAT-T-11 | Given FRONTDESK, when calling `/patients/:id/clinical-summary`, then 403 and no `clinical.viewed` entry. |
| PAT-T-12 | Given a DELETED patient, when searched, then not returned; when their historical invoice is opened, then patient name still shows. |

## 18. Migration & rollout

- **Phase 0**: obtain a real export sample from the pilot's current system before finalising the schema
- **Phase 1**: build import script with dry-run; run dry-run with the clinic; agree duplicate policy; import; reconciliation report signed off by the clinic
- Allergies from free text → `UNVERIFIED` with `notes = 'Imported from legacy notes: "…"'`; nurse/doctor verifies at the patient's next visit (prompted by the amber state)
- Expect a merge tool to be needed within the first month — schedule PAT-F-26 into Phase 1 if the dry-run shows > 2% duplicates

## 19. Out of scope

- Family relationships / household accounts → V1 (with MEM family plans)
- Corporate / panel association → V1 `PNL`
- Membership status on record → V1 `MEM`
- Patient self-registration / portal → V2 `PPT`
- Identifier history table → V1
- Antivirus scanning of uploads → V1
- Photo ID verification → not planned

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| PAT-Q-01 | Current system and export format? Get a sample now. | Pilot clinic |
| PAT-Q-02 | How many patient records; how far back does history need to come across? | Pilot clinic |
| PAT-Q-03 | How are allergies recorded today? | Pilot clinic |
| PAT-Q-04 | Does the clinic collect race/religion, and do they need it on any document? | Pilot clinic |
| PAT-Q-05 | MRN prefix preference, and should the sequence continue from their existing numbering? | Pilot clinic |
| PAT-Q-06 | Do they scan IC copies today (document attachment volume)? | Pilot clinic |
| PAT-Q-07 | Is an IC card reader (MyKad reader) in use or wanted? Would remove typing errors. | Pilot clinic / you |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] PAT-T-01 … T-12 green
- [ ] Search load test at 100 k rows recorded here with p95/p99
- [ ] Import dry-run executed against the pilot's real export; reconciliation report reviewed with the clinic
- [ ] Patient header component reused by TRI/CON/RX/DSP (not reimplemented)
- [ ] ID masking verified in API responses, logs and error tracker
- [ ] Open questions answered
