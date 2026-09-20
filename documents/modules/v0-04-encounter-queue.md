# Encounter & Queue (ENC)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 1 |
| **Spec sections** | 3, 4, 45 |
| **Depends on** | IAM, TEN, AUD, PAT |
| **Depended on by** | TRI, CON, RX, DSP, PRC, BIL, PAY, DOC, RPT, APT |
| **Est. effort** | ~40 h |

---

## 1. Purpose & business value

An **encounter** is one visit. It is the spine the whole clinic day hangs from: every vital sign, note, prescription, dispense, procedure and invoice belongs to exactly one encounter. The **queue** is the encounter's position in the clinic's physical flow, made visible to every station in real time.

Replacing the whiteboard and the shouted queue number is the first thing the pilot clinic will use. It has to be faster and more reliable than what it replaces from the first hour, or the whiteboard comes back.

## 2. Actors & permissions

| Actor | Uses ENC to |
|---|---|
| FRONTDESK | Check in, assign doctor/room, set priority, cancel, mark no-show, view all queues |
| NURSE | Call next for triage, move to doctor-waiting, view queues |
| DOCTOR | Call next patient, start/end consultation, route to pharmacy/payment |
| Dispenser (FRONTDESK in V0) | Pharmacy queue |
| Cashier (FRONTDESK in V0) | Payment queue, complete |
| Waiting-room display | Read the public queue (no login) |

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `encounter.create` | ✓ | ✓ | ✓ | ✓ |
| `encounter.transition` (own station's transitions) | ✓ | ✓ | ✓ | ✓ |
| `encounter.cancel` / no-show | ✓ | ✓ | – | ✓ |
| `encounter.priority` | ✓ | ✓ | ✓ | ✓ |
| Assign / reassign doctor, room | ✓ | ✓ | ✓ | ✓ |
| Force any transition (recovery) | ✓ | – | – | – |
| View any queue | ✓ | ✓ | ✓ | ✓ |

## 3. Functional requirements

### Encounter lifecycle
| ID | Requirement | Priority |
|---|---|---|
| ENC-F-01 | Check in a patient at a branch → encounter with type `WALK_IN`, status `REGISTERED`, timestamp, registering user, and a queue number. One click from the patient record. | Must |
| ENC-F-02 | Encounter number per branch per day: `<BRANCHCODE>-<YYYYMMDD>-<seq>`; queue number is the display form (`A-012`, configurable prefix per branch/priority). | Must |
| ENC-F-03 | Status follows the state machine in §6. Every transition is validated centrally; invalid transitions are rejected with the current state and allowed next states. | Must |
| ENC-F-04 | Every transition writes an `encounter_event` (from, to, actor, time, note) — append-only. | Must |
| ENC-F-05 | Optional triage: branch setting `queue.triage_required` (`ALWAYS`, `NEVER`, `OPTIONAL`). `OPTIONAL` lets FRONTDESK route straight to `DOCTOR_WAITING`. | Must |
| ENC-F-06 | Assign attending doctor at check-in or later; reassign with reason. "Any available" is a valid assignment — the next free doctor calls the patient. | Must |
| ENC-F-07 | Assign consultation room (from branch room list); doctor's current room prefilled. | Should |
| ENC-F-08 | Priority: `NORMAL`, `URGENT` (elderly, disabled, pregnant, clinical urgency), `EMERGENCY`. Priority sorts ahead within the same station queue; reason recorded. | Must |
| ENC-F-09 | Cancel (before consultation starts) with reason; no-show (patient absent when called, after configurable grace and ≥ 2 calls) — both terminal, both reversible by ADMIN within the day. | Must |
| ENC-F-10 | Encounter cannot reach `COMPLETED` while: consultation unsigned (if one exists), prescription has undispensed non-cancelled items (if `queue.require_dispense_before_complete`), or invoice balance > 0 (if `queue.require_payment_before_complete`). Defaults: all true. | Must |
| ENC-F-11 | Chart summary on the encounter: patient header, timeline of events, links to triage, consultation, prescription, dispense, invoice, documents. | Must |
| ENC-F-12 | Re-open a completed encounter within 24 h (ADMIN) for corrections; audited; re-closing re-validates ENC-F-10. | Should |
| ENC-F-13 | Multiple open encounters for the same patient at one branch are blocked; at different branches, warned. | Must |
| ENC-F-14 | Follow-up flag on completion with suggested date (feeds APT in V1; in V0 shows on patient record). | Should |

### Queues
| ID | Requirement | Priority |
|---|---|---|
| ENC-F-15 | Station queues derived from status: Reception (all open), Triage (`TRIAGE_WAITING`), Doctor (`DOCTOR_WAITING` filtered by assigned doctor or "any"), Pharmacy (`PHARMACY_WAITING`, `DISPENSING`), Cashier (`PAYMENT_WAITING`). | Must |
| ENC-F-16 | Queue ordering: priority desc, then time entered current status asc. Manual reorder is not supported (use priority). | Must |
| ENC-F-17 | "Call next" at a station: takes the head of that station's queue, marks `called_at`, increments `call_count`, emits an event the display screen uses to announce. | Must |
| ENC-F-18 | "Call again" and "Skip" (moves to the back with a `skipped` marker; after 2 skips FRONTDESK is prompted for no-show). | Must |
| ENC-F-19 | Live updates over SSE per branch: any status change, call, priority change, assignment change. Clients refetch the affected queue on event. | Must |
| ENC-F-20 | Waiting-room display: public page per branch (token in URL, rotatable), shows now-serving per room/station, last 5 called, a "please proceed to" line, optional announcement chime; large type readable at 6 m. | Must |
| ENC-F-21 | Queue statistics on each board: waiting count, longest wait, average wait today. | Should |
| ENC-F-22 | Board shows elapsed time in current status; rows turn amber at branch-configurable thresholds (default 30 min) and red at 60. | Should |
| ENC-F-23 | Patient privacy on the display: queue number and first name + initial only (branch setting: number only). | Must |

## 4. Key workflows

**Standard walk-in (triage always)**
1. FRONTDESK: search → check-in → queue number printed/shown → `REGISTERED` → auto `TRIAGE_WAITING`
2. NURSE: call next → `TRIAGE_IN_PROGRESS` → record vitals (TRI) → `DOCTOR_WAITING`
3. DOCTOR: call next → `IN_CONSULTATION` → sign consultation (CON) → route: meds → `PHARMACY_WAITING`; procedure → `PROCEDURE_WAITING`; else → `PAYMENT_WAITING`
4. Dispenser: call → `DISPENSING` → complete (DSP) → `PAYMENT_WAITING`
5. Cashier: issue invoice (BIL), take payment (PAY) → `COMPLETED`

**Payment-before-dispense variant** (branch setting `queue.payment_before_dispense = true`)
3′. Doctor signs → `PAYMENT_WAITING` → paid → `PHARMACY_WAITING` → dispensed → `COMPLETED`

**Patient absent when called**
1. Called twice, 5-minute grace → "Skip" → moves to back with marker
2. Third call absent → FRONTDESK prompted → `NO_SHOW` with note
3. Patient returns later same day → ADMIN/FRONTDESK reverts to `DOCTOR_WAITING` (audited)

**Emergency walk-in**
1. Check in with priority `EMERGENCY` → jumps to head of every queue; doctor boards flash the row

## 5. Data model

```
encounter
  id                  uuid pk
  tenant_id           uuid not null
  branch_id           uuid not null → branch
  patient_id          uuid not null → patient
  encounter_no        text not null            -- KL01-20260920-017
  queue_no            text not null            -- A-017
  type                enum(WALK_IN, APPOINTMENT, FOLLOW_UP, EMERGENCY) not null
  status              enum(...) not null       -- see §6
  priority            enum(NORMAL, URGENT, EMERGENCY) not null default 'NORMAL'
  priority_reason     text
  attending_doctor_id uuid → user              -- null = any available
  room_id             uuid → branch_room
  appointment_id      uuid → appointment       -- V1
  registered_by       uuid not null
  registered_at       timestamptz not null
  status_since        timestamptz not null     -- when current status was entered
  called_at           timestamptz
  call_count          int not null default 0
  skip_count          int not null default 0
  triage_at           timestamptz
  consultation_started_at timestamptz
  consultation_ended_at   timestamptz
  dispensed_at        timestamptz
  paid_at             timestamptz
  completed_at        timestamptz
  cancelled_at        timestamptz, cancel_reason text, cancelled_by uuid
  reopened_at         timestamptz, reopened_by uuid, reopen_reason text
  follow_up_due       date, follow_up_note text
  UNIQUE (tenant_id, encounter_no)
  INDEX (branch_id, status, priority, status_since)     -- queue boards
  INDEX (patient_id, registered_at desc)
  INDEX (branch_id, registered_at)                     -- daily reports
  INDEX (attending_doctor_id, status)

encounter_event   (append-only)
  id uuid pk, tenant_id, encounter_id → encounter
  from_status text, to_status text not null
  action      text not null          -- 'check_in','call','skip','transition','reassign','priority','cancel','no_show','reopen','force'
  actor_id    uuid, actor_name text
  note        text
  occurred_at timestamptz not null default now()
  INDEX (encounter_id, occurred_at)
  INDEX (tenant_id, occurred_at)     -- wait-time analytics

branch_room
  id uuid pk, tenant_id, branch_id, name text, code text, type enum(CONSULT, TRIAGE, PROCEDURE, OTHER), active bool

queue_sequence
  tenant_id, branch_id, date, prefix, next int   -- pk (tenant_id, branch_id, date, prefix); FOR UPDATE

display_token
  id uuid pk, tenant_id, branch_id, token_hash bytea unique, label text, created_at, revoked_at
```

## 6. State machines

```
                       ┌──────────────┐
  check-in ──────────► │  REGISTERED  │
                       └──────┬───────┘
          triage ALWAYS/OPT   │        triage NEVER / skip
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
 TRIAGE_WAITING ──call──► TRIAGE_IN_PROGRESS ──► DOCTOR_WAITING ◄──────────────┐
                                                     │ call                     │
                                                     ▼                          │ (revert no-show,
                                              IN_CONSULTATION                   │  admin)
                                                     │ sign                     │
            ┌────────────────────┬───────────────────┼──────────────────┐       │
            ▼                    ▼                   ▼                  ▼       │
   PROCEDURE_WAITING     PHARMACY_WAITING     PAYMENT_WAITING     (no charge)   │
            │ perform            │ call               │ paid            │       │
            ▼                    ▼                    │                 │       │
   PROCEDURE_DONE ──►     DISPENSING ──────►          │                 │       │
   (→ PHARMACY or PAYMENT)    │ complete              ▼                 ▼       │
                              └────────────►      COMPLETED ◄───────────┘       │
                                                                                │
  Any pre-consultation state ──cancel──► CANCELLED                              │
  DOCTOR_WAITING ──(3 calls absent)──► NO_SHOW ─────────────────────────────────┘
  COMPLETED ──reopen (admin, 24h)──► previous state
```

Ordering of `PHARMACY_WAITING` and `PAYMENT_WAITING` is swapped when `queue.payment_before_dispense` is on. Transitions are data-driven from one table in code (`ENCOUNTER_TRANSITIONS`), consulted by a single `transition(encounter, to, ctx)` function.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| ENC-R-01 | All status changes go through `EncounterService.transition()`; no direct status writes. | Service; `status` column excluded from generic update DTOs; DB trigger validates `(old,new)` against the transition table as backstop |
| ENC-R-02 | Every transition writes exactly one `encounter_event` in the same transaction. | Service |
| ENC-R-03 | `status_since` is updated on every transition. | Service |
| ENC-R-04 | Completion guards (ENC-F-10) are evaluated at transition time against live data, not cached flags. | Service |
| ENC-R-05 | Queue and encounter numbers are per branch per day and never reused that day. | `queue_sequence` with `FOR UPDATE` |
| ENC-R-06 | A patient has at most one open encounter per branch. | Partial unique index `(patient_id, branch_id) WHERE status NOT IN (COMPLETED, CANCELLED, NO_SHOW)` |
| ENC-R-07 | Queue ordering is deterministic from `(priority desc, status_since asc)`; no hidden manual ordering. | Query |
| ENC-R-08 | SSE events are invalidation signals; the client refetches. The event never carries enough to render from. | Client + server contract |
| ENC-R-09 | Cancellation is only possible before `IN_CONSULTATION`; after that, the encounter must complete or be force-handled by ADMIN. | Transition table |
| ENC-R-10 | The display page never shows full names, IDs or clinical info. | Display DTO |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/branches/:b/encounters` | `encounter.create` | `{ patientId, type, priority?, doctorId?, roomId? }` ⟳ via idempotency key |
| GET | `/branches/:b/encounters?status=&date=&doctorId=` | session | |
| GET | `/encounters/:id` | session | Chart summary |
| GET | `/encounters/:id/events` | session | Timeline |
| POST | `/encounters/:id/transition` | `encounter.transition` | `{ to, note? }` — validated |
| POST | `/encounters/:id/call` | `encounter.transition` | Station inferred from status |
| POST | `/encounters/:id/skip` | `encounter.transition` | |
| POST | `/encounters/:id/no-show` | `encounter.cancel` | |
| POST | `/encounters/:id/cancel` | `encounter.cancel` | Reason required |
| POST | `/encounters/:id/revert-no-show` | `encounter.cancel` | Same day |
| PATCH | `/encounters/:id/assignment` | `encounter.transition` | Doctor, room; reason if reassign |
| PATCH | `/encounters/:id/priority` | `encounter.priority` | Reason required for URGENT+ |
| POST | `/encounters/:id/reopen` | ADMIN + reauth | 24 h window |
| POST | `/encounters/:id/force-transition` | ADMIN + reauth | Recovery; reason; audited loudly |
| GET | `/branches/:b/queues/:station` | session | `station ∈ reception,triage,doctor,pharmacy,cashier`; `?doctorId=` |
| GET | `/branches/:b/queues/stream` | session | SSE |
| GET | `/branches/:b/queues/stats` | session | Today's counts, waits |
| GET | `/display/:token` | public | Display DTO (queue numbers only) |
| GET | `/display/:token/stream` | public | SSE for display |
| POST/DELETE | `/branches/:b/display-tokens[/:id]` | `admin.settings` | |
| CRUD | `/branches/:b/rooms` | `admin.settings` | |

## 9. Domain events

**Emits:** `encounter.created`, `encounter.status_changed` `{ from, to }`, `encounter.called`, `encounter.skipped`, `encounter.priority_changed`, `encounter.reassigned`, `encounter.completed`, `encounter.cancelled`, `encounter.no_show`, `encounter.reopened`
**Consumes:** `triage.recorded` (→ `DOCTOR_WAITING`), `consultation.signed` (→ route by orders), `procedure.performed`, `dispense.completed` (→ next), `payment.received` (balance 0 → next/complete), `invoice.voided` (re-evaluate)

## 10. Audit events

All §9 events. `encounter.force_transition` and `encounter.reopened` carry reason and are surfaced on the audit dashboard.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Reception queue | All open encounters at the branch, grouped by status, colour-coded; check-in button top-left; each row: queue no, patient (name, age/sex), doctor, room, status, elapsed; actions inline (assign, priority, cancel) |
| Station queue (triage / doctor / pharmacy / cashier) | Big "Call next" button; head of queue highlighted; rows: queue no, patient, priority badge, elapsed; keyboard: `Space` = call next, `S` = skip, `Enter` = open |
| Doctor queue | Filter: mine / any; "Start consultation" opens CON workspace directly |
| Encounter chart | Patient header; timeline; cards for each stage with status and link; completion checklist showing which guards are unmet |
| Waiting-room display | Full-screen, high contrast, 60+ px numerals; "Now serving" per room; last 5 called; chime on call (audio permission prompt once); auto-reconnect SSE; clock; branch name |
| Queue ticket | Optional printed slip on check-in: queue no, date, time, estimated wait (V1), branch name |

## 12. Validation

- `type` required; `EMERGENCY` type forces priority `EMERGENCY`
- `priority_reason` required for `URGENT`/`EMERGENCY`
- `cancel_reason` ≥ 3 chars
- Doctor assignment must be a user with DOCTOR role at the branch
- Room must be active and of type `CONSULT` for consultations
- Transition `to` must be in the allowed set for `(current, branch settings)`

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| ENC-N-01 | Queue board refresh after a transition visible on all clients ≤ 1 s on the clinic LAN. |
| ENC-N-02 | Check-in ≤ 200 ms server time; queue board query ≤ 100 ms at 300 encounters/day. |
| ENC-N-03 | SSE reconnects automatically with backoff; on reconnect the client refetches (no missed events). |
| ENC-N-04 | Display page runs unattended for 12 h without memory growth or reload; tested on the clinic's actual TV/browser. |
| ENC-N-05 | 500 concurrent SSE connections per process without degradation (well above any single-branch need). |
| ENC-N-06 | `encounter_event` retained indefinitely (analytics); partition by month at 5 M rows. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Doctor called the wrong patient | "Return to queue" reverts `IN_CONSULTATION` → `DOCTOR_WAITING` at original position (uses original `status_since`), only if no clinical data saved yet; otherwise the consultation is cancelled with reason. |
| Two staff click "Call next" simultaneously | Row lock on the head encounter; second caller gets the next one. |
| Patient wants to leave after consultation without meds/payment | Doctor/FRONTDESK marks prescription `DECLINED` (RX) and/or ADMIN records invoice as outstanding (PAY, balance > 0 allowed to complete with `queue.require_payment_before_complete` overridden by ADMIN, audited). |
| Network drops between stations | SSE reconnects and refetches; the queue is server-authoritative, so nothing is lost. |
| Clinic closes with encounters still open | End-of-day job at branch closing time + 2 h lists open encounters; FRONTDESK resolves (complete/cancel/no-show) before EOD close (PAY) is allowed. |
| Same patient at two branches same day | Allowed with warning (chain patient; e.g. referred). |
| Display token leaked | Rotate from admin; old token 404s immediately. |
| Emergency mid-consultation for another patient | Doctor's board flashes; doctor can "pause" the current consultation (`IN_CONSULTATION` stays; new encounter opened in parallel; ENC-F-13 allows because it's a different patient). One doctor, two `IN_CONSULTATION` encounters is permitted with a warning. |
| Reopen after 24 h | Not permitted; corrections go via amendments (CON), void/reissue (BIL). |

## 15. Compliance

- Display privacy (ENC-R-10) — waiting-room screens are visible to the public.
- `encounter_event` is the timeline evidence for any clinical-legal query about waiting times and sequence of care.
- No clinical content on ENC screens visible to FRONTDESK beyond status.

## 16. Reporting outputs

- Patients today / by hour / by doctor (RPT dashboard)
- Average and longest wait per station, per day (RPT; ANL in V2)
- No-show and cancellation rates
- Encounters by type and priority
- Consultation duration per doctor (from event timestamps)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| ENC-T-01 | Given a patient with no open encounter, when checked in, then status `REGISTERED`→`TRIAGE_WAITING` (setting ALWAYS), queue no `A-001` on a fresh day, one event row per transition. |
| ENC-T-02 | Given an encounter `IN_CONSULTATION`, when transition to `COMPLETED` is requested, then rejected listing allowed targets. |
| ENC-T-03 | Given two encounters at `DOCTOR_WAITING` (NORMAL at 09:00, URGENT at 09:10), then the doctor queue lists URGENT first. |
| ENC-T-04 | Given 50 parallel check-ins at one branch, then 50 distinct sequential queue numbers with no gaps or duplicates. |
| ENC-T-05 | Given an open encounter for patient P at branch B, when P is checked in again at B, then 409. |
| ENC-T-06 | Given a consultation exists and is unsigned, when completion is attempted, then rejected naming "consultation unsigned". |
| ENC-T-07 | Given a transition occurs, then every SSE subscriber for the branch receives an event within 1 s and the display DTO contains no name or ID. |
| ENC-T-08 | Given `queue.payment_before_dispense = true`, when a consultation with meds is signed, then status is `PAYMENT_WAITING`, not `PHARMACY_WAITING`. |
| ENC-T-09 | Given a `NO_SHOW` encounter, when reverted the same day, then it returns to `DOCTOR_WAITING` and the revert is audited. |
| ENC-T-10 | Given a direct SQL `UPDATE encounter SET status='COMPLETED'` from `REGISTERED`, then the DB trigger rejects it. |
| ENC-T-11 | Given a DOCTOR with 2 encounters `IN_CONSULTATION`, then both are permitted and a warning was recorded on the second. |
| ENC-T-12 | Given the display page left open 12 h in the target browser, then memory is stable and SSE is connected. |

## 18. Migration & rollout

- **R1** ships this alongside PAT: the clinic runs its queue on the system in parallel with the whiteboard for 3 days, then retires the whiteboard
- Configure branch settings with the clinic before R1: triage policy, payment-before-dispense, display privacy mode, thresholds
- Install the display: TV + cheap stick PC/Chromecast in kiosk mode; test chime and readability from the furthest seat
- Historical encounters are **not** migrated as encounters; legacy visit dates may be imported as a lightweight `legacy_visit` list on the patient record (PAT) if the clinic wants history visible

## 19. Out of scope

- Appointment-driven encounters, scheduling → V1 `APT`
- Estimated waiting time (needs data first) → V1
- SMS/WhatsApp "you're next" notifications → V1 `NTF`
- Multi-process SSE fan-out (Postgres LISTEN/NOTIFY) → V2 `BRN`
- Kiosk self-check-in → V2 `PPT`
- Bed/ward management → not planned

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| ENC-Q-01 | **Payment before or after dispensing?** | Pilot clinic |
| ENC-Q-02 | Triage every patient, or optional? | Pilot clinic |
| ENC-Q-03 | Number of doctors on concurrently; do patients choose a doctor? | Pilot clinic |
| ENC-Q-04 | Queue number format they use today (patients are used to it)? | Pilot clinic |
| ENC-Q-05 | Is there a waiting-room screen, or does one need buying? Which browser/device? | Pilot clinic |
| ENC-Q-06 | Do they print a queue ticket? | Pilot clinic |
| ENC-Q-07 | Display privacy: number only, or number + first name? | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] ENC-T-01 … T-12 green
- [ ] Transition table documented in code with a generated diagram matching §6
- [ ] DB trigger backstop in place
- [ ] Display page soak-tested 12 h on the clinic's actual hardware
- [ ] Branch queue settings agreed with the clinic and recorded here
- [ ] Clinic ran 3 full days in parallel with the whiteboard; whiteboard retired
- [ ] Open questions answered
