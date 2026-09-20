# Procedures (PRC)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 3 |
| **Spec sections** | 11 |
| **Depends on** | ENC, CON, INV, AUD |
| **Depended on by** | BIL, RPT |
| **Est. effort** | ~15 h |

---

## 1. Purpose & business value

Injections, nebulisers, dressings, vaccinations, minor procedures — ordered by the doctor, performed by a nurse or the doctor, billed at a catalogue price, and **automatically deducting their consumables** so a nebuliser session deducts the mask and the respule without anyone remembering. Procedures are a meaningful revenue line and, without consumable auto-deduction, the most common source of "why is stock wrong" in a GP clinic.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `procedure.order` — order for an encounter | – | ✓ | – | – |
| `procedure.perform` — record performed, consumables, notes | ✓ | ✓ | ✓ | – |
| Cancel an order (before performed) | ✓ | ✓ | ✓ | – |
| Void a performed procedure (reverses consumables; BIL line removed) | ✓ | – | – | – |
| `catalogue.write` — procedure catalogue, pricing, consumable mapping | ✓ | – | – | – |
| Read (`clinical.read`) | ✓* | ✓ | ✓ | – |

## 3. Functional requirements

### Catalogue
| ID | Requirement | Priority |
|---|---|---|
| PRC-F-01 | Procedure catalogue (tenant): code, name, category (`INJECTION`, `NEBULISER`, `DRESSING`, `MINOR_SURGERY`, `VACCINATION`, `SCREENING`, `OTHER`), default price (sen), `requires_consent` flag, `requires_doctor` flag (nurse cannot perform), default duration, notes/protocol text, status. | Must |
| PRC-F-02 | Consumable mapping per procedure: list of `(product, quantity)` auto-consumed on perform; editable at perform time (e.g. two dressings used). | Must |
| PRC-F-03 | Vaccination procedures link to a product (the vaccine, batched, cold-chain) so the **batch number and expiry are recorded on the patient's record** and the vaccine leaves stock as a `CONSUME` movement. | Must |
| PRC-F-04 | Procedure price history with effective dates. | Should |

### Ordering & performing
| ID | Requirement | Priority |
|---|---|---|
| PRC-F-05 | Doctor orders procedures from the CON plan (picker with search, category, price). Orders exist as `ORDERED` on the encounter. | Must |
| PRC-F-06 | Nurse-performed procedures without a prior doctor order (e.g. dressing change on a nurse-only visit) allowed if `requires_doctor = false` and tenant setting `procedures.allow_nurse_initiated`; recorded as `ORDERED` + `PERFORMED` by the nurse with a flag. | Should |
| PRC-F-07 | Perform: performer, time, site/laterality (for injections/dressings), consumables actually used (prefilled from mapping; batches FEFO-suggested for batched consumables), notes, complications (none / text), consent captured (`requires_consent` → tick + who consented; signed form → DOC in V1). | Must |
| PRC-F-08 | On perform, in one transaction: `CONSUME` movements via INV ledger for each consumable; `encounter_procedure` set `PERFORMED`; BIL line created at the catalogue price (snapshot); `procedure.performed` emitted. | Must |
| PRC-F-09 | Cancel an order before performing (reason). | Must |
| PRC-F-10 | Void a performed procedure (ADMIN, reason, ≤ 24 h): reverses consumables with `ADJUST_IN` referencing the void, removes/credits the BIL line; audited. | Must |
| PRC-F-11 | Vaccination record view on the patient (vaccine, date, batch, expiry, site, given by) — the basis for a V1 immunisation history/certificate. | Must |
| PRC-F-12 | Procedure queue for nurses: encounters with `ORDERED` procedures (`PROCEDURE_WAITING` per ENC), with what is ordered. | Must |

## 4. Key workflows

**Nebuliser**
1. Doctor plan → `P` → "Nebuliser (salbutamol)" → ordered
2. Sign → encounter `PROCEDURE_WAITING` → nurse queue
3. Nurse → open → consumables prefilled (mask ×1, salbutamol respule ×1 [batch FEFO]) → perform → notes → save
4. Stock deducted; invoice line "Nebuliser RM 25.00"; encounter → pharmacy/payment

**Vaccination**
1. Ordered "Influenza vaccine" → nurse performs → vaccine batch selected (cold-chain flag visible) → site "L deltoid" → consent ticked → save
2. Patient record → Vaccinations shows batch/expiry

