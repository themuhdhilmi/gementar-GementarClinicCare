# Encounter & Queue (ENC)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Built. Open items in [v0-04-encounter-queue-end-item-OPEN.md](v0-04-encounter-queue-end-item-OPEN.md) |
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

> **On `FRONTDESK`.** Written before the front desk was split into
> `RECEPTION`, `DISPENSER` and `CASHIER` (IAM-Q-01). Below it means all
> three: each of them can check a patient in, move them along and view every
> queue, which matches how a small clinic's counter actually works. That is
> `IAM-OPEN-18` closed for this module.

| Actor | Uses ENC to |
|---|---|
| Reception, dispenser, cashier | Check in, assign doctor/room, set priority, cancel, mark no-show, view all queues |
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
| ENC-F-24 | Sending a patient back: every station that can hold a patient offers a move to the step before it — triage to its own queue, procedures, pharmacy, dispensing and the cashier back to the doctor's queue. Backward moves across a station are refused without a written reason, which is shown on the visit and on the audit trail. The patient keeps the `status_since` they had when they last entered that status, so they do not queue twice for the same step. | Must |
| ENC-F-25 | Station consoles: a full-screen page per station (`/station/:station`), outside the application's navigation, for a monitor that stands at one place all day. One large "call next", the line in type readable standing up, and the station's own working screen one press away. Reception has no call button — it is a view over the floor, not a line. | Should |
| ENC-F-26 | Switching a station off warns rather than surprises: if patients are still in a status no remaining station would watch, the change is refused with 409 and names how many and where. An explicit `acknowledge` on the request saves it anyway. Compared as status *coverage*, not station names, so moving to a combined counter — which watches the same two queues — is never blocked. | Should |
| ENC-F-27 | Flow presets: four named shapes (Single room, Standard GP, Separate pharmacy and cashier, Pay first) that set the flow switches together, with Custom for anything else. The procedure room is a station a clinic switches on, rather than one that is always there and always empty. | Should |

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
| POST | `/encounters/:id/force-transition` | ADMIN + reauth | Recovery **and** reopening, which are the same operation with a different target. Reason required, audited loudly. |
| GET | `/branches/:b/queues/:station` | session | `station ∈ reception,triage,doctor,pharmacy,cashier`; `?doctorId=` |
| GET | `/branches/:b/queues-stream` | session | Server-sent events. Hyphenated rather than nested under `/queues/` so it cannot be mistaken for a station called "stream". |
| GET | `/branches/:b/queues-stats` | session | Today's counts and waits |
| POST | `/branches/:b/queues/:station/call-next` | `encounter.transition` | Takes the head of that queue under a row lock |
| GET | `/display/:token` | public | Display DTO (queue numbers only) |
| GET | `/display/:token/stream` | public | SSE for display |
| POST/DELETE | `/branches/:b/display-tokens[/:id]` | `admin.settings` | |
| GET/POST | `/branches/:b/rooms` | `patient.read` / `admin.settings` | |
| POST | `/rooms/:id/retire` · `/rooms/:id/reinstate` | `admin.settings` | Retired rather than deleted: encounters point at it |

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

All seven are for the clinic, and every one of them is a branch setting
rather than a code change. That is the point of having asked them early: the
answers move a toggle on the settings screen, and the defaults below are
what the clinic runs until somebody says otherwise.

| Question | The setting | Default, and why |
|---|---|---|
| ENC-Q-01 pay before or after dispensing | `queue.paymentBeforeDispense` | Off: collect the medicine, then pay. Both orders are legal moves in the state machine, so switching costs nothing. |
| ENC-Q-02 triage everyone | `queue.triageRequired` | `OPTIONAL`, which lets the front desk decide per patient. `ALWAYS` and `NEVER` both work. |
| ENC-Q-03 how many doctors, do patients choose | No setting needed | "Any available" is a real assignment, and the doctor board shows unassigned patients alongside a doctor's own. A clinic where patients pick a doctor simply assigns one at check-in. |
| ENC-Q-04 queue number format | `queue.numberPrefix` | `A`, giving `A-001`. Emergencies are shown as `E-`. |
| ENC-Q-05 is there a screen | — | Not a setting. The display is a web page; it needs a television and something to drive it. **Ask early**: it is the only hardware this module needs, and `ENC-OPEN-01` cannot be closed without it. |
| ENC-Q-06 printed ticket | — | Not built. The queue number is on screen at check-in. A printed slip is `ENC-OPEN-06`, and worth asking about because patients who are used to one will ask for it. |
| ENC-Q-07 display privacy | `queue.displayShowFirstName` | On, showing "Ahmad Z.". Off gives numbers only. |

