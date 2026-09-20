# Delivery Plan

## Assumptions

- One developer, **10–15 hours per week**
- Estimates assume AI-assisted development throughout — they are not padded for it, they already account for it
- Estimates are in focused hours and exclude the pilot clinic's own time
- A real clinic is waiting, so every phase ends in something they can actually use

**Headline:** full V0 is roughly **420–460 hours**. At 12 h/week that is about **8 months**; at 15 h/week about **7**.

That number is uncomfortable, and it is the honest one. The response to it is not to work faster — it is the release structure below, which puts working software in the clinic's hands at **week ~11** rather than month 8, and keeps a feedback loop running for the whole build.

---

## Release structure

Four releases the clinic adopts one at a time. Each replaces something they do today, so each has to be better than the paper it replaces.

| Release | Phase | What the clinic gets | Cumulative |
|---|---|---|---|
| — | 0 | Nothing visible. Foundations. | ~55 h |
| **R1** | 1 | Patient registry + live queue board | ~130 h |
| **R2** | 2 | Doctors document consultations in the system | ~215 h |
| **R3** | 3 | Pharmacy dispenses, stock is real | ~310 h |
| **R4** | 4 | Billing, payment, receipts — full V0 | ~395 h |
| **Go-live** | 5 | Hardened, backed up, trained, paper retired | ~440 h |

---

## Phase 0 — Foundations · ~55 h

No user-visible output. This is the phase that is tempting to rush and expensive to redo.

- Prisma + Postgres wired up, Docker Compose for local
- **Tenant/branch schema and RLS**, with the isolation test suite green (`03`)
- The generated "every table has RLS forced" test
- Auth: login, session, password reset, Argon2id
- `TenantContext`, guards, the `withTenant` transaction wrapper
- Role guard with the four V0 roles
- Audit log module, working, with an interceptor
- Money utilities: sen arithmetic, rounding rules, formatting — with tests
- UUID v7 ids, error format, validation pipeline, pagination
- App shell: login, layout, navigation, branch switcher
- CI: lint, typecheck, test against real Postgres
- Staging environment deployed
- **Backup + restore, rehearsed once**

**Done when:** you can log in on staging, the isolation tests pass, an audited action appears in the log, and you have restored the database from a backup with a stopwatch running.

---

## Phase 1 — Registry and Queue · ~75 h → **R1**

- Patient: register, edit, fast search, profile
- Allergies and chronic conditions
- Duplicate detection at registration
- Encounter creation (walk-in), queue numbers
- State machine with enforced transitions
- Queue boards: reception, per-station
- SSE live updates
- Waiting-room display screen
- Patient visit history
- Import the clinic's existing patient list (see `07`)

**Done when:** the clinic runs a full day's queue on the system, in parallel with their current process.

**Why this first:** it is the only slice that is genuinely useful standalone. A queue board and a searchable patient list replace a whiteboard and a filing cabinet, with no dependency on anything else being built. It also gets real data in early, which surfaces the messy reality of their patient records while there is still time.

---

## Phase 2 — Clinical · ~85 h → **R2**

- Triage vitals with abnormal flagging
- Consultation workspace — the highest-value UI in the product, budget accordingly
- SOAP notes, chief complaint, history, examination
- Diagnosis, with ICD-10 lookup if a usable list is cheaply available
- Draft autosave to server
- Sign and lock, with the trigger-level enforcement
- Amendments with mandatory reason
- Previous consultation history inline
- Clinical templates for the clinic's common presentations
- MC and referral letter PDFs on clinic letterhead
- Prescription entry, allergy and duplicate warnings
- Prescription printout

**Done when:** a doctor completes a full clinic session without touching paper notes, and signed records provably cannot be edited.

**Watch for:** this is where doctor adoption succeeds or fails. If documenting in the system is slower than writing on a card, it will not be used, and no amount of other functionality rescues that. Sit with the doctor for a session and time it.

---

## Phase 3 — Pharmacy and Inventory · ~95 h → **R3**

Largest phase, and the one with the most invariants to get right.

- Product catalogue with generic names and classes
- Batch management, expiry
- Stock movement ledger with the transactional invariant (`04`)
- Row locking on batch decrement
- Nightly reconciliation job with alerting
- Opening stock count entry — plan a weekend with the clinic
- Manual stock-in, adjustments with reasons
- Pharmacy queue and dispensing screen
- FEFO suggestion with override
- Partial dispense, substitution
- Medication label printing
- Low stock and expiry alerts
- Procedure catalogue with consumable auto-deduction

**Done when:** stock on hand in the system matches a physical count after a week of live dispensing.

**Watch for:** the opening stock count is a real logistical exercise for the clinic, not a data entry task. Schedule it deliberately, ideally over a closed day.

---

## Phase 4 — Billing and Payment · ~85 h → **R4**

- Invoice assembly from consultation, medicines, procedures
- Line and invoice discounts, with `discount_source` recorded
- Gapless invoice numbering under concurrency
- Cash and DuitNow QR recording
- 5-sen cash rounding, shown as its own line
- Split and partial payment
- Receipt printing
- Void with reason, fully audited
- End-of-day cash reconciliation
- Daily sales, patient count, payment-method breakdown
- Low stock / expiring stock reports

**Done when:** a full day's takings reconcile exactly against the drawer, three days running.

---

## Phase 5 — Hardening and Go-Live · ~45 h

- Work the `05` compliance checklist to completion
- Load test against a realistic busy day
- Error tracking and uptime monitoring
- Performance pass on patient search and the queue board
- Paper fallback process, written and agreed
- Staff training, by role
- Go-live weekend, on-site
- Two weeks of hypercare

---

## Sequencing rules

1. **Never start a phase with the previous one unstable in the clinic.** Bug reports from live use outrank new features, always.
2. **Phase 0 does not get compressed.** Everything after it is cheaper because of it.
3. **One clinic day of shadowing per phase**, before you build it. Watching a receptionist work for two hours will change your design more than a week of thinking.
4. **Cut features, not quality gates.** If a phase runs long, drop scope from it. Do not drop the tests on stock arithmetic or money.

## Keeping the estimate honest

Re-estimate at the end of each phase using your own measured velocity. Two phases in, you will know your real hours per week and your real throughput, and the projection will be worth more than this one. Track actual hours per phase from day one — it is five minutes a week and it makes every later estimate defensible.

If after Phase 2 the trajectory says twelve months rather than eight, the lever is scope: front desk can keep using their existing POS through R3, and R4 can slip, as long as the clinic knows that is the plan and agreed to it.
