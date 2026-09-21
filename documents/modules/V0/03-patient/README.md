# 03 · Patient Registry (PAT)

Registering people, reading MyKad, catching duplicates, and the allergy
badge that the whole of prescribing rests on.

**Register:** [`../v0-03-patient-end-item-OPEN.md`](../../v0-03-patient-end-item-OPEN.md)

## Setup

```bash
npm run catalogue:seed --workspace @gementar/api
npm run patients:seed  --workspace @gementar/api
```

Sign in as **Puan Zana** for registering, **Dr Farid** for anything
clinical.

## Walk through

1. **Patients.** The seven seeded people. Search three ways and watch
   each work:
   - `5533` — the last four of an identity number
   - `012-345 6789` — a phone number in any format
   - `ramasamy muthu` — a name with the words the wrong way round,
     because *"bin"* and *"a/l"* are not part of anybody's name
2. **New patient → type `900101145678`, no dashes.** They appear as you
   type: `900101-14-5678`. Date of birth and sex fill themselves in at
   the twelfth digit.
   - **Paste** `900101 14 5678` with spaces, or with extra digits on the
     end. It normalises.
   - **Backspace onto a dash.** It removes the digit in front of it
     rather than the dash, so the field does not fight you.
   - **Click into the middle and insert a digit.** The caret stays put;
     it is counted in digits, not characters.
   - Now try `901301-14-5678` — refused on save, because there is no
     thirteenth month.
   - **Search for an IC that does not exist, then press New patient.**
     You arrive with the number already in the field *and* the date of
     birth and sex already read from it.
3. **Open Chan Wei Ming.** The allergy badge is **amber**: "allergies
   not recorded". Open **Ahmad bin Zulkifli** — **green**, with a name
   against it.
   *This is the difference the whole module is built around. Amber is
   not "no allergies". It is "nobody has asked".*
4. **As Dr Farid, record "no known allergies"** on Chan Wei Ming. Green,
   with your name and the time.
5. **Open Siti Nurhaliza.** Red — a life-threatening penicillin allergy,
   verified by a doctor. Now open **Muthu** — amber-verified: the
   counter wrote it down and no clinician has confirmed it.
6. **Open Kavitha.** Her allergy says *"some antibiotic, cannot remember
   which"*. Nothing can match that, which is why every prescription for
   her carries a warning that it has to be checked by hand.
7. **Open Nur Aisyah** (one month old). Her age reads in months. She has
   no identity document and a note saying whose baby she is.
8. **Documents tab.** Two cards: what the clinic *issued* on top, and
   *attachments* — things brought in and scanned — underneath. Upload a
   PDF to the second one.

## Try to break it

- **Register the same MyKad twice.** Refused, with a link to the
  existing record.
- **Register a different card with the same name and birthday.** This
  one *warns* rather than refusing — twins exist.
- **Now register "Ahmad bin Zulkifli" with Ahmad's birthday.** Refused
  as a likely duplicate. (This caught out three of my own test fixtures.)
- **Reveal a full identity number** as Puan Zana. It works, and it lands
  in the audit trail as `patient.id_unmasked`. Do it as En Kamal — he
  cannot; the number stays `•••••-••-1234`.
- **As Dr Farid, rule out an allergy.** It stays in the record with the
  reason, because the next prescriber needs to know the question was
  asked and answered.
- **Merge two records** (administrator). Everything moves to the
  survivor; the merged one stays, pointing at it. Then **unmerge**.

## What is deliberately not here

- **Attachments are on the server's own disk** (`PAT-OPEN-04`) and the
  database backup does not cover them. A restore would bring back rows
  pointing at files that are gone. **This is a production blocker.**
- **No patient photographs, no MyKad reader** (`PAT-OPEN-15`,
  `PAT-OPEN-14`) — both deliberate until somebody asks.
- **The import writes a row before the file exists** (`PAT-OPEN-05`) —
  the dangling-row failure that `DOC` was written the other way round to
  avoid.

## Notes

<!-- yours -->
