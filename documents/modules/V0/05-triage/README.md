# 05 · Triage (TRI)

Vitals, and the flags that tell a doctor somebody is sicker than they
look.

**Register:** [`../v0-05-triage-end-item-OPEN.md`](../../v0-05-triage-end-item-OPEN.md)

## Setup

A patient checked in ([04](../04-encounter-queue/README.md)). Sign in as
**Jururawat Mei**.

## Walk through

1. **Today → a waiting patient → Triage.**
2. **Type a temperature of `38.5`.** It flags amber **as you type**,
   before you save. Try `39.6` — red.
3. **Pulse `105`** — amber. `135` — red.
4. **Blood pressure `165/95`** — amber. `190/125` — red.
5. **Enter a height and a weight.** BMI computes itself and carries its
   own flag.
6. **Save.** Go to the consultation ([06](../06-consultation/README.md)) and the
   vitals are already there, with the abnormal ones marked. The doctor
   never retypes them.
7. **Amend a recorded set.** The original stays; the amendment is a new
   version with your name and a reason.

## Try to break it

- **Enter a temperature of 45.** Refused — outside anything a human
  body does, so it is a typo rather than an emergency.
- **Enter a pulse of 0.** Refused for the same reason.
- **Leave everything blank and save.** Allowed. A triage where nobody
  had a thermometer is a real thing and the record should say so rather
  than inventing numbers.
- **Record vitals for a one-month-old** (Nur Aisyah). The adult
  thresholds flag almost everything. **This is wrong and known** —
  paediatric thresholds are not settings yet (`TRI-OPEN-01`).
- **As Dr Farid, open the vitals.** Read-only for him in the triage
  form; he sees them in the consultation instead.

## What is deliberately not here

- **Nobody has agreed the thresholds** (`TRI-OPEN-01`). Every number is
  one somebody chose from a textbook. **This is a production blocker**:
  thresholds that cry wolf get ignored, and thresholds that are too
  loose miss. The paediatric ones are not even settings.
- **No vitals chart over time** (`TRI-OPEN-04`). The data is there; the
  graph is not.

## Notes

<!-- yours -->
