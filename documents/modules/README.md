# Module Specifications

One specification per module. Each is written to stand on its own: a developer (or a future you, eighteen months from now) should be able to open a single file and build the module from it without needing the conversation that produced it.

Scope decisions live in `../01-scope-and-roadmap.md`; sequencing and effort in `../06-delivery-plan.md`; the load-bearing designs in `../03-multi-tenancy.md` and `../04-data-model.md`. This folder is where the detail accumulates.

---

## Specification template

Every module follows the same structure so nothing gets forgotten and so cross-references land in predictable places.

| § | Section | What it must answer |
|---|---|---|
| 1 | Purpose & business value | Why this exists; what breaks in the clinic without it |
| 2 | Actors & permissions | Who uses it; a role × action matrix using the permission catalogue below |
| 3 | Functional requirements | Numbered, prioritised (Must / Should / Could), testable |
| 4 | Key workflows | Step-by-step, as the user experiences them |
| 5 | Data model | Every table this module owns: columns, types, constraints, indexes |
| 6 | State machines | Where an entity has a lifecycle |
| 7 | Business rules & invariants | Numbered, enforced, each with *where* it is enforced |
| 8 | API surface | Endpoints, permission required, idempotency, notes |
| 9 | Domain events | Emitted and consumed, from the event catalogue below |
| 10 | Audit events | What lands in the audit log |
| 11 | Screens & UX requirements | What the user sees; performance and keyboard expectations |
| 12 | Validation | Field-level rules |
| 13 | Non-functional requirements | Performance, availability, security, data |
| 14 | Edge cases & failure modes | The awkward cases, decided in advance |
| 15 | Compliance | PDPA, clinical, financial, regulatory hooks |
| 16 | Reporting outputs | What this module contributes to reporting |
| 17 | Acceptance tests | Given / When / Then scenarios that gate "done" |
| 18 | Migration & rollout | How this reaches the pilot clinic |
| 19 | Out of scope | Explicitly, with where each item goes |
| 20 | Open questions | Unanswered, with who answers |
| 21 | Definition of done | The checklist that closes the module |

Later-version modules (V2, V3) are specified to the same structure at lower depth — enough to fix boundaries and data-model consequences now, not enough to build from. They get deepened when their version is next.

---

## Conventions

### Requirement IDs

`<MODULE>-<TYPE>-<NN>` — e.g. `INV-F-07`, `BIL-R-03`, `PAT-T-12`.

| Type | Meaning |
|---|---|
| `F` | Functional requirement |
| `R` | Business rule / invariant |
| `N` | Non-functional requirement |
| `T` | Acceptance test |
| `Q` | Open question |

Module codes: `IAM` `TEN` `PAT` `ENC` `TRI` `CON` `RX` `DSP` `INV` `PRC` `BIL` `PAY` `DOC` `AUD` `RPT` · `MEM` `PNL` `APT` `PUR` `EIV` `FIN` `NTF` `ADM` `RBC` · `BRN` `LOY` `WLT` `PKG` `HR` `DRM` `PPT` `LAB` `ANL` · `MOB` `TEL` `INT` `API` `SEC`

### Priority

- **Must** — the module is not done without it
- **Should** — expected in the same version; may slip to the next release within the version
- **Could** — take it if cheap, otherwise defer

### Status workflow

`Not started` → `Spec'd` (open questions answered, DoD written) → `In progress` → `Shipped` (on staging, tests green) → `Live in clinic` (in daily use, hypercare over)

### Data conventions (from `../04-data-model.md`)

UUID v7 primary keys · `snake_case` columns · money as `BIGINT` sen · `timestamptz` UTC · `tenant_id NOT NULL` on every table · `branch_id` where physical · soft delete via `deleted_at` on patient-facing rows · every table `created_at`, `updated_at`, `created_by`, `updated_by` unless append-only.

The column lists in each spec omit those standard columns for brevity. They are always present.

---

## Permission catalogue

Permissions are strings checked at the API layer. V0 maps them to four fixed roles; V1's `RBC` module makes the mapping configurable per tenant.

