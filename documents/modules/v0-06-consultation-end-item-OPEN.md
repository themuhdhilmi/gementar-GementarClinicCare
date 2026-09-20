# Consultation — open end items

Everything about `CON` that is **not finished, not provable here, or waiting
on a module that does not exist yet**.

`CON-OPEN-01` is the one that decides whether doctors keep using this. It is
an hour in a room with the clinic's doctor, not a coding task.

| | |
|---|---|
| **Module** | [v0-06-consultation.md](v0-06-consultation.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides adoption

| # | Item | Done when |
|---|---|---|
| **CON-OPEN-01** | **There are no templates (CON-Q-02).** The machinery works: a template fills the empty sections, never overwrites what the doctor wrote, and says which sections it left alone. What does not exist is a single template for a single presentation. **This is the difference between a ninety-second consultation and a three-minute one**, thirty times a day, and §18 is right that they have to be written with the doctor rather than guessed at. | An hour with the clinic's doctor produces their top twenty presentations as templates, loaded before R2. If they already have written templates on paper or in Word, start from those. |
| **CON-OPEN-04** | **Nobody has timed a doctor (CON-F-21, CON-N-03, CON-T-10).** The target is ninety seconds median for a straightforward case with a prescription. The workspace was built for it — one screen, no tabs, section jump keys, autosave, sign from the keyboard — and has only ever been used by its author. | One shadowed session per doctor at R2, timed with a stopwatch, and the slowest interaction fixed before R3. Depends on `CON-OPEN-01`: timing it without templates measures the wrong thing. |

## B. Built, and waiting for something to alert or print

| # | Item | Done when |
|---|---|---|
| **CON-OPEN-02** | **The integrity job logs, and nothing listens.** It runs at 03:45 across every clinic, recomputes the fingerprint of every signed record, and writes an error-level line naming any that no longer match. On a server nobody watches, that line is a tree falling in a forest. | `NTF` (V1) raises it as an alert. Until then, either somebody reads the logs each morning or a one-line cron greps for `INTEGRITY FAILURE` and emails. The second is ten minutes of work and worth doing now. |
| **CON-OPEN-03** | **No ICD-10 list (CON-Q-01).** Diagnoses are free text with an optional code the doctor can type. Reporting groups by description, which will be messy: "URTI", "urti" and "Upper respiratory tract infection" are three rows. | Licensing is resolved, a reference table is loaded, and the diagnosis field gets a type-ahead. Nothing already recorded has to change; free text stays valid. |
| **CON-OPEN-05** | **A signed record cannot be printed (CON-F-19).** No PDF, no letterhead. | `v0-13-documents.md`. The letterhead it will use is already stored per branch (TEN-F-10), which is `TEN-OPEN-08` closing at the same time. |
| **CON-OPEN-06** | **No `?` keyboard overlay.** The shortcuts work and each section shows its own hint; there is no one place that lists them. | Added, or dropped as unnecessary once `CON-OPEN-04` shows whether doctors actually use the keyboard. Do not build it before finding that out. |

## C. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **CON-OPEN-07** | **The plan has no orders (CON-F-10).** Follow-up works. Prescription, procedure, medical certificate and referral are the four things a plan usually contains, and none of them exists. `consultation.signed` carries `hasRx: false` honestly rather than omitting it. | `v0-07-prescription.md`, `v0-10-procedures.md`, `v0-13-documents.md`. Each sets its own flag on the signed event, and `EncounterService.routeAfterConsultation` already reads them. |
| **CON-OPEN-08** | **CON-T-07 cannot be tested.** A template carrying prescription items, applied to a patient allergic to one of them, must add the item with the warning visible. There are no prescription items. | `v0-07-prescription.md`. The allergy data it needs is built and tested (PAT-F-11). |
| **CON-OPEN-09** | **Attachments are not linked (CON-F-09).** Patient documents work and can be uploaded; `consultation_attachment` exists and nothing writes to it. | Small, and worth doing when a doctor first asks to attach a wound photo to a note rather than to the patient. |

## D. Decisions for the clinic

| # | Item | Done when |
|---|---|---|
| **CON-OPEN-10** | **CON-Q-03: is one diagnosis enough to sign?** Currently what brought the patient in, plus one diagnosis. | Asked. Making the examination mandatory is a one-line change; resist doing it *and* keeping the ninety-second target unless the doctor is sure. |
| **CON-OPEN-11** | **CON-Q-04 and CON-Q-05: screen size and SOAP labels.** Three columns above 1280 px, plain-word section headings that carry their SOAP letter in the code. | Asked before R2. Switching to SOAP headings is half an hour; discovering the doctor's screen is 1024 px wide on the morning of R2 is not. |

---

## Closed on 2026-09-21

- `ENC-OPEN-04`, open since v0-04: a visit can no longer be finished while
  a consultation is unsigned. This module registers the check, so encounters
  still know nothing about consultations.
- `TRI-OPEN-03`, open since v0-05: signing locks the vitals it was based on,
  which is what makes them part of the signed record rather than something
  editable afterwards.
- Routing after signing moved from an event listener into the signing
  transaction. As a listener the doctor's screen could not say where the
  patient had gone, and a routing failure would have left somebody stranded
  in a consultation room on the board.
- The test harness never cleaned up clinical tables, which the nightly
  integrity job noticed by reporting tampered records from earlier runs.