Two more settings exist that nobody asked about, and both are worth
confirming: `queue.waitAmberMinutes` and `queue.waitRedMinutes`, which turn a
board row amber at thirty minutes and red at sixty. A clinic that routinely
runs an hour behind will find a board that is entirely red tells them
nothing.

## 21. Definition of done

- [x] **All Must requirements implemented** — see the traceability table. `ENC-F-14` (follow-up flag) is a Should and is stored but not yet surfaced on the patient record; `ENC-F-21` and `ENC-F-22` are built.
- [x] **ENC-T-01 … T-12 green** — `test/encounter.e2e-spec.ts`, 33 tests, plus 12 unit tests on the transition table. ENC-T-12, the twelve-hour soak, is the one that cannot be automated; see below.
- [x] **Transition table documented in code** — `transitions.ts` is one table with a label and a station per move. No diagram is generated: §6 is the diagram, and a second one produced from the same data would be a second thing to keep true. A test compares the table against the database instead, which is the part that can actually drift.
- [x] **DB trigger backstop in place** — refuses any status change the machine does not define, and any change that leaves `status_since` behind. Proved by ENC-T-10 from raw SQL.
- [ ] **Display page soak-tested 12 h on the clinic's actual hardware** — cannot be done here. `ENC-OPEN-01`, and it is the item most likely to embarrass the pilot.
- [ ] **Branch queue settings agreed with the clinic** — the eight settings exist with defaults; nobody has confirmed them. `ENC-OPEN-05`.
- [ ] **Clinic ran 3 full days in parallel with the whiteboard** — rollout, after R1.
- [x] **Open questions answered** — §20. All seven are for the clinic, and what the code does meanwhile is written down.

### Traceability

| Requirement | Where it lives | Proved by |
|---|---|---|
| ENC-F-01 check in | `EncounterService.checkIn` | ENC-T-01 |
| ENC-F-02 numbering | `QueueNumberService` | ENC-T-04 |
| ENC-F-03 state machine | `transitions.ts`, `transition()` | ENC-T-02, 12 unit tests |
| ENC-F-04 timeline | `writeEvent`, append-only trigger | ENC-T-01, "the timeline cannot be rewritten" |
| ENC-F-05 triage policy | `queue.triageRequired` | Check-in routes on it |
| ENC-F-06 … F-07 doctor and room | `QueueService.assign` | 3 assignment tests |
| ENC-F-08 priority | `QueueService.setPriority` | ENC-T-03 |
| ENC-F-09 cancel, no-show | Transition table, `revert-no-show` | ENC-T-09 |
| ENC-F-10 completion guards | `EncounterCompletionRegistry` | ENC-T-06 |
| ENC-F-11 the chart | `GET /encounters/:id`, `app/(app)/encounters/[id]` | Timeline and blocker tests |
| ENC-F-13 one open visit | Partial unique index | ENC-T-05 |
| ENC-F-15 … F-16 boards | `QueueService.board` | ENC-T-03 and the board tests |
| ENC-F-17 … F-18 call, skip | `callNext` with `FOR UPDATE SKIP LOCKED` | 4 tests including the race |
| ENC-F-19 live updates | `QueueStreamService`, `useQueueStream` | ENC-T-07 in part; see `ENC-OPEN-02` |
| ENC-F-20, F-23 the display | `DisplayService`, `app/display/[token]` | ENC-T-07, 5 display tests |
| ENC-F-21 … F-22 statistics, thresholds | `QueueService.stats`, `waitTone` | Board tests |
| ENC-F-24 sending back | `back`/`requiresReason` in `transitions.ts`, the reason guard in `EncounterService.transition` | ENC-T-11, T-12, T-13 and 4 table tests |
| ENC-F-25 station consoles | `app/(station)/station`, `useQueueStream` | Covered by the board tests it reads from |
| ENC-F-26 station in use | `SettingsChangeRegistry`, the check in `EncounterModule` | ENC-T-16, T-17 |
| ENC-F-27 presets, procedure room | `FLOW_PRESETS`, `stationsFor`, `proceduresEnabled` | ENC-T-18 |
| ENC-R-01 … R-10 | Service, triggers, partial index | The database refuses each independently |