| Permission | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `patient.read` | ✓ | ✓ | ✓ | ✓ |
| `patient.write` | ✓ | ✓ | ✓ | ✓ |
| `patient.unmask_id` | ✓ | ✓ | – | ✓ |
| `patient.merge` | ✓ | – | – | – |
| `patient.export` | ✓ | – | – | – |
| `encounter.create` | ✓ | ✓ | ✓ | ✓ |
| `encounter.transition` | ✓ | ✓ | ✓ | ✓ |
| `encounter.cancel` | ✓ | ✓ | – | ✓ |
| `encounter.priority` | ✓ | ✓ | ✓ | ✓ |
| `triage.write` | ✓ | ✓ | ✓ | – |
| `clinical.read` | ✓* | ✓ | ✓ | – |
| `clinical.write` | – | ✓ | – | – |
| `clinical.sign` | – | ✓ | – | – |
| `clinical.amend` | – | ✓ | – | – |
| `rx.write` | – | ✓ | – | – |
| `rx.override_warning` | – | ✓ | – | – |
| `dispense.perform` | ✓ | ✓ | ✓ | ✓ |
| `dispense.substitute` | ✓ | ✓ | – | ✓ |
| `dispense.cancel` | ✓ | ✓ | – | – |
| `stock.read` | ✓ | ✓ | ✓ | ✓ |
| `stock.receive` | ✓ | – | ✓ | ✓ |
| `stock.adjust` | ✓ | – | – | – |
| `stock.count` | ✓ | – | ✓ | ✓ |
| `catalogue.write` | ✓ | – | – | – |
| `procedure.order` | – | ✓ | – | – |
| `procedure.perform` | ✓ | ✓ | ✓ | – |
| `invoice.read` | ✓ | ✓ | – | ✓ |
| `invoice.issue` | ✓ | – | – | ✓ |
| `invoice.discount` | ✓ | – | – | ✓† |
| `invoice.void` | ✓ | – | – | – |
| `payment.take` | ✓ | – | – | ✓ |
| `payment.void` | ✓ | – | – | – |
| `eod.close` | ✓ | – | – | ✓ |
| `document.issue` | ✓ | ✓ | – | ✓ |
| `document.reprint` | ✓ | ✓ | ✓ | ✓ |
| `audit.read` | ✓ | – | – | – |
| `report.operational` | ✓ | ✓ | ✓ | ✓ |
| `report.financial` | ✓ | – | – | – |
| `admin.users` | ✓ | – | – | – |
| `admin.settings` | ✓ | – | – | – |

\* ADMIN clinical read is **break-glass**: allowed, but every access is audited and surfaced on the audit dashboard. Tenants may disable it in V1.
† FRONTDESK discount is capped by a tenant setting (`billing.max_discount_pct_frontdesk`, default 10%). Above the cap requires ADMIN.

A user has permissions **per branch** via `user_branch_role`. The check is always `(user, branch, permission)`.

---

## Domain event catalogue

Events are emitted after the owning transaction commits, carry `{ tenantId, branchId, actorId, occurredAt, payload }`, and in V0 are dispatched in-process. V1 (`NTF`) moves them onto a durable queue. Names are stable contracts — renaming one is a breaking change.

