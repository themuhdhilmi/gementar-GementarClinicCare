# Prescription (RX)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 2 |
| **Spec sections** | 7 |
| **Depends on** | CON, PAT, INV (catalogue), AUD |
| **Depended on by** | DSP, BIL, DOC |
| **Est. effort** | ~20 h |

---

## 1. Purpose & business value

The clinical act of prescribing, separated deliberately from the physical act of dispensing. A prescription says what the doctor intends; a dispense says what left the shelf. They differ in quantity (partial), in product (substitution) and in time — collapsing them makes stock wrong and clinical intent unrecoverable.

Two safety checks live here: **allergy** and **duplicate**. They are simple, and they are worth real care, because a warning that fires constantly gets ignored — and then the one that mattered gets ignored too.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `rx.write` — create/edit items on own draft consultation | – | ✓ | – | – |
| `rx.override_warning` | – | ✓ | – | – |
| Read prescription (`clinical.read`) | ✓* | ✓ | ✓ | – |
| Read for dispensing (`dispense.perform`, limited DTO: items, instructions, no notes) | ✓ | ✓ | ✓ | ✓ |
| Mark item `DECLINED` by patient (`dispense.perform`) | ✓ | ✓ | ✓ | ✓ |

## 3. Functional requirements

### Items
| ID | Requirement | Priority |
|---|---|---|
| RX-F-01 | A prescription belongs to a consultation; items are added from the tenant catalogue (INV `product` where `type = MEDICINE`). Non-catalogue ("external") items allowed for prescriptions to be filled elsewhere, flagged `EXTERNAL`. | Must |
| RX-F-02 | Item fields: product, **dose** (number + unit: mg, ml, tab, cap, puff, drop, unit, sachet, application), **route** (PO, TOP, SC, IM, IV, INH, PR, PV, SL, OPH, OTIC, NASAL), **frequency** (structured: OD, BD, TDS, QID, Q4H, Q6H, Q8H, ON, OM, PRN, STAT, weekly, custom "x times per y"), **duration** (days/weeks, or "until finished"), **quantity** (auto-computed from dose × frequency × duration where units allow, editable), **instructions** (free text + common phrases: before/after food, complete course, may cause drowsiness), **PRN** flag with indication, **repeat** allowed (V1). | Must |
| RX-F-03 | Quantity auto-calc: for discrete units (tab/cap) = dose × freq/day × days, rounded up; for liquids = volume per dose × freq × days rounded to pack size; for topicals/inhalers = pack count. Formula shown; doctor can override. | Must |
| RX-F-04 | Stock awareness: item shows on-hand quantity at the branch and nearest expiry; out-of-stock items can still be prescribed (dispenser substitutes or marks external) with a visible warning. | Must |
| RX-F-05 | Prescription is editable while the consultation is `DRAFT`; on sign it becomes `ACTIVE` and routes to DSP. | Must |
| RX-F-06 | Post-sign changes go through CON amendment + RX amendment: cancel an item, add an item, change dose — each creates a new item version; DSP sees the current version and any dispensed-against-old-version flag. | Must |
| RX-F-07 | Patient label text per item (drug, strength, dose, frequency, instructions, warnings) generated in the patient's preferred language (MS/EN in V0), used by DSP for label printing. | Must |
| RX-F-08 | Prescription printout (DOC) for external filling: clinic letterhead, doctor name + registration, patient, items, signature line. | Must |
| RX-F-09 | Copy items from the patient's last prescription ("repeat last") with each item re-checked. | Should |
| RX-F-10 | Favourite / recent items per doctor for fast entry. | Should |
| RX-F-11 | Paediatric weight-based dosing helper: shows mg/kg computed from latest triage weight beside the dose field for patients < 12; never auto-fills. | Should |

