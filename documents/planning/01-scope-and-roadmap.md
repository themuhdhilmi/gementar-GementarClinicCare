# Scope and Roadmap

## The cut line

Your spec lists V1 as 21 modules. Built alone at 10–15 hours a week, that is realistically 12–18 months before the clinic sees anything. That is too long to go without real-world feedback, and too long for the pilot clinic to stay enthusiastic.

**V0 is therefore defined by a single test:**

> Can a patient walk in the door, be seen, get their medicine, pay, and leave — entirely in the system, with nothing kept on paper alongside it?

Anything required for that sentence to be true is in. Anything not required is out, regardless of how valuable it is. Membership is the clearest example: it is central to the product vision and it is genuinely a differentiator, but a clinic can operate for a month without it. It is V1.

---

## V0 — "One patient, door to door"

### Foundations
- Email + password auth, session management, password reset
- Four roles to start: `ADMIN`, `DOCTOR`, `NURSE`, `FRONTDESK` (front desk covers reception, dispensing and cashier in a small clinic — confirm with the pilot, see `08`)
- Tenant and branch tables, RLS enforced, even though the pilot uses one of each
- Audit log from the first feature, not retrofitted

### Patient
- Register with IC / passport / phone
- Fast search — this screen is used more than any other in the clinic, treat it as a first-class piece of work
- Demographics, contact, emergency contact
- **Allergies** — in V0, because prescribing without them is a safety problem
- Chronic conditions (simple list)
- Visit history

### Encounter and queue
- Walk-in registration creating an encounter
- Explicit encounter state machine (`04-data-model.md`)
- Live queue board per station, updating over SSE
- Waiting-room display screen

### Triage
- Vitals: BP, HR, temp, SpO2, weight, height, auto-BMI, glucose
- Abnormal-value flagging (static thresholds, no cleverness)
- Nurse notes

### Consultation
- Chief complaint, history, examination, SOAP notes
- Diagnosis — free text plus optional ICD-10 lookup if a usable code list is available cheaply; do not block on this
- Previous consultation history visible inline
- **Draft → signed → locked**, with amendments instead of edits (`05-safety-and-compliance.md`)

### Prescription
- Medicine search against the clinic's own catalogue
- Dose, frequency, duration, quantity, route, instructions, PRN
- Allergy warning and duplicate-medicine warning
- *Not* drug–drug interaction checking — that needs a licensed database, see V2

### Dispensing
- Pharmacy queue
- FEFO batch selection, suggested automatically, overridable
- Stock deducts **only on dispense**, never on prescribe
- Medication label printing
- Partial dispense

### Inventory
- Products: medicines and consumables
- Batches with expiry, cost and selling price
- Append-only stock movement ledger
- Manual stock-in and stock adjustment with reason
- Low-stock and expiry alerts

### Procedures
- Small catalogue: injection, nebuliser, dressing, vaccination
- Consumables auto-deducted
- Who performed it

### Billing and payment
- Invoice assembled from consultation fee, medicines, procedures
- Line and invoice level discount
- Cash and DuitNow QR (record it; gateway integration is V1)
- Malaysian 5-sen cash rounding (`05-safety-and-compliance.md`)
- Receipt printing
- Void with reason, fully audited

### Documents
- MC, referral letter, prescription printout, receipt
- Clinic letterhead

### Reporting
- Daily patient count
- Daily sales by payment method
- End-of-day cash reconciliation
- Low stock and expiring stock

That is V0. It is not small — it is the floor.

---

## Deliberately cut from V0, and why

| Cut | Why it can wait |
|---|---|
| **Appointment scheduling** | Malaysian GP clinics are heavily walk-in. Confirm with the pilot (`08`) — if they run appointments today, this moves into V0 and something else moves out. |
| **Membership and benefits** | Core to the product, not to clinic operations. First thing in V1. |
| **Panel / corporate billing** | High value and high complexity (eligibility, limits, claims, statements). Needs its own design pass. Ask the pilot what share of their patients are panel — if it is large, this is V1's first item instead of membership. |
| **Loyalty, wallet, packages** | Pure additions, zero coupling to the core loop. |
| **Supplier and purchase orders** | Manual stock-in covers a single clinic. Matters when branches and central purchasing arrive. |
| **e-Invoice / MyInvois** | Confirm the clinic's obligation and deadline (`08`) — if they are already in scope, this is V1's top priority. |
| **HR, roster, attendance, commission** | Entirely separate from the patient journey. |
| **Patient portal, mobile app, telemedicine, lab, FHIR** | Later-stage. |
| **Drug interaction checking** | Requires a licensed clinical database with real recurring cost. |
| **Multi-branch operations** | Schema is branch-aware from day one; the *features* (transfer, HQ consolidation, branch pricing) wait for a second branch to actually exist. |

---

## Roadmap

### V0 — Clinic-usable core
Everything above. Four incremental releases, see `06-delivery-plan.md`.

### V1 — Commercially sellable
The point where this is sellable to clinics other than the pilot.
- Membership: plans, individual/family/corporate, benefits, entitlement tracking, renewal
- Panel and corporate billing, claims
- Appointment scheduling and reminders
- Supplier, purchase orders, goods receiving
- e-Invoice / MyInvois
- Payment gateway and DuitNow integration
- Finance: receivables, payables, expenses, profit reporting
- WhatsApp and SMS notifications
- Fuller RBAC with custom roles and granular permissions
- Tenant self-service onboarding, plans, module toggles

### V2 — Multi-branch and scale
- Stock transfer, central purchasing, branch pricing
- HQ consolidated reporting
- Loyalty, wallet, packages
- HR: roster, attendance, leave, locum, commission
- Online booking and patient portal
- Lab integration
- Advanced analytics

### V3 — Platform
- Patient and doctor mobile apps
- Telemedicine
- Accounting and payroll integration
- FHIR and public API, webhooks, API keys
- Clinical decision support, drug interactions
- AI assistance for documentation

---

## Mapping your 50 sections

| Sections | Lands in |
|---|---|
| 1, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13 (cash/QR only), 20, 29 (fixed roles), 30, 31, 32 (basic), 33 (basic), 42, 43, 44, 45 | **V0** |
| 2, 10, 14, 15, 16, 21, 22, 27 (self-serve), 28, 29 (full), 34 | **V1** |
| 17, 18, 19, 23, 24, 25, 26, 35, 37 | **V2** |
| 36, 38, 39, 40, 41 (advanced) | **V3** |
| 49, 50 | Ongoing, business rather than build |

Sections 41 (security) and 42 (architecture) are not phased — they are constraints applied throughout.
