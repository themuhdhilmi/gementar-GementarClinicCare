# Appointments (APT)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 2 |
| **Depends on** | ENC, PAT, IAM, TEN, NTF, AUD |
| **Depended on by** | PPT, TEL, DRM |
| **Est. effort** | ~50 h |

> If the pilot runs appointments today, this moves into V0 Phase 1 and something else moves out (ENC-Q-01 / `08-open-questions.md`).

---

## 1. Purpose & business value

Scheduled visits alongside walk-ins: booking, rescheduling, cancellation, doctor availability, reminders, and a clean hand-off into the encounter on check-in. Also the foundation for online booking (PPT) and telemedicine (TEL).

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `appointment.read` | ✓ | ✓ | ✓ | ✓ |
| `appointment.write` — book, reschedule, cancel | ✓ | ✓ | ✓ | ✓ |
| `schedule.manage` — doctor schedules, blocks, slot config | ✓ | ✓ (own) | – | – |
| Configure appointment types, reminders | ✓ | – | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| APT-F-01 | Appointment types: name, duration, colour, default doctor/room, allowed for online booking, prep instructions, fee rule hint (BIL). | Must |
| APT-F-02 | Doctor schedule per branch: weekly template (day, start–end, slot length, room), exceptions (leave, half-day, extra session), blocks (meeting, break). Locum schedules (DRM). | Must |
| APT-F-03 | Availability engine: slots from templates − exceptions − blocks − existing bookings; capacity per slot (overbooking allowance configurable); walk-in reserve (% of slots kept unbookable). | Must |
| APT-F-04 | Book: patient (or new patient stub with phone), type, doctor (or any), date/slot, notes, source (`FRONTDESK`, `PHONE`, `ONLINE`, `FOLLOW_UP`); conflicts prevented; confirmation via NTF. | Must |
| APT-F-05 | Reschedule and cancel with reason and actor; cancellation policy (cut-off hours) informational in V1. | Must |
| APT-F-06 | Reminders: T-24 h and T-2 h via NTF (WhatsApp/SMS); patient confirm/cancel by reply (NTF inbound) → status. | Must |
| APT-F-07 | Check-in from the appointment (FRONTDESK or kiosk later) creates an encounter with `type = APPOINTMENT`, links `appointment_id`, and inherits doctor; late arrival rules (grace minutes, then walk-in priority). | Must |
| APT-F-08 | No-show marking after grace; no-show count on patient; optional deposit for repeat no-shows (V2 with gateway). | Should |
| APT-F-09 | Follow-up booking from consultation (CON follow-up flag → suggested slot). | Must |
| APT-F-10 | Waitlist for full days; auto-offer on cancellation (NTF). | Could |
| APT-F-11 | Views: day (per doctor columns), week, list; drag to reschedule; colour by type/status. | Must |
| APT-F-12 | Recurring appointments (e.g. weekly dressing) — series with individual edits. | Could |

## 4. Key workflows

Phone booking → find/create patient → pick type → next available with Dr A → confirm → NTF confirmation · T-24 h reminder → patient replies "1" → CONFIRMED · Arrival → appointment row "Check in" → encounter created → queue · Doctor on leave → exceptions → affected appointments listed → bulk reschedule with notifications.

## 5. Data model

```
appointment_type      id, tenant_id, name, duration_min, colour, default_room_id, online_bookable, instructions, status
doctor_schedule       id, tenant_id, branch_id, doctor_id, weekday, start_time, end_time, slot_min, room_id, capacity_per_slot, walkin_reserve_pct, effective_from, effective_to
schedule_exception    id, tenant_id, branch_id, doctor_id, date, kind enum(LEAVE, HALF_DAY, EXTRA, BLOCK), start_time, end_time, reason
appointment           id, tenant_id, branch_id, patient_id (nullable for stub), stub_name, stub_phone, type_id, doctor_id (nullable = any),
                      room_id, starts_at, ends_at, status enum(BOOKED, CONFIRMED, ARRIVED, IN_PROGRESS, COMPLETED, CANCELLED, NO_SHOW, RESCHEDULED),
                      source, notes, booked_by, booked_at, confirmed_at, confirmed_via, cancelled_at, cancel_reason, cancelled_by,
                      rescheduled_to_id, rescheduled_from_id, encounter_id, reminder_state jsonb, series_id
                      INDEX (branch_id, starts_at); INDEX (doctor_id, starts_at); INDEX (patient_id, starts_at desc)
                      EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('BOOKED','CONFIRMED','ARRIVED') AND capacity = 1)
appointment_waitlist  id, tenant_id, branch_id, patient_id, type_id, doctor_id, date_from, date_to, created_at, offered_at, status
```

