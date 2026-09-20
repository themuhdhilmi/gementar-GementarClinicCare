# Prescription — open end items

Everything about `RX` that is **not finished, not provable here, or waiting
on a module that does not exist yet**.

`RX-OPEN-01` is the only one that changes whether this is safe to use. The
safety checks are as good as the catalogue they read, and the catalogue is
currently twenty-five medicines somebody guessed at.

| | |
|---|---|
| **Module** | [v0-07-prescription.md](v0-07-prescription.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides whether the safety checks mean anything

| # | Item | Done when |
|---|---|---|
| **RX-OPEN-01** | **The catalogue is a guess (RX-Q-01).** Twenty-five medicines are seeded with a generic name on every one and a class on everything an allergy is commonly recorded against. That is enough to demonstrate the checks and nothing like the clinic's real list. **An allergy check is exactly as good as the `drug_class` column**: a patient allergic to penicillin gets no warning on a cephalosporin the clinic stocks under a brand name with no class recorded. | An hour with the clinic's doctor over their actual stock list, mapping generic and class. The service refuses to prescribe a medicine with no generic name, so the gap is loud rather than silent — but a *missing class* is silent, and that is the one to check by hand. Load before R2. |

## B. Built, and waiting for something to print or to stock

| # | Item | Done when |
|---|---|---|
| **RX-OPEN-02** | **No printout, so no controlled-drug fields (RX-F-08, RX-F-18, RX-Q-03).** `is_controlled` is snapshotted onto the item and shown on screen. There is no PDF, no letterhead, no quantity in words, no patient IC on the page. | `v0-13-documents.md`. Ask the clinic what their inspector actually wants on the page (RX-Q-03) before building it, not after. |
| ~~**RX-OPEN-03**~~ | ~~**No stock figure beside a medicine (RX-F-04).**~~ **Closed 2026-09-21.** The stock ledger was built for procedures, and a product search now carries on-hand at the caller's branch, plus a `stockKnown` flag so "none" and "not known" stay distinguishable. | Done. |
| **RX-OPEN-04** | **Nobody who speaks Malay has read a label, and nobody has said which languages are needed (RX-Q-02).** The generator is deterministic and unit-tested in Malay and English, and its author does not speak Malay as a first language. "Ambil setengah biji, 3 kali sehari, selepas makan" reads correctly to me, which is not the same as reading correctly. Whether Chinese or Tamil are needed is unanswered. | A doctor and a counter assistant read twenty generated labels aloud. Wrong ones are fixed in `label.ts` and the unit test updated to the corrected string. Each language has its own sentence shape rather than a translation table, so adding one is a day plus a review by somebody who speaks it. |

## C. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **RX-OPEN-07** | **Nothing can be dispensed.** Items become `ACTIVE` and stay there. `PARTIAL` and `DISPENSED` exist in the enum and nothing writes them; `prescription.completed` only fires when every item is cancelled or declined. The patient is routed to `PHARMACY_WAITING` and the queue board moves them on by hand. | `v0-08-dispensing.md`. `dispenseView` is already the DTO it will read, and `prescription.item_amended` already carries `alreadyDispensed`. |
| **RX-OPEN-08** | **`ENC-OPEN-15` stays open on purpose.** `ENC-F-10` says a visit cannot be completed while a prescription has undispensed items. That check is deliberately **not** registered, because registering it today would make every prescribed visit impossible to finish. | `v0-08-dispensing.md` registers it, at the same time as it gains the ability to satisfy it. |
| **RX-OPEN-09** | **`patient.allergy_added` is not consumed.** The specification has RX re-check open drafts and active undispensed items when an allergy is recorded, and raise it to the pharmacy. What is built is the re-check at signing (RX-F-17), which catches the case that matters — the nurse recording it while the doctor types. An allergy recorded *after* signing, while the item sits in the pharmacy queue, raises nothing. | `v0-08-dispensing.md`, which is the thing that would show the warning. Needs `NTF` to be worth much more than that. |
| **RX-OPEN-10** | **Prices are not charged.** An item has a price in the catalogue and prescribing never touches it. | `v0-11-billing.md`. Correct as it stands: what is charged is what was dispensed, not what was intended. |

## D. Smaller things, honestly listed

| # | Item | Done when |
|---|---|---|
| **RX-OPEN-05** | **The instruction chips are five guesses (RX-Q-05).** They are in Malay, they are plausible, and no one at the clinic wrote them. | The clinic lists the phrases they actually use, in both languages, and they become a tenant setting rather than a constant in the panel. |
| **RX-OPEN-06** | **No paediatric mg/kg helper (RX-F-11).** It is a Should. The weight is already on the screen from triage; nothing computes mg/kg beside the dose field. | Half a day, once a doctor asks for it. Worth waiting: the spec is explicit that it must never auto-fill, and building a number nobody asked for next to a dose field is a way to create the error it was meant to prevent. |
| **RX-OPEN-11** | **A custom frequency is stored but barely surfaced.** `CUSTOM` with an explicit doses-per-day works end to end, including on the label. The panel offers it as a select option with a number field and no validation beyond "more than zero". | Someone uses it in anger and says what is missing. |
| **RX-OPEN-12** | **Duplicate detection matches the generic name as a string.** "Paracetamol" and "Paracetamol" match; "Co-amoxiclav" and "Amoxicillin + clavulanic acid" do not. Case and whitespace are handled; synonyms are not. | The same conversation as `RX-OPEN-01`. A curated generic list makes the strings consistent, which is cheaper than synonym matching. |

---

## Closed on 2026-09-21

- `CON-OPEN-07`, partially: the plan now has one of its four orders.
  `consultation.signed` carries a real `hasRx`, and a patient with a
  prescription is routed to the pharmacy. Procedures, medical certificates
  and referrals are still missing.
- `CON-OPEN-08`, open since v0-06: RX-T-07's equivalent is tested — a
  warning attached to an item that is added rather than silently dropped.
  The template path itself is `/prescription/check`, a dry run that returns
  warnings without saving anything.
- A live defect, found while diffing this migration: `patient_name_trgm_idx`
  was dropped by the encounter migration in August and never recreated, so
  patient name search had been sequential-scanning ever since. Recreated,
  and `test/raw-indexes.e2e-spec.ts` now asserts every hand-written index
  against the live database.
- A test-cleanup leak, found the same way: the catalogue slice never added
  its tables to the harness, so a test clinic with products in it could not
  be deleted. Fixed for the catalogue and the prescription tables together.
