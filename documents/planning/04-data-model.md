# Core Data Model

Scope: the V0 tables. V1+ entities (membership, panel, loyalty, purchasing) are sketched at the end so today's decisions do not block them.

## Global conventions

| Decision | Choice | Why |
|---|---|---|
| Primary keys | UUID v7 | Time-sortable, so index locality is good, without exposing sequential counts |
| DB naming | `snake_case` | Prisma maps to camelCase in TS via `@map` |
| Money | `BIGINT` **sen** | Never float, never `NUMERIC` in app code. `1250` = RM12.50 |
| Timestamps | `timestamptz`, UTC | Display in Asia/Kuala_Lumpur |
| Deletes | Soft delete on patient-facing rows | Clinical and financial records are never hard-deleted |
| Tenancy | `tenant_id` everywhere, `branch_id` where physical | See `03` |

### On money

Every amount is an integer of sen. There is no exception for "just a percentage discount" — compute the discount, round it to sen with an explicit documented rule, store the resulting integer. A stored percentage that is re-multiplied at display time will eventually disagree with the receipt the patient is holding.

## Identity and tenancy

```
tenant              id, name, slug, status, plan, created_at
branch              id, tenant_id, name, code, address, phone, timezone,
                    operating_hours, status
user                id, tenant_id, email, password_hash, name, phone,
                    mfa_secret, status, last_login_at
user_branch_role    id, tenant_id, user_id, branch_id, role
session             id, user_id, token_hash, expires_at, ip, user_agent,
                    revoked_at
employee            id, tenant_id, user_id?, type, mmc_no, apc_no, apc_expiry,
                    specialty, employment_status
```

`employee` is separate from `user` on purpose: a doctor is an employee with professional registration and a schedule, and may or may not have a login. Locums in V2 make this clearly correct.

## Patient

```
patient             id, tenant_id, mrn, name, id_type, id_number,
                    date_of_birth, gender, nationality, race?, phone, email,
                    address, emergency_contact_name, emergency_contact_phone,
                    blood_group?, notes, created_at, deleted_at
patient_allergy     id, tenant_id, patient_id, substance, reaction, severity,
                    recorded_by, recorded_at
patient_condition   id, tenant_id, patient_id, condition, since, status
patient_document    id, tenant_id, patient_id, type, filename, storage_key,
                    uploaded_by, uploaded_at
```

- `mrn` — human-readable patient number, unique per tenant, shown on documents
- Unique index on `(tenant_id, id_type, id_number)` where not deleted, to prevent duplicate registration. Expect the clinic to have real duplicates already; plan a merge tool in V1
- `id_number` is sensitive personal data under PDPA — see `05`

## Encounter and queue

One encounter = one visit. It is the spine the whole day hangs from.

```
encounter   id, tenant_id, branch_id, patient_id, encounter_no, type,
            status, queue_number, priority,
            attending_doctor_id?, room?,
            registered_at, triaged_at, consultation_started_at,
            consultation_ended_at, completed_at,
            cancelled_at, cancel_reason
encounter_event  id, tenant_id, encounter_id, from_status, to_status,
                 actor_id, occurred_at, note
```

### State machine

Enforce transitions in one place. An encounter in an impossible state is a patient standing in a corridor that nobody's screen shows.

```
REGISTERED
  → TRIAGE_WAITING → TRIAGE_DONE → DOCTOR_WAITING
  → DOCTOR_WAITING                                   (triage skipped)
  → CANCELLED

DOCTOR_WAITING   → IN_CONSULTATION → PHARMACY_WAITING   (meds prescribed)
                                   → PAYMENT_WAITING    (no meds)
                 → NO_SHOW

PHARMACY_WAITING → DISPENSING → PAYMENT_WAITING
PAYMENT_WAITING  → COMPLETED
```

Notes:
- Payment last matches how most Malaysian GP clinics run. **Confirm with the pilot** (`08`) — some collect before dispensing, which reorders these two states.
- `encounter_event` is append-only and drives both the audit trail and the "how long do patients actually wait" reporting that will sell V1.

## Clinical

```
triage        id, tenant_id, encounter_id, systolic, diastolic, heart_rate,
              temperature_c, spo2, weight_g, height_mm, bmi, glucose,
              pain_score, symptoms, notes, recorded_by, recorded_at

consultation  id, tenant_id, encounter_id, doctor_id,
              chief_complaint, history, examination,
              subjective, objective, assessment, plan,
              status,            -- DRAFT | SIGNED
              signed_at, signed_by,
              created_at, updated_at

consultation_amendment
              id, tenant_id, consultation_id, amended_by, amended_at,
              reason, previous_snapshot(jsonb), new_snapshot(jsonb)

diagnosis     id, tenant_id, consultation_id, code?, code_system?,
              description, type   -- PRIMARY | SECONDARY
```

Weight in grams, height in millimetres — integers, no float rounding surprises in BMI.

**Once `status = SIGNED`, the row is immutable.** Enforce in the service layer *and* with a Postgres trigger rejecting updates to signed consultations, because the service layer is where mistakes live. Changes create an amendment row preserving before and after. See `05`.

## Prescription and dispensing