ENC: `encounter.appointment_id` (V0 column) populated at check-in.

## 6. State machines

`BOOKED → CONFIRMED → ARRIVED → IN_PROGRESS → COMPLETED`; `BOOKED/CONFIRMED → CANCELLED | RESCHEDULED | NO_SHOW`; `ARRIVED` maps to encounter creation.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| APT-R-01 | No double-booking beyond slot capacity; enforced with an exclusion constraint (capacity 1) and a locked count (capacity > 1). | DB + service |
| APT-R-02 | Availability is computed, never stored; caches are invalidated on schedule/booking changes. | Service |
| APT-R-03 | Check-in creates the encounter through ENC's API; APT never writes `encounter` directly. | Boundary |
| APT-R-04 | Reminders are idempotent per appointment per reminder kind. | NTF dedupe key |
| APT-R-05 | Rescheduling creates a new appointment linked to the old (`RESCHEDULED`), preserving history. | Service |
| APT-R-06 | Cancelling a doctor's session lists and requires handling of affected appointments before the exception saves (or saves with them flagged). | Service |

## 8. API surface

`/appointment-types` CRUD · `/branches/:b/schedules` CRUD + `/exceptions` · `GET /branches/:b/availability?typeId&doctorId&from&to` · `POST /appointments` · `PATCH /appointments/:id` (notes) · `POST /appointments/:id/reschedule|cancel|confirm|no-show|check-in` · `GET /branches/:b/appointments?date&doctorId&status` · `GET /patients/:id/appointments` · `/waitlist` · NTF inbound webhook routes replies.

## 9. Domain events

**Emits:** `appointment.booked`, `appointment.confirmed`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.no_show`, `appointment.checked_in`, `appointment.reminder_due`, `schedule.changed`
**Consumes:** `encounter.completed` (→ COMPLETED), `consultation.signed` (follow-up suggestion), `notification.reply` (confirm/cancel)

## 10. Audit events

Booking lifecycle with actor and reason; schedule and exception changes; bulk reschedules.

## 11. Screens & UX requirements

Calendar (day per-doctor columns; week; list) with drag-reschedule and conflict feedback · Booking dialog (patient search/stub, type, doctor, next-available finder, notes) · Today's appointments strip on reception queue with "Check in" · Schedule editor (weekly grid, exceptions calendar) · Reminder status badges · Waitlist panel.

## 12. Validation

Slot within schedule; duration from type; start in future (backdate only ADMIN); phone required for stubs; cancel reason required within cut-off.

## 13. Non-functional requirements

Availability for one doctor for 14 days ≤ 100 ms · calendar day view ≤ 200 ms · reminder dispatch within 5 min of due · 500 appointments/day/branch supported.

## 14. Edge cases & failure modes

Patient arrives 40 min late (grace 15 → treated as walk-in, appointment `NO_SHOW`→ or `ARRIVED` per setting) · doctor sick same morning (bulk reschedule wizard + NTF) · two receptionists book the last slot (constraint; second sees error) · stub patient later registered (merge stub into patient) · public holiday calendar (MY national + state; maintained list) · daylight/timezone irrelevant (MY has none) · online booking abuse (rate limits, PPT).

## 15. Compliance

Reminder consent (PAT consents); appointment notes are not clinical; stub phone numbers are personal data.

## 16. Reporting outputs

Bookings by source/type/doctor; no-show and cancellation rates; lead time; utilisation of slots; walk-in vs appointment mix (RPT/ANL).

## 17. Acceptance tests (representative)

APT-T-01 availability excludes leave and blocks · T-02 concurrent booking of a capacity-1 slot → one succeeds · T-03 check-in creates an encounter with `appointment_id` and doctor · T-04 reminder sent once per kind · T-05 reply "cancel" → CANCELLED · T-06 reschedule links old/new · T-07 exception on a day with bookings → flagged list.

## 18. Migration & rollout

Import future appointments from their diary (CSV) if any; doctor schedules configured; reminders opt-in only for patients with consent; first two weeks with reminders in "preview" mode (staff see what would send).

## 19. Out of scope

Online self-booking UI → V2 `PPT` · deposits → V2 · telemedicine slots → V3 `TEL` · resource scheduling (equipment) → V2.

## 20. Open questions

APT-Q-01 do they run appointments today, and what share · Q-02 slot length per doctor · Q-03 walk-in reserve preference · Q-04 reminder channel preference and wording.

## 21. Definition of done

- [ ] Must requirements implemented; APT-T-01 … T-07 green
- [ ] Doctor schedules configured; reminders live for consented patients
- [ ] Open questions answered
