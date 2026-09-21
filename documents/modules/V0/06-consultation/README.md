# 06 · Consultation / EMR (CON)

The screen a doctor lives in for six hours a day. Autosave, signing, and
what happens to a record afterwards.

**Register:** [`../v0-06-consultation-end-item-OPEN.md`](../../v0-06-consultation-end-item-OPEN.md)

## Setup

A patient triaged ([05](../05-triage/README.md)). Sign in as **Dr Farid**.

## Walk through

1. **Today → a patient with the doctor → Consultation.**
2. **Three columns.** What is known about the patient on the left, the
   note in the middle, what happens next on the right. Nothing is behind
   a tab, because a doctor scanning a note should not have to remember
   which tab the examination was on.
3. **Start typing.** Watch the indicator: *unsaved → saving → saved*. It
   autosaves every few seconds.
4. **Kill the browser tab mid-sentence and reopen the page.** Your words
   are there. *This is the single most important behaviour in the
   module: a doctor who loses a note once goes back to paper.*
5. **Add a diagnosis.** Free text; ICD-10 is optional in V0.
6. **Use a template.** The button offers the clinic's ones. Applying
   fills the sections and is recorded as having been used.
7. **Press `Ctrl`+`Enter`.** The sign dialog opens with a summary of
   what you are about to sign.
8. **Sign.** The record becomes permanent and the visit routes onward.
9. **Reopen it.** Read-only. **Amend it** — the amendment is a new
   layer with your name, the time and a reason. The original text is
   still there and always will be.

## Try to break it

- **Try to sign with no chief complaint, or no diagnosis.** The button
  is disabled and says which is missing.
- **Open the same consultation in two windows and type in both.** The
  autosave is last-writer-wins within a draft; this is worth poking at
  and is exactly the kind of thing to note below.
- **Abandon a draft.** It asks why, and keeps it — a cancelled draft is
  kept, not deleted (CON-F-18).
- **Try to change a signed record with SQL.**
  ```sql
  UPDATE consultation SET hpi = 'quietly altered' WHERE id = '…';
  -- ERROR: a signed consultation cannot be changed
  ```
  A trigger, not application code.
- **Prove the fingerprint works.** Every signed record carries a hash of
  what was signed, and a nightly job re-checks them. The test
  `consultation.e2e-spec.ts` disables the trigger, alters a record, and
  watches the job find it — which is the scenario the hash exists for:
  a restore from a doctored backup, or a migration that meant well.

## What is deliberately not here

- **A signed record cannot be printed** (`CON-OPEN-05`, `DOC-OPEN-11`).
  Certificates, referrals and letters all print; "the whole note" needs
  somebody to decide how much of it an outsider should see, and nobody
  has.
- **The templates are invented** (`CON-OPEN-01`). Written by somebody
  who has never run a clinic session.
- **The integrity job writes to a log nobody reads** (`CON-OPEN-02`).
  Same for stock, documents and audit — one ten-minute cron closes all
  four.

## Notes

<!-- yours -->