**Void**
1. Procedure recorded on the wrong patient → ADMIN void within 24 h → consumables restored → invoice line removed (if invoice not yet issued; else BIL void/reissue)

## 5. Data model

```
procedure_catalog   (tenant-scoped)
  id              uuid pk
  tenant_id       uuid not null
  code            text not null
  name            text not null
  category        enum(INJECTION, NEBULISER, DRESSING, MINOR_SURGERY, VACCINATION, SCREENING, OTHER) not null
  price           bigint not null                -- sen
  requires_consent bool not null default false
  requires_doctor bool not null default false
  vaccine_product_id uuid → product              -- for VACCINATION
  default_duration_min int
  protocol        text
  status          enum(ACTIVE, INACTIVE) not null default 'ACTIVE'
  UNIQUE (tenant_id, code)

procedure_consumable
  id uuid pk, tenant_id
  procedure_id    uuid not null → procedure_catalog
  product_id      uuid not null → product
  quantity        numeric(10,3) not null
  optional        bool not null default false
  UNIQUE (procedure_id, product_id)

procedure_price_history
  id uuid pk, tenant_id, procedure_id, price bigint, effective_from timestamptz, set_by uuid, reason text

encounter_procedure
  id              uuid pk
  tenant_id       uuid not null
  branch_id       uuid not null
  encounter_id    uuid not null → encounter
  patient_id      uuid not null
  consultation_id uuid → consultation
  procedure_id    uuid not null → procedure_catalog
  name_snapshot   text not null
  price_snapshot  bigint not null
  status          enum(ORDERED, PERFORMED, CANCELLED, VOIDED) not null
  ordered_by      uuid, ordered_at timestamptz
  nurse_initiated bool not null default false
  performed_by    uuid, performed_at timestamptz
  site            text, laterality enum(LEFT, RIGHT, BILATERAL, NA)
  consent_given   bool, consent_by text, consent_at timestamptz
  notes           text
  complications   text
  cancel_reason   text
  voided_by uuid, voided_at timestamptz, void_reason text
  INDEX (encounter_id)
  INDEX (branch_id, status)
  INDEX (patient_id, performed_at desc)

encounter_procedure_consumable
  id uuid pk, tenant_id
  encounter_procedure_id uuid not null → encounter_procedure
  product_id      uuid not null
  batch_id        uuid not null → product_batch
  quantity        numeric(10,3) not null
  stock_movement_id uuid not null → stock_movement
  reversal_movement_id uuid → stock_movement

vaccination_record   (projection for the patient record; written at perform for VACCINATION)
  id uuid pk, tenant_id, patient_id, encounter_procedure_id
  vaccine_product_id uuid, vaccine_name text, batch_no text, expiry date
  dose_number int, site text, given_by uuid, given_at timestamptz
  INDEX (patient_id, given_at)
```

## 6. State machines

