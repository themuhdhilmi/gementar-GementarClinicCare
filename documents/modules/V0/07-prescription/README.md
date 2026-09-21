# 07 · Prescription (RX)

Prescribing, and the warnings that are the reason the allergy badge in
[03](../03-patient/README.md) matters.

**Register:** [`../v0-07-prescription-end-item-OPEN.md`](../../v0-07-prescription-end-item-OPEN.md)

## Setup

```bash
npm run catalogue:seed --workspace @gementar/api
npm run patients:seed  --workspace @gementar/api
```

Sign in as **Dr Farid**, in a consultation ([06](../06-consultation/README.md)).

## Walk through

1. **The Prescription panel** is on the consultation screen, beside the
   plan — not on a separate page, because what is prescribed *is* part
   of the plan.
2. **Search for a medicine.** Beside each one: **how many are on the
   shelf** and the **nearest expiry**. A medicine with none says so.
   *This is what connects prescribing to the stock room.*
3. **Add one.** Dose, unit, route, frequency, duration. The quantity
   computes itself — and counts **dispensing units**, so a 500 mg
   capsule three times a day for five days is 15 capsules, not 7,500 mg.
4. **Read the label text it generated.** That is what goes on the bag.
5. **Prescribe something out of stock.** It warns and lets you do it —
   the doctor is the clinician and the shelf is not their problem.

Now the warnings. Do these on the seeded patients:

6. **Siti Nurhaliza** (verified penicillin allergy) → prescribe
   amoxicillin. **A hard warning**, matched exactly.
7. **Rahmat Santoso** → the medicine his severe allergy is linked to.
   **This one stops the signature** until you override it.
8. **Override it.** It demands a reason. The reason, the warning that
   was shown, and your name all go into the audit trail together.
9. **Kavitha** → anything. A warning that her allergy is *"some
   antibiotic, cannot remember which"* and cannot be matched by
   machine, so it must be checked by hand.
10. **Sign the consultation.** The prescription activates with it.

## Try to break it

- **Prescribe a medicine with no generic name.** Refused — the allergy
  check is only as good as the generic, so a medicine without one
  cannot be checked and will not be prescribed.
- **Prescribe a dose above the daily maximum.** Warned.
- **Prescribe the same medicine twice.** Warned as a duplicate.
- **Amend an item after signing.** A new version; the old one stays,
  pointing forward.
- **Try to change a signed prescription item with SQL.** Refused by a
  trigger.
- **Use a favourite.** Save one, use it, remove it. It is a personal
  shortcut and is deliberately not audited.

## What is deliberately not here

- **The catalogue is twenty-five guesses** (`RX-OPEN-01`). **The worst
  item on the production-readiness page after backups.** An allergy
  check is exactly as good as its `drug_class` column: a patient
  allergic to penicillin gets **no warning** on a cephalosporin the
  clinic stocks under a brand name with no class recorded. A missing
  *generic* is loud — the service refuses. A missing *class* is silent,
  and silence reads as "checked, all clear".
- **The dispensing-completion guard is not registered** (`ENC-OPEN-15`,
  deliberately) — see [08](../08-dispensing/README.md).
- **No paediatric mg/kg helper** (`RX-OPEN-06`), on purpose: the
  specification is explicit that it must never auto-fill, and an
  uninvited number beside a dose field is how you cause the error it
  was meant to prevent.

## Notes

<!-- yours -->