### Safety checks
| ID | Requirement | Priority |
|---|---|---|
| RX-F-12 | **Allergy check** on every item add/change and on template/repeat application: match patient `patient_allergy` (status ≠ REFUTED) against the product's `generic_name`, `drug_class`, and any linked `product_id`. Match levels: `EXACT` (same product/generic), `CLASS` (same drug class), `UNLINKED` (patient has free-text allergies not linked to catalogue → "check manually"). | Must |
| RX-F-13 | **Duplicate check**: same generic already on this prescription; or an `ACTIVE`/recently dispensed (≤ 30 d) item for the same generic from any branch. Shows the prior item, date, doctor. | Must |
| RX-F-14 | **Allergies not recorded** (`nkda_recorded IS NULL`): a prominent warning on the first item add; offers to record NKDA/allergies inline (PAT). | Must |
| RX-F-15 | Warnings are **overridable** with a reason (free text, ≥ 5 chars, or pick: "Tolerated previously", "Benefit outweighs risk", "Allergy record incorrect → refute"); override recorded on the item and audited; `SEVERE`/`LIFE_THREATENING` EXACT matches require re-confirmation on sign. | Must |
| RX-F-16 | Max-dose sanity: per-product optional `max_daily_dose` in the catalogue; exceeding it warns. | Should |
| RX-F-17 | Warnings are re-evaluated at sign (allergies may have been added at triage after the draft started). | Must |
| RX-F-18 | Controlled substances (`product.is_controlled`): item marked; prescription printout includes the required register fields; DSP enforces its register (INV/DSP). | Must |

## 4. Key workflows

**Add items during consultation**
1. `R` → RX panel → type "amox" → list shows Amoxicillin 500 mg cap (on hand 240, exp 03/2027) → Enter
2. Dose prefilled from product default (500 mg), route PO, freq TDS, duration 5 d → qty auto 15
3. Instruction chip "after food, complete course" → Enter → next item
4. Allergy check runs on add: patient allergic to Penicillin (CLASS match) → red inline banner "Penicillin-class allergy (VERIFIED, SEVERE)" → override with reason or remove

**Sign**
1. `Ctrl+Enter` → summary shows each item with warning state; any SEVERE EXACT override requires ticking "I confirm"
2. Sign → prescription `ACTIVE` → DSP queue

**Post-sign dose correction (not yet dispensed)**
1. Doctor → signed record → Amend → RX item → new dose → reason → save
2. Item version 2 supersedes; DSP queue shows "updated" badge

**Post-sign correction (already dispensed)**
1. Same amendment; DSP shows "dispensed against v1" → dispenser initiates return + re-dispense (DSP)

## 5. Data model

```
prescription
  id                uuid pk
  tenant_id         uuid not null
  encounter_id      uuid not null → encounter
  consultation_id   uuid not null → consultation
  patient_id        uuid not null
  branch_id         uuid not null
  prescribed_by     uuid not null → user
  status            enum(DRAFT, ACTIVE, COMPLETED, CANCELLED) not null
  language          char(2) not null default 'MS'
  notes_to_dispenser text
  signed_at         timestamptz
  completed_at      timestamptz             -- all items dispensed/declined/cancelled
  INDEX (consultation_id)
  INDEX (patient_id, signed_at desc)
  INDEX (branch_id, status)                 -- pharmacy queue

prescription_item
  id                uuid pk
  tenant_id         uuid not null
  prescription_id   uuid not null → prescription
  version           int not null default 1
  supersedes_id     uuid → prescription_item
  is_current        bool not null default true
  product_id        uuid → product           -- null when EXTERNAL
  external_name     text                     -- for EXTERNAL
  generic_name      text not null            -- snapshot
  drug_class        text                     -- snapshot
  strength          text                     -- snapshot
  dose_value        numeric(10,3) not null
  dose_unit         text not null
  route             text not null
  frequency_code    text not null            -- OD, BD, TDS ... CUSTOM
  frequency_per_day numeric(6,3)             -- derived; custom stores explicit
  is_prn            bool not null default false
  prn_indication    text
  duration_days     int
  until_finished    bool not null default false
  quantity          numeric(10,3) not null
  quantity_unit     text not null            -- tab, ml, bottle, tube...
  quantity_auto     bool not null default true
  instructions      text
  label_text        text not null            -- generated, per language
  is_external       bool not null default false
  is_controlled     bool not null default false   -- snapshot
  status            enum(DRAFT, ACTIVE, DISPENSED, PARTIAL, DECLINED, CANCELLED, SUPERSEDED) not null
  warnings          jsonb not null default '[]'   -- [{type:'ALLERGY', level:'CLASS', ref:{allergyId}, severity:'SEVERE'}]
  override_reason   text
  overridden_by     uuid, overridden_at timestamptz
  cancelled_reason  text
  created_by uuid, created_at, updated_at
  INDEX (prescription_id, is_current)
  INDEX (tenant_id, generic_name, created_at)   -- duplicate check across visits
  INDEX (product_id)

rx_favourite
  id uuid pk, tenant_id, user_id, product_id, defaults jsonb, uses int, last_used_at
  UNIQUE (user_id, product_id)

frequency_code   -- reference in code: { OD:1, BD:2, TDS:3, QID:4, Q4H:6, Q6H:4, Q8H:3, ON:1, OM:1, STAT:1(once), PRN:null, WEEKLY:1/7 }
```

