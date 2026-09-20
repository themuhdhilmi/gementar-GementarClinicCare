# Triage / Nurse Station (TRI)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 2 |
| **Spec sections** | 5 |
| **Depends on** | ENC, PAT, AUD |
| **Depended on by** | CON, RPT |
| **Est. effort** | ~10 h |

---

## 1. Purpose & business value

Vitals captured once, by the nurse, and in front of the doctor before the patient sits down. Abnormal readings flagged so nothing is missed on a busy afternoon. It is a small module with a high clinical value-to-effort ratio, and it is where allergies most often get asked about and recorded.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `triage.write` — record vitals, symptoms, nurse notes | ✓ | ✓ | ✓ | – |
| Amend a triage record (same encounter, before consultation signed) | ✓ | ✓ | ✓ (own) | – |
| Read triage (`clinical.read`) | ✓* | ✓ | ✓ | – |
| Configure abnormal thresholds (`admin.settings`) | ✓ | – | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| TRI-F-01 | Record for an encounter: systolic/diastolic BP (mmHg), heart rate (bpm), respiratory rate (bpm), temperature (°C, 1 dp), SpO2 (%), weight (kg, 1 dp → stored grams), height (cm → stored mm), BMI (auto), capillary glucose (mmol/L, 1 dp, fasting/random flag), pain score (0–10). All optional; at least one value required to save. | Must |
| TRI-F-02 | Free-text presenting complaint / symptoms and nurse notes. | Must |
| TRI-F-03 | Abnormal-value flagging using static thresholds per parameter, age-band aware for children (`<12`) vs adults; thresholds are tenant settings with clinical defaults. A flag is advisory and does not block saving. | Must |
| TRI-F-04 | Height prefilled from the last recorded height within 12 months (adults); weight prefilled from last visit as a hint, not a value. | Should |
| TRI-F-05 | Allergy prompt: if patient `nkda_recorded IS NULL`, the triage form asks and records NKDA or allergies (PAT) before save. | Must |
| TRI-F-06 | Multiple triage records per encounter allowed (re-check after nebuliser, etc.); the latest is the "current"; all visible to the doctor in sequence. | Should |
| TRI-F-07 | On save, encounter transitions `TRIAGE_IN_PROGRESS` → `DOCTOR_WAITING` (ENC), unless the nurse chooses "keep at triage" (e.g. awaiting a second reading). | Must |
| TRI-F-08 | Emergency escalation: a `CRITICAL` flag (e.g. SpO2 < 90, SBP < 90, glucose < 3) prompts the nurse to set encounter priority `EMERGENCY` (ENC) and notifies the doctor board immediately. | Must |
| TRI-F-09 | Vitals trend for the patient across visits (small sparkline per parameter) visible in triage and consultation. | Could |
| TRI-F-10 | Triage record is editable until the consultation is signed; after that, changes create an amendment (same mechanism as CON). | Must |

## 4. Key workflows

**Standard**
1. Nurse: Triage queue → Call next → form opens with patient header (allergies, conditions, last vitals)
2. Enter values (tab through; BP as `120/80` single field; auto-BMI)
3. Flags appear inline as values are typed
4. Allergy prompt if not recorded
5. Save → patient moves to doctor queue

**Critical reading**
1. SpO2 entered 86 → red CRITICAL banner → "Set EMERGENCY priority?" → yes
2. Doctor board flashes; encounter jumps queue

## 5. Data model

```
triage
  id                uuid pk
  tenant_id         uuid not null
  encounter_id      uuid not null → encounter
  patient_id        uuid not null → patient      -- denormalised for trend queries
  sequence          int not null default 1       -- nth triage in this encounter
  systolic          smallint, diastolic smallint
  heart_rate        smallint
  resp_rate         smallint
  temperature_dc    smallint                     -- deci-°C: 372 = 37.2
  spo2              smallint
  weight_g          int
  height_mm         smallint
  bmi_x10           smallint                     -- 245 = 24.5, computed
  glucose_x10       smallint                     -- mmol/L ×10
  glucose_fasting   bool
  pain_score        smallint
  complaint         text
  notes             text
  flags             jsonb not null default '[]'  -- [{param:'spo2', level:'CRITICAL', value:86, threshold:'<90'}]
  max_flag_level    enum(NONE, ABNORMAL, CRITICAL) not null default 'NONE'
  recorded_by       uuid not null, recorded_at timestamptz not null
  locked_at         timestamptz                  -- set when consultation signed
  UNIQUE (encounter_id, sequence)
  INDEX (patient_id, recorded_at desc)

triage_amendment
  id uuid pk, tenant_id, triage_id, amended_by, amended_at, reason text not null,
  previous jsonb not null, current jsonb not null
```

Thresholds live in tenant settings `clinical.triage_thresholds` with defaults:

| Param | Abnormal (adult) | Critical (adult) |
|---|---|---|
| SBP | <100 or >140 | <90 or >180 |
| DBP | <60 or >90 | >120 |
| HR | <50 or >100 | <40 or >130 |
| RR | <12 or >20 | <8 or >30 |
| Temp | <35.5 or ≥37.8 | ≥39.5 or <35 |
| SpO2 | <95 | <90 |
| Glucose (random) | <4.0 or >11.0 | <3.0 or >20.0 |
| BMI | <18.5 or ≥27.5 | — |
| Pain | ≥7 | — |

Paediatric bands to be confirmed with the clinic's doctor (TRI-Q-01). These defaults are a starting point for a GP setting, not a clinical standard — the clinic owns them.

## 6. State machines