`ORDERED` → `PERFORMED` → `VOIDED` (ADMIN, ≤ 24 h); `ORDERED` → `CANCELLED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PRC-R-01 | Consumables move through the INV ledger (`CONSUME`) inside the perform transaction; no separate path. | Service calls `LedgerService.move(tx, …)` |
| PRC-R-02 | Price and name are snapshotted at order time; a catalogue price change does not alter ordered/performed rows. | Service |
| PRC-R-03 | `requires_doctor = true` procedures cannot be performed by NURSE. | Service |
| PRC-R-04 | `requires_consent = true` procedures cannot be `PERFORMED` without `consent_given = true`. | Service |
| PRC-R-05 | Void reverses every consumable movement with a linked reversal and is only possible ≤ 24 h and by ADMIN. | Service |
| PRC-R-06 | A VACCINATION perform must select a batch of `vaccine_product_id` and writes a `vaccination_record`. | Service |
| PRC-R-07 | BIL line is created from `encounter_procedure` (performed), never from the order. | BIL consumes `procedure.performed` |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| CRUD | `/procedure-catalog` | `catalogue.write` (read: `stock.read`) | Incl. consumables |
| GET | `/procedure-catalog/search?q=` | `procedure.order`/`perform` | |
| POST | `/encounters/:id/procedures` | `procedure.order` (or `perform` if nurse-initiated allowed) | |
| GET | `/encounters/:id/procedures` | `clinical.read` | |
| POST | `/encounter-procedures/:id/perform` | `procedure.perform` | `{ consumables:[{productId,batchId,qty}], site, laterality, consent, notes, complications }` |
| POST | `/encounter-procedures/:id/cancel` | `procedure.perform` | Reason |
| POST | `/encounter-procedures/:id/void` | ADMIN + reauth | Reason |
| GET | `/branches/:b/procedures/queue` | `procedure.perform` | |
| GET | `/patients/:id/vaccinations` | `clinical.read` | |

## 9. Domain events

**Emits:** `procedure.ordered`, `procedure.performed` `{ encounterId, procedureId, priceSnapshot, consumables }`, `procedure.cancelled`, `procedure.voided`, `vaccination.recorded`
**Consumes:** `consultation.signed` (orders become active → ENC routes), `encounter.cancelled`

## 10. Audit events

All §9; catalogue and price changes; void with reason; consent capture.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Procedure picker (in CON) | Search + category chips; price shown; multi-add |
| Nurse procedure queue | Encounter rows with ordered procedures listed |
| Perform form | Patient header; procedure name; consumables table (prefilled; qty editable; batch select for batched with FEFO default); site/laterality quick buttons; consent tick with name; notes; complications; Save |
| Catalogue admin | List; edit with consumable mapping editor (product search + qty) |
| Patient → Vaccinations | Chronological table; print (V1 certificate) |

## 12. Validation

- Consumable qty > 0; batch belongs to product/branch, not expired
- Site required for INJECTION/VACCINATION/DRESSING
- Consent fields required when `requires_consent`
- Void reason ≥ 10 chars

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| PRC-N-01 | Perform transaction ≤ 200 ms for 5 consumables. |
| PRC-N-02 | Perform form completable in ≤ 30 s for a standard nebuliser. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Consumable out of stock | Perform allowed with the line removed and a warning; INV low-stock should have fired; nurse notes "used from unrecorded stock" — flagged for adjustment. |
| Procedure performed but doctor hasn't signed | Allowed (nurse acts on the order); encounter completion still requires signed consultation. |
| Same procedure twice in a visit (bilateral dressings) | Two orders, or one with laterality BILATERAL — clinic's choice; price ×2 if two orders. |
| Vaccine batch expired | Blocked (INV rule). |
| Void after invoice issued and paid | Void blocked; BIL void/reissue path; consumables reversed via INV adjustment with reference. |
| Price changed between order and perform | Order snapshot price applies (PRC-R-02). |

## 15. Compliance

- Vaccination records (batch, expiry, site) are a regulatory expectation and support adverse-event tracing.
- Consent capture for procedures that require it.
- Consumable traceability via batch for any recall.

## 16. Reporting outputs

- Procedures by type/day/performer; procedure revenue (RPT/FIN)
- Consumable usage by procedure (INV planning)
- Vaccinations administered by vaccine/period

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| PRC-T-01 | Given a nebuliser mapped to mask ×1 + respule ×1, when performed, then two `CONSUME` movements exist and on-hand decreases accordingly, in one transaction. |
| PRC-T-02 | Given `requires_doctor = true`, when NURSE performs, then 403. |
| PRC-T-03 | Given `requires_consent = true` and no consent, when performed, then 422. |
| PRC-T-04 | Given a VACCINATION performed with batch B, then a `vaccination_record` exists with B's batch_no and expiry. |
| PRC-T-05 | Given a performed procedure, when voided within 24 h by ADMIN, then reversal movements exist and the BIL line is removed. |
| PRC-T-06 | Given a catalogue price change after ordering, then the order's `price_snapshot` is unchanged and BIL uses it. |

## 18. Migration & rollout

- Catalogue built with the clinic from their current price list; consumable mappings agreed with the nurse
- R3 alongside DSP/INV

## 19. Out of scope

- Signed consent forms → V1 `DOC`
- Immunisation certificate / schedule reminders → V1
- Theatre / anaesthesia records → not planned
- Procedure packages (bundled pricing) → V2 `PKG`

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| PRC-Q-01 | Full procedure list with prices. | Pilot clinic |
| PRC-Q-02 | Which procedures do nurses perform without a doctor order? | Pilot clinic |
| PRC-Q-03 | Vaccines stocked; cold-chain handling. | Pilot clinic |
| PRC-Q-04 | Do they capture written consent today, and for what? | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] PRC-T-01 … T-06 green
- [ ] Catalogue and consumable mappings loaded and reviewed by the nurse
- [ ] Open questions answered
