# 08 · Dispensing (DSP)

The pharmacy counter: what actually leaves the shelf, which batch it
came from, and what goes on the bag.

**Register:** [`../v0-08-dispensing-end-item-OPEN.md`](../../v0-08-dispensing-end-item-OPEN.md)

## Setup

A signed consultation with a prescription ([07](../07-prescription/README.md)),
and stock on the shelf ([09](../09-inventory/README.md) — or
`npm run catalogue:seed` then receive some).

Sign in as **En Kamal** (`dispenser@klinikpilot.test`).

## Walk through

1. **Pharmacy.** The waiting list. Open one.
2. **What the dispenser sees is deliberately less than the doctor
   saw** — the medicines and the instructions, not the diagnosis.
3. **Dispense an item.** A batch is chosen **by earliest expiry**, not
   by what was received last. The quantity comes off that batch.
4. **Read the label.** Clinic, branch, telephone, patient, drug,
   strength, quantity, the instructions **in the patient's language**,
   lot number, expiry, and "keep out of reach of children".
5. **Substitute something.** Requires the `dispense.substitute`
   permission — En Kamal has it, a nurse does not. The original and the
   substitute are both recorded.
6. **Mark an item as declined** — the patient does not want it — or as
   sourced outside. Both are real counter outcomes and neither is a
   silent nothing.
7. **Complete the session.** The visit moves on and a medicine line
   appears on the bill ([11](../11-billing/README.md)).
8. **Print a label** ([13](../13-documents/README.md)). It is a stored document at
   50×30 mm.

## Try to break it

- **Dispense more than is on the shelf.** Refused. Stock cannot go
  negative — enforced at the ledger, not in the screen.
- **Dispense from an expired batch.** Refused.
- **Undo a dispense.** The stock goes back, as a reversal movement
  rather than by editing the original. The register shows both.
- **Dispense a controlled drug.** It physically cannot leave without an
  entry in the controlled register, which is append-only.
- **Record a return from a patient.** It comes back as its own movement
  type, not as an undo.
- **Try to change a dispensed item with SQL.** Refused by a trigger.
- **Two dispensers, one prescription, at once.** Worth poking at: the
  batch is locked `FOR UPDATE` during a movement, so one should win
  cleanly. Note below what you see.

## What is deliberately not here

- **Nothing has been printed on a label printer** (`DSP-OPEN-01`).
  **A production blocker** — a pharmacy counter cannot hand over an
  unlabelled bag. The payload is complete and has never met paper.
- **The undispensed-medicine completion guard is not registered**
  (`ENC-OPEN-15`). Deliberate: registering it before the pharmacy
  screen existed would have made every prescribed visit impossible to
  finish. **A guard nothing can satisfy is a trap** — the same lesson
  billing learned about the unpaid-balance guard, which payment has now
  registered.
- **The controlled register has never been shown to an inspector**
  (`DSP-OPEN-02`). The data is right; whether the printed layout is
  what they expect is unknown, and an inspection is the wrong time to
  find out.

## Notes

<!-- yours -->