Triage record: `OPEN` (editable) → `LOCKED` (on `consultation.signed`) → amendments only.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| TRI-R-01 | Numeric values stored as integers in fixed units (grams, mm, deci-units); the API converts. | DTO layer |
| TRI-R-02 | BMI computed server-side from stored weight/height; never accepted from the client. | Service |
| TRI-R-03 | Flags computed server-side at save time against the thresholds in force, and stored — so a later threshold change does not rewrite history. | Service |
| TRI-R-04 | After `locked_at`, updates are rejected; amendments required. | Service + trigger (shared with CON) |
| TRI-R-05 | Saving triage emits `triage.recorded`; ENC handles the transition (TRI never writes encounter status). | Event |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/encounters/:id/triage` | `clinical.read` | All records for the encounter; audited `clinical.viewed` |
| POST | `/encounters/:id/triage` | `triage.write` | `{ ..., advance: true|false }` |
| PATCH | `/triage/:id` | `triage.write` | Until locked |
| POST | `/triage/:id/amend` | `triage.write` | After locked; reason |
| GET | `/patients/:id/vitals-trend?param=` | `clinical.read` | Last 12 readings |
| GET/PUT | `/tenant/settings/clinical.triage_thresholds` | `admin.settings` | via TEN |

## 9. Domain events

**Emits:** `triage.recorded` `{ encounterId, maxFlagLevel, advance }`, `triage.abnormal_flagged` `{ level, flags }`, `triage.amended`
**Consumes:** `consultation.signed` (→ lock)

## 10. Audit events

`triage.recorded`, `triage.amended` (before/after), `clinical.viewed` on read.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Triage form | Patient header on top; values in a single column in the order nurses take them (BP, HR, Temp, SpO2, Weight, Height, Glucose, Pain); BP as one `120/80` input; tab order strict; unit labels fixed; flags inline (amber/red) as you type; last reading shown greyed beside each field; "Save & send to doctor" primary, "Save, keep here" secondary; entire form usable in ≤ 45 s |
| Allergy prompt | Modal only when not recorded; NKDA one click; add allergy inline |
| Critical banner | Full-width red; one-click "Set EMERGENCY" |
| Doctor view | Read-only card in CON workspace with flags highlighted; amend link |

## 12. Validation

| Param | Range accepted |
|---|---|
| SBP 50–300, DBP 20–200, SBP > DBP | |
| HR 20–250; RR 4–80 | |
| Temp 30.0–45.0 | |
| SpO2 50–100 | |
| Weight 0.5–400 kg; Height 30–250 cm | |
| Glucose 0.5–50.0 | |
| Pain 0–10 integer | |

Out-of-range → rejected as "implausible" (distinct from "abnormal"). A typo of `1200/80` must not be saved as a critical BP.

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| TRI-N-01 | Form save ≤ 150 ms server time. |
| TRI-N-02 | Works fully by keyboard; touch-friendly targets for tablet use at the nurse station. |
| TRI-N-03 | Trend query ≤ 100 ms (indexed by patient). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Patient refuses vitals | Save with notes only ("refused") — the "at least one value" rule accepts notes as a value. |
| Nurse enters weight in lb | Not supported; units fixed metric. UI label makes it obvious. |
| Child weight for dosing | Available to RX via latest triage; RX shows weight beside dose fields for patients < 12. |
| Doctor takes vitals themselves (no nurse) | DOCTOR has `triage.write`; same form inside CON workspace. |
| Threshold changed after records exist | Historical flags unchanged (TRI-R-03); a recomputation tool is deliberately not provided. |

## 15. Compliance

Clinical data — access gated by `clinical.read`, views audited, immutable after sign with amendment trail.

## 16. Reporting outputs

- Triage completion rate; time from check-in to triage (RPT)
- Abnormal/critical flag counts (clinical quality)
- BMI distribution (ANL, V2)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| TRI-T-01 | Given weight 70.0 kg and height 175 cm, when saved, then `bmi_x10 = 229` and the response shows 22.9. |
| TRI-T-02 | Given SpO2 86, when saved, then `flags` contains a CRITICAL entry and `triage.abnormal_flagged` is emitted with level CRITICAL. |
| TRI-T-03 | Given SBP 1200, when saved, then 422 "implausible". |
| TRI-T-04 | Given a patient with `nkda_recorded null`, when the triage form loads, then the allergy prompt appears; saving NKDA sets `nkda_recorded = true` on the patient. |
| TRI-T-05 | Given `advance: true`, when saved, then the encounter is `DOCTOR_WAITING`. |
| TRI-T-06 | Given the consultation is signed, when the triage record is PATCHed, then 409; when amended with reason, then an amendment row exists and the original values are preserved. |
| TRI-T-07 | Given the thresholds are changed, then existing `flags` are unchanged. |

## 18. Migration & rollout

Ships in R2 with CON. Confirm thresholds with the clinic's doctor and record the agreed table in tenant settings before R2. Historical vitals are not migrated.

## 19. Out of scope

- Device integration (BP monitor, pulse oximeter via Bluetooth/serial) → V3
- Paediatric growth charts, percentile plots → V2
- Early-warning scores (NEWS2 etc.) → V2/V3 with clinical sign-off

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| TRI-Q-01 | Confirm adult thresholds and provide paediatric bands. | Pilot clinic doctor |
| TRI-Q-02 | Is triage done on a tablet or a desktop? | Pilot clinic |
| TRI-Q-03 | Do they record respiratory rate routinely? (Include but optional.) | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] TRI-T-01 … T-07 green
- [ ] Thresholds agreed and stored in tenant settings
- [ ] Nurse completes form in ≤ 45 s during shadowing
- [ ] Open questions answered