## 22. Notes worth keeping

1. **One chokepoint, or none.** Every status change goes through
   `transition()`. Nothing else writes the column, a trigger refuses it if
   anything tries, and each move leaves exactly one timeline row. The
   alternative — a status check in each screen's handler — is how a clinic
   ends up with a patient who is somehow in the pharmacy queue and also in
   consultation, with nobody able to say which line of code allowed it.

2. **The transition table exists twice, on purpose, and a test compares
   them.** The code table knows about branch settings and about who is
   asking. The database trigger knows neither, so it is deliberately the
   looser of the two: a backstop stricter than the rule it backs up would
   refuse work that is legitimately allowed. `transitions.spec.ts` reads the
   migration and fails if the code allows a move the database would reject.

3. **Force is not permission to invent a state.** It reaches a defined set
   of recovery moves — abandoning a visit after the consultation has begun,
   closing one that is stuck — and it skips the completion guards. It cannot
   put an encounter into a state the machine has no rule for. It needs an
   administrator, a fresh password and a reason, and it is logged loudly.

4. **One counter per branch per day, two numbers from it.** An earlier
   version gave emergencies their own series and the first emergency of the
   day collided with the first ordinary patient: both were visit 001, and
   the encounter number is unique per branch per day. The letter is display
   only. An emergency reaches the front of the queue because of its
   priority, not its prefix.

5. **The clinic's day, not UTC.** Queue numbers restart at the branch's own
   midnight. A clinic open until 10pm in Kuala Lumpur would otherwise see
   them restart during the evening, which is obvious on the day and
   invisible in a test written in January.

6. **`FOR UPDATE SKIP LOCKED` is the whole of "call next".** Two staff
   pressing the button at the same moment is the ordinary case in a busy
   clinic, not a rare race. The lock means the second caller gets the next
   patient rather than the same one.

7. **"Back of the queue" is a timestamp, not a position.** Skipping moves
   `status_since` to now, and the order is by how long you have waited at
   this station. There is no position column, so there is nothing to get out
   of step with the ordering.

8. **A patient called by mistake keeps their place.** Returning them to the
   queue restores `status_since` rather than resetting it — nudged by one
   millisecond, because the trigger insists the clock moves when the status
   does and here it deliberately must not.

9. **Streaming routes opt out of the request transaction.** Every other
   authenticated route runs inside one. A stream is open for hours: the
   interceptor would take the first event and close the connection, and it
   would hold a database connection for the whole afternoon. `@NoRequestTransaction`
   is the opt-out, the reason is required, and it is the only decorator in
   the system that makes a route less safe, so it says so.

10. **Events are invalidation signals, not data.** They carry the branch,
    what changed and the queue number; the client refetches. That is what
    keeps a public waiting-room screen from ever being sent a name, and what
    makes a missed event harmless — the next refetch is the truth either
    way.

11. **The display is the only public surface in the product.** A television
    in a waiting room cannot hold a password, so it holds a token in its
    address bar. Stored hashed, for the same reason a session token is, and
    revocable, because a screen in a public room will eventually be
    photographed. It grants exactly one thing: the queue numbers at one
    branch.

12. **A first name and an initial, or nothing.** "Ahmad bin Zulkifli"
    becomes "Ahmad Z." — enough for somebody half asleep in a plastic chair
    to recognise themselves, not enough for a stranger to write down. The
    particles are stripped, as they are in patient search. A clinic that
    prefers numbers only turns it off in one setting.

13. **The chime is generated, not a file.** Two notes through the Web Audio
    API. A browser refuses to play anything until somebody has touched the
    screen, so a missing file would be indistinguishable from a blocked one,
    and a silent screen is still a working screen.

14. **Completion guards belong to other modules.** `EncounterCompletionRegistry`
    is empty today, so a visit can always be finished — correct now, wrong
    the moment prescribing exists. Consultation, prescription and billing
    register their own checks, because encounter must not reach into their
    tables and guess.