## 6. State machines

**Prescription**: `DRAFT` → `ACTIVE` (on sign) → `COMPLETED` (all items terminal) | `CANCELLED` (consultation cancelled or all items cancelled).
**Item**: `DRAFT` → `ACTIVE` → `PARTIAL` → `DISPENSED`; `ACTIVE`/`PARTIAL` → `DECLINED` | `CANCELLED`; any current → `SUPERSEDED` (new version created).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| RX-R-01 | **Stock never moves on prescribe.** RX has no write path to `stock_movement`. | Module boundary; INV's ledger service rejects `reference_type = 'prescription'` |
| RX-R-02 | Product data (generic, class, strength) is snapshotted onto the item at creation so catalogue edits do not rewrite history. | Service |
| RX-R-03 | Warnings are computed server-side on every item write and again at sign; the client never decides whether a warning exists. | Service |
| RX-R-04 | An item with a `SEVERE`/`LIFE_THREATENING` `EXACT` allergy warning cannot be `ACTIVE` without `override_reason` and a sign-time confirmation flag. | Service |
| RX-R-05 | Every override is audited with the warning payload and reason. | Service → AUD |
| RX-R-06 | Items on a signed prescription are immutable; changes create a new version (`supersedes_id`) and mark the old `SUPERSEDED`. | Service + trigger (no UPDATE of clinical columns where `status <> DRAFT`) |
| RX-R-07 | A prescription's items are only editable by the consultation's doctor while the consultation is `DRAFT`, or via amendment after. | Service |
| RX-R-08 | `label_text` is regenerated whenever dose/frequency/instructions change; DSP prints from the stored text. | Service |
| RX-R-09 | Controlled items carry `is_controlled` snapshot; printouts and DSP registers key off it. | Service |
| RX-R-10 | Dispenser DTO excludes clinical notes and diagnoses. | Controller |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/consultations/:id/prescription` | `clinical.read` | Full |
| POST | `/consultations/:id/prescription/items` | `rx.write` | Returns item + warnings |
| PATCH | `/prescription-items/:id` | `rx.write` | DRAFT only; recomputes warnings/label |
| DELETE | `/prescription-items/:id` | `rx.write` | DRAFT only |
| POST | `/prescription-items/:id/override` | `rx.override_warning` | `{ reason, refuteAllergyId? }` |
| POST | `/prescription-items/:id/amend` | `clinical.amend` | Post-sign; creates version |
| POST | `/prescription-items/:id/cancel` | `clinical.amend` | Post-sign; reason |
| POST | `/prescription-items/:id/decline` | `dispense.perform` | Patient declined at pharmacy |
| POST | `/consultations/:id/prescription/repeat-last` | `rx.write` | |
| GET | `/prescriptions/:id/dispense-view` | `dispense.perform` | Limited DTO |
| GET | `/prescriptions/:id/print` | `document.issue` | PDF via DOC |
| GET | `/products/search?q=&type=MEDICINE` | `rx.write` | From INV, with on-hand |
| GET/POST/DELETE | `/me/rx-favourites` | `rx.write` | |
| POST | `/prescriptions/check` | `rx.write` | Dry-run warnings for a proposed item set (templates) |

## 9. Domain events

**Emits:** `prescription.created`, `prescription.updated`, `prescription.activated` (on sign), `prescription.item_amended`, `prescription.item_cancelled`, `prescription.warning_raised`, `prescription.warning_overridden`, `prescription.completed`
**Consumes:** `consultation.signed` (→ activate), `consultation.cancelled`, `patient.allergy_added` (re-check open drafts and ACTIVE undispensed items → raise warning to DSP), `dispense.completed`/`dispense.partial` (→ item status), `catalogue.changed` (no effect on existing items — snapshot)

## 10. Audit events

All §9; overrides carry full warning payload; `clinical.viewed` on full read (dispense-view is audited as `rx.dispense_viewed`, lighter).

## 11. Screens & UX requirements

| Area | Requirements |
|---|---|
| RX panel (in CON workspace) | Search box with type-ahead (generic + brand + strength), stock + expiry beside each result; item rows editable inline; dose/route/freq/duration as compact selects with keyboard cycling; qty auto with "auto" badge that clears on manual edit; instruction chips; per-item warning banner (red = allergy, amber = duplicate/stock/max-dose); override inline |
| Sign summary | Each item one line with warning icons; SEVERE overrides need explicit tick |
| Signed view | Items with version history expandable; "Amend" per item |
| Print | Letterhead, doctor name + MMC no., items, controlled-drug fields when applicable |

## 12. Validation

- Dose > 0; unit from list; route from list; frequency from list or custom (`n` per `day|week`)
- Duration 1–365 days or `until_finished`
- Quantity > 0; unit compatible with product's dispensing unit
- PRN requires indication
- Override reason ≥ 5 chars
- External item requires `external_name`

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| RX-N-01 | Item add round-trip (search → warnings) ≤ 200 ms. |
| RX-N-02 | Allergy check covers 100% of items with a linked product; unlinked free-text allergies always produce the "check manually" warning (never silently no-match). |
| RX-N-03 | Label text generation deterministic and unit-tested for MS and EN. |
| RX-N-04 | Warning false-positive rate reviewed monthly from override reasons (clinical governance input to ANL). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Allergy recorded as brand name (e.g. "Augmentin") | If linked to a product at record time → generic match works. If free text → UNLINKED "check manually" warning on every prescription until a clinician links it (PAT). |
| Patient has an allergy to an excipient/dye | Free-text; UNLINKED warning; no automation in V0. |
| Doctor prescribes 0.5 tab | Allowed; qty rounds up to whole tabs; label says "half a tablet". |
| Product out of stock | Prescribed with amber warning; DSP handles substitute/external. |
| Duplicate is intentional (e.g. paracetamol PRN + regular) | Override reason "intentional"; recorded. |
| Template item conflicts with allergy | Added with warning attached; not silently dropped, not silently added. |
| Consultation cancelled after RX saved | Prescription `CANCELLED`; items `CANCELLED`; DSP queue removes. |
| Allergy added at triage after doctor started draft | Sign-time re-check raises it (RX-F-17). |
| Prescription for controlled drug | Item flagged; printout includes patient IC unmasked (regulatory requirement — confirm RX-Q-03), quantity in words; DSP register entry required. |
| Doctor with no `rx.write` (locum not yet set up) | Cannot prescribe; ADMIN fixes role; no workaround path. |

## 15. Compliance

- Prescribing safety is patient-safety territory; overrides are audited to support governance review.
- Controlled-drug prescriptions must meet Poisons Act / Dangerous Drugs Act documentation requirements — **confirm exact fields with the clinic** (RX-Q-03).
- Prescription printouts carry doctor identity and registration (MMC/APC from `employee`).
- Dispenser view minimises clinical data exposure.

## 16. Reporting outputs

- Top prescribed generics; prescriptions per doctor (RPT)
- Warning and override counts by type and doctor (clinical governance)
- Antibiotic prescribing rate (quality indicator, ANL)
- Controlled-drug prescriptions (register, INV/DSP)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| RX-T-01 | Given a patient with VERIFIED SEVERE allergy to Amoxicillin (linked), when Amoxicillin is added, then the item carries an `ALLERGY/EXACT/SEVERE` warning and cannot be signed without override + confirmation. |
| RX-T-02 | Given a patient allergic to "Penicillin" with `drug_class = PENICILLIN`, when Ampicillin (class PENICILLIN) is added, then a `CLASS` warning is raised. |
| RX-T-03 | Given a free-text allergy "some antibiotic", when any item is added, then an `UNLINKED` "check manually" warning is present. |
| RX-T-04 | Given Amoxicillin was dispensed 10 days ago at another branch, when added now, then a `DUPLICATE` warning references that item. |
| RX-T-05 | Given dose 500 mg, TDS, 5 days, when saved, then `quantity = 15` and `quantity_auto = true`; when quantity edited to 20, then `quantity_auto = false`. |
| RX-T-06 | Given a signed prescription, when an item is PATCHed, then 409; when amended, then a v2 item exists, v1 is `SUPERSEDED`, and DSP's view shows v2 with an "updated" flag. |
| RX-T-07 | Given an override, then the audit entry contains the warning payload and reason. |
| RX-T-08 | Given an allergy is added at triage after the draft opened, when the doctor signs, then the sign is blocked with the new warning. |
| RX-T-09 | Given any RX operation, then no `stock_movement` row exists referencing it. |
| RX-T-10 | Given an MS-language patient, then `label_text` is in Malay ("Ambil 1 biji, 3 kali sehari, selepas makan"). |

## 18. Migration & rollout

- R2 with CON; requires the medicine catalogue (INV) to be loaded with `generic_name` and `drug_class` **before** R2 — this is on the critical path
- Drug class list: start from a simple curated list (penicillins, cephalosporins, NSAIDs, sulfonamides, macrolides, opioids …) mapped onto the clinic's own catalogue with the doctor
- Historical prescriptions not migrated

## 19. Out of scope

- Drug–drug interaction checking → V2 (licensed database)
- Renal/hepatic dose adjustment → V3
- Repeat prescriptions without visit (chronic) → V1 with APT/MEM
- e-Prescription transmission to external pharmacies → V3 `TEL`/`INT`
- Formulary / panel-restricted drug lists → V1 `PNL`

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| RX-Q-01 | Source of `generic_name` and `drug_class` for the catalogue — clinic's own list mapped by hand, or a Malaysian drug reference? | You + clinic doctor |
| RX-Q-02 | Label languages needed beyond MS/EN (ZH, TA)? | Pilot clinic |
| RX-Q-03 | Controlled-drug prescription fields required by their regulator/inspector? | Pilot clinic |
| RX-Q-04 | Do they prescribe external items (to be filled at a pharmacy) often? | Pilot clinic |
| RX-Q-05 | Common instruction phrases they use (in MS and EN). | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] RX-T-01 … T-10 green
- [ ] Catalogue has `generic_name` on 100% and `drug_class` on all antibiotics/NSAIDs/opioids at minimum
- [ ] Label text reviewed by the clinic in MS and EN
- [ ] Override audit visible on the audit dashboard
- [ ] Open questions answered