| Event | Emitted by | Consumed by (V0) | Consumed by (later) |
|---|---|---|---|
| `user.created` `user.disabled` `user.role_changed` | IAM | AUD | NTF |
| `auth.login` `auth.login_failed` `auth.logout` `session.revoked` | IAM | AUD | SEC |
| `branch.created` `branch.updated` | TEN | AUD | — |
| `patient.registered` `patient.updated` `patient.merged` | PAT | AUD | NTF, PPT |
| `patient.allergy_added` `patient.allergy_removed` | PAT | AUD, RX | — |
| `encounter.created` | ENC | AUD, RPT | — |
| `encounter.status_changed` | ENC | AUD, RPT, queue SSE | ANL, NTF |
| `encounter.completed` `encounter.cancelled` | ENC | AUD, RPT | MEM, LOY, NTF |
| `triage.recorded` | TRI | AUD, ENC | — |
| `triage.abnormal_flagged` | TRI | AUD, CON (banner) | NTF |
| `consultation.signed` | CON | AUD, ENC, DOC | — |
| `consultation.amended` | CON | AUD, DOC | — |
| `prescription.created` `prescription.updated` | RX | AUD, DSP (queue) | — |
| `prescription.warning_overridden` | RX | AUD | ANL |
| `dispense.completed` `dispense.partial` `dispense.cancelled` | DSP | AUD, INV, BIL, ENC | — |
| `stock.moved` | INV | AUD, RPT | ANL, PUR |
| `stock.low` `stock.expiring` | INV | RPT (dashboard) | NTF, PUR |
| `stock.reconciliation_mismatch` | INV | AUD, alerting | — |
| `procedure.performed` | PRC | AUD, INV, BIL | — |
| `invoice.issued` `invoice.voided` | BIL | AUD, RPT, PAY | EIV, FIN, MEM |
| `payment.received` `payment.voided` | PAY | AUD, BIL, ENC, RPT | FIN, LOY, WLT |
| `eod.closed` | PAY | AUD, RPT | FIN |
| `document.issued` | DOC | AUD | — |
| `membership.activated` `membership.renewed` `membership.expired` `membership.suspended` | MEM | — | AUD, NTF, BIL |
| `benefit.consumed` | MEM | — | AUD, RPT |
| `claim.submitted` `claim.status_changed` | PNL | — | AUD, FIN, NTF |
| `appointment.booked` `appointment.rescheduled` `appointment.cancelled` `appointment.reminder_due` | APT | — | AUD, NTF, ENC |
| `po.approved` `goods.received` | PUR | — | AUD, INV |
| `einvoice.submitted` `einvoice.accepted` `einvoice.rejected` | EIV | — | AUD, FIN |
| `notification.queued` `notification.sent` `notification.failed` | NTF | — | AUD |

---

## Module map

### V0 — Clinic-usable core

The cut line: *can a patient walk in, be seen, get medicine, pay, and leave — entirely in the system?* Everything here is required for that sentence to be true.

| Module | Code | Phase | Est. | Status |
|---|---|---|---|---|
| [Identity & Access](v0-01-identity-access.md) | IAM | 0 | ~20 h | In progress |
| [Tenancy & Branch](v0-02-tenancy-branch.md) | TEN | 0 | ~20 h | Part-built by IAM |
| [Audit Trail](v0-14-audit-trail.md) | AUD | 0 | ~15 h | Part-built by IAM |
| [Patient Registry](v0-03-patient.md) | PAT | 1 | ~35 h | Not started |
| [Encounter & Queue](v0-04-encounter-queue.md) | ENC | 1 | ~40 h | Not started |
| [Triage](v0-05-triage.md) | TRI | 2 | ~10 h | Not started |
| [Consultation / EMR](v0-06-consultation.md) | CON | 2 | ~45 h | Not started |
| [Prescription](v0-07-prescription.md) | RX | 2 | ~20 h | Not started |
| [Documents](v0-13-documents.md) | DOC | 2 | ~10 h | Not started |
| [Inventory](v0-09-inventory.md) | INV | 3 | ~45 h | Not started |
| [Dispensing](v0-08-dispensing.md) | DSP | 3 | ~35 h | Not started |
| [Procedures](v0-10-procedures.md) | PRC | 3 | ~15 h | Not started |
| [Billing](v0-11-billing.md) | BIL | 4 | ~40 h | Not started |
| [Payment](v0-12-payment.md) | PAY | 4 | ~25 h | Not started |
| [Reporting & Dashboard](v0-15-reporting-dashboard.md) | RPT | 4 | ~20 h | Not started |

**Part-built by IAM** means the parts identity needed exist and are tested — for
`TEN`, the tenant and branch tables, request scoping and branch switching; for
`AUD`, the append-only table, the write path with redaction, and the two read
endpoints behind the admin dashboard. Each module's own specification still
stands; picking it up means finishing it, not starting it.

