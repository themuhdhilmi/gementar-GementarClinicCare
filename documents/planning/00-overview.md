# Gementar ClinicCare — Planning Overview

**Status:** planning draft, 2026-09-20
**Context:** solo developer, nights and weekends · real pilot clinic committed · tenant-aware from day one · shipping a V0 before the spec's V1

---

## The product

A complete clinic operating platform — not a POS with notes bolted on, and not an EMR with a cash drawer bolted on. One patient record and one workflow spanning:

> Reception → Triage → Doctor → Pharmacy → Payment → Inventory → Finance → Staff → Membership → HQ

The original brief describes 50 areas. That brief is the **destination**, and it is a good one. These documents are about the **route**, which is a different problem and the one that actually decides whether this ships.

## The central constraint

One developer, roughly 10–15 hours a week, with a live clinic waiting. Everything in this plan follows from that:

1. **Scope is the only real lever.** At this pace the spec's V1 (21 modules) is well over a year of evenings. V0 is defined in `01-scope-and-roadmap.md` as the smallest system a clinic can genuinely run on, and it is still the largest piece of work here.
2. **Ship in increments the clinic adopts one at a time.** A big-bang go-live, run by one person, against a clinic that has patients in the waiting room, is the single most likely way this ends badly. The delivery plan breaks V0 into four releases the clinic puts into real use as they land.
3. **Get the irreversible decisions right now, and defer everything else.** Tenancy, money representation, clinical record immutability and the stock ledger are extremely expensive to change once real patient data exists. Appointment scheduling, loyalty points and WhatsApp integration are not. Spend the early thinking on the first group.
4. **Boring infrastructure.** One Postgres, one Node process, one VPS, Docker Compose. No Kubernetes, no microservices, no Redis until something actually needs a queue. Every moving part is a thing you maintain alone at 11pm.

## What is in this folder

| Document | What it decides |
|---|---|
| `01-scope-and-roadmap.md` | What V0 is, what is deliberately cut, how the 50 areas map onto V0/V1/V2/V3 |
| `02-architecture.md` | Stack, module boundaries, realtime, deployment, backups |
| `03-multi-tenancy.md` | Tenant and branch scoping, Postgres RLS, the Prisma pitfalls, how it gets tested |
| `04-data-model.md` | Core entities, the invariants that must never break, encounter state machine |
| `05-safety-and-compliance.md` | Record integrity, audit trail, PDPA, allergy checks, money and rounding, printing |
| `06-delivery-plan.md` | Phases, effort estimates, release gates |
| `07-pilot-and-risks.md` | Rollout with the pilot clinic, top risks, spikes to run early |
| `08-open-questions.md` | Decisions still needed, from you and from the clinic |
| `09-database-roles.md` | Runbook: splitting the application's database account from the owner of its tables (TEN-F-12) |
| `10-production-readiness.md` | What stops real patients being seen on this, and what does not. One cut across all fifteen module registers |

## How to use these

`08-open-questions.md` is a living checklist — work through it with the clinic before Phase 1 code. `04-data-model.md` and `03-multi-tenancy.md` are the two to get right before the first migration. The rest can flex.

Read `07-pilot-and-risks.md` early even though it sits late in the list. The risks it names (printing, stock concurrency, internet outage at the clinic) are the ones that tend to be discovered too late.

## The bet

The defensible thing here is **not** any single module. Competitors exist for clinic POS, for EMR, for inventory. The bet is that one coherent record and one workflow across the whole clinic day — plus membership and multi-branch HQ, which most Malaysian clinic software handles poorly — is worth switching for.

That bet only pays off if the core loop is genuinely excellent. Which is another argument for a narrow V0: a clinic forgives a missing loyalty module, and never forgives a dispensing screen that loses a prescription.