```
prescription       id, tenant_id, encounter_id, consultation_id, prescribed_by,
                   status, created_at
prescription_item  id, tenant_id, prescription_id, product_id,
                   dose, dose_unit, frequency, duration_days, quantity, route,
                   instructions, is_prn, status

dispense           id, tenant_id, branch_id, prescription_id, dispensed_by,
                   status, dispensed_at, notes
dispense_item      id, tenant_id, dispense_id, prescription_item_id,
                   product_id, batch_id, quantity, is_substitute,
                   substitute_reason
```

Deliberate separation: prescribing is a clinical act, dispensing is a physical one. They differ in quantity (partial dispense), in product (substitution) and in time. Collapsing them into one table makes stock wrong.

**Stock moves on dispense, never on prescribe.**

## Inventory

```
product        id, tenant_id, sku, name, generic_name, type, category,
               form, strength, unit, is_controlled,
               default_selling_price, min_stock, reorder_level, status
product_batch  id, tenant_id, branch_id, product_id, batch_no, expiry_date,
               cost_price, selling_price, quantity_on_hand, received_at
stock_movement id, tenant_id, branch_id, product_id, batch_id,
               type,        -- RECEIVE | DISPENSE | ADJUST | DAMAGE | EXPIRE | RETURN | TRANSFER
               quantity,    -- signed: +in, -out
               reference_type, reference_id,
               reason, performed_by, occurred_at
```

### The stock invariant

> For every batch: `quantity_on_hand` = `SUM(stock_movement.quantity)` for that batch.

The ledger is truth; `quantity_on_hand` is a cache that exists so the dispensing screen is fast. Rules:

1. Every write updates both **in the same transaction**. No exceptions, ever.
2. Lock the batch row (`SELECT ... FOR UPDATE`) before decrementing — two dispensers working the same fast-moving medicine at once is an ordinary Tuesday, not an edge case.
3. `CHECK (quantity_on_hand >= 0)` so the database refuses to go negative even if the code tries.
4. A nightly job recomputes from the ledger and alerts on any mismatch. If it ever fires, you have a bug, and you want to know that week rather than at the annual stock count.

### FEFO

Suggest the batch with the earliest expiry that has stock, at the same branch. Suggest — the dispenser can override, because physical reality sometimes disagrees with the database, and the override is recorded.

## Procedures

```
procedure_catalog    id, tenant_id, code, name, category, default_price, status
procedure_consumable id, tenant_id, procedure_id, product_id, quantity
encounter_procedure  id, tenant_id, encounter_id, procedure_id, performed_by,
                     performed_at, notes, price
```

`procedure_consumable` drives automatic stock deduction — a nebuliser deducts the mask and the salbutamol respule without anyone remembering.

## Billing and payment

```
invoice       id, tenant_id, branch_id, encounter_id, patient_id, invoice_no,
              status,          -- DRAFT | ISSUED | PAID | PARTIAL | VOID
              subtotal, discount_total, tax_total, rounding_adjustment,
              grand_total, amount_paid, balance,
              issued_at, voided_at, void_reason, created_by
invoice_item  id, tenant_id, invoice_id, line_type,  -- CONSULTATION | MEDICINE | PROCEDURE | OTHER
              reference_type, reference_id, description,
              quantity, unit_price, discount_amount, line_total
payment       id, tenant_id, branch_id, invoice_id, method,
              amount, reference, received_by, received_at,
              voided_at, void_reason
```

Invariants worth a test each:
- `grand_total = subtotal - discount_total + tax_total + rounding_adjustment`
- `balance = grand_total - SUM(non-voided payments)`
- An `ISSUED` invoice is immutable. Corrections are a void plus a reissue, or a credit note in V1 — never an in-place edit
- `rounding_adjustment` is its own column so the receipt can show the 5-sen rounding as a line, which is what patients and auditors expect (`05`)

## Documents and audit

```
document   id, tenant_id, branch_id, patient_id, encounter_id?, type,
           document_no, storage_key, issued_by, issued_at, meta(jsonb)
audit_log  id, tenant_id, branch_id?, actor_id, action, entity_type, entity_id,
           before(jsonb), after(jsonb), ip, user_agent, occurred_at
```

`audit_log` is append-only: no update or delete grant for the application role. Partition by month once it grows — it will be the largest table in the database within a year.

## Forward compatibility

Not built in V0, but the V0 schema must not obstruct them:

- **Membership** → `membership`, `membership_plan`, `entitlement`, `benefit_usage`. Hangs off `patient`, applies discounts at `invoice_item`. Make sure `invoice_item.discount_amount` can record *why* it was discounted — add a nullable `discount_source` column in V0 so V1 does not need a data migration.
- **Panel/corporate** → `panel_provider`, `corporate_account`, `eligibility`, `claim`. Needs `invoice` to support a payer that is not the patient. Adding a nullable `payer_type` / `payer_id` to `invoice` now costs nothing and saves a painful migration later.
- **Purchasing** → `supplier`, `purchase_order`, `goods_receipt`. Plugs into `stock_movement` as a new `reference_type`. No change needed.
- **Appointments** → `appointment` referencing `patient` and `branch`, linking to `encounter` on check-in. No change needed.

Those two nullable columns — `discount_source` and `payer_type`/`payer_id` — are the only forward-looking additions worth making now. Everything else can wait.