The database is PostgreSQL 16, as the planning documents assume. It went via
MySQL for a day; [`../decisions/adr-0002-postgres.md`](../decisions/adr-0002-postgres.md)
records the move and the PostgreSQL semantics that changed the code.

**V0 total ~395 h**, plus ~45 h Phase 5 hardening = **~440 h**. At 12 h/week, roughly 8 months.

### V1 — Commercially sellable

| Module | Code | Est. | Status |
|---|---|---|---|
| [Membership & Benefits](v1-01-membership.md) | MEM | ~70 h | Not started |
| [Panel & Corporate](v1-02-panel-corporate.md) | PNL | ~80 h | Not started |
| [Appointments](v1-03-appointments.md) | APT | ~50 h | Not started |
| [Supplier & Purchasing](v1-04-supplier-purchasing.md) | PUR | ~55 h | Not started |
| [e-Invoice (MyInvois)](v1-05-einvoice-myinvois.md) | EIV | ~50 h | Not started |
| [Finance](v1-06-finance.md) | FIN | ~60 h | Not started |
| [Notifications](v1-07-notifications.md) | NTF | ~45 h | Not started |
| [Admin & Settings](v1-08-admin-settings.md) | ADM | ~40 h | Not started |
| [Advanced RBAC](v1-09-rbac-advanced.md) | RBC | ~35 h | Not started |

### V2 — Multi-branch and scale

| Module | Code | Est. | Status |
|---|---|---|---|
| [Multi-Branch Operations](v2-01-multi-branch.md) | BRN | ~70 h | Not started |
| [Loyalty & Rewards](v2-02-loyalty-rewards.md) | LOY | ~50 h | Not started |
| [Patient Wallet](v2-03-patient-wallet.md) | WLT | ~35 h | Not started |
| [Packages](v2-04-packages.md) | PKG | ~40 h | Not started |
| [Staff & HR](v2-05-staff-hr.md) | HR | ~80 h | Not started |
| [Doctor Management](v2-06-doctor-management.md) | DRM | ~35 h | Not started |
| [Patient Portal](v2-07-patient-portal.md) | PPT | ~90 h | Not started |
| [Lab Integration](v2-08-lab-integration.md) | LAB | ~60 h | Not started |
| [Advanced Analytics](v2-09-analytics-reporting.md) | ANL | ~50 h | Not started |

### V3 — Platform

| Module | Code | Est. | Status |
|---|---|---|---|
| [Mobile Apps](v3-01-mobile-apps.md) | MOB | — | Not started |
| [Telemedicine](v3-02-telemedicine.md) | TEL | — | Not started |
| [Integration Layer](v3-03-integration-layer.md) | INT | — | Not started |
| [Public API](v3-04-public-api.md) | API | — | Not started |
| [Advanced Security](v3-05-security-advanced.md) | SEC | — | Not started |

---

## Dependency graph (V0)

```
IAM ──┬── TEN ──── AUD
      │            │
      └──── PAT ───┼─── ENC ─── TRI
                   │     │
                   │     └───── CON ─── RX ─── DSP ─── INV
                   │                    │       │       │
                   │                    DOC     └───────┼─── PRC
                   │                                    │
                   └──────────────────────── BIL ◄──────┘
                                              │
                                             PAY ─── RPT
```

Build order in `../06-delivery-plan.md` is a valid topological sort of this graph. Deviate deliberately, not accidentally.

---

## How to use these

Pick one module. Before writing code:

1. **Answer its §20 open questions.** Most need the pilot clinic — batch them (`../08-open-questions.md`).
2. **Shadow the clinic** doing that job for an hour. It will change the design more than a week of thinking.
3. **Confirm §21, the definition of done,** before you start. Add to it if the module has grown.
4. **Keep the spec current as you build.** When a decision changes, change the spec in the same commit. A spec that disagrees with the code is worse than no spec.
5. Update the status column above when the status changes.
