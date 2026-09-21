# 14 · Audit Trail (AUD)

Who did what, when, what it looked like before — and proving none of it
can be rewritten.

**Register:** [`../v0-14-audit-trail-end-item-OPEN.md`](../../v0-14-audit-trail-end-item-OPEN.md)

## Setup

Do some of the other walkthroughs first, so there is something to look
at. Sign in as **Dr Aisyah** — `audit.read` is administrator-only.

## Walk through

1. **Audit.** Six tiles, each a link rather than a statistic. Click a
   number and the list below filters to it.
2. **Open a patient's clinical tab as the administrator**, then come
   back. **Break-glass access** went up. Do the same as Dr Farid and it
   does not — reading a record you are responsible for is routine, and
   flagging it would make the flag worthless.
3. **Click a row.** Before and after side by side, changed fields
   picked out — old struck through in red, new in green — plus the
   request id that ties this entry to the application log.
4. **Change a patient's telephone number, then find the entry.** The
   diff shows `phone` and nothing else.
5. **Patient record → Access history.** Every view and every change, in
   plain English, with who. *This is the view a PDPA request turns
   into.* Only an administrator sees the tab at all.
6. **Filter by kind of activity** — money, stock, clinical, patients —
   and by period. Ask for more than a year and it is refused rather
   than run.
7. **Export a range.** It asks for your password again, downloads a
   CSV, and then **records the export itself** — filter and all — as an
   entry you can find in the list you just exported.

## Try to break it

- **Try to change history.** There is no endpoint. From `psql`, as the
  database owner:
  ```sql
  UPDATE audit_log SET action = 'nothing.happened' WHERE id = '…';
  -- ERROR: AUDIT_IMMUTABLE: audit_log rows cannot be update
  ```
  The same for `DELETE`, and the same for a write aimed straight at a
  monthly partition.
- **Filter for an action nobody emits** — `patient.abducted`. Refused
  as unknown, rather than returning an empty page that reads like
  innocence.
- **Look at the partitions:**
  ```sql
  \dt audit_log*
  ```
  Monthly, plus `audit_log_unclaimed` which should always be empty.
  Anything in it means a month went by with no maintenance, and the
  nightly job says so.
- **Check every mutating route is declared:**
  ```bash
  npm run lint:audited --workspace @gementar/api
  ```
  156 routes, each carrying `@Audited('…')` or `@NotAudited('why')`.
  The build fails if a new one says neither. Eight are deliberately not
  audited — autosave, prescription notes, patient search, duplicate
  checking, MFA enrolment before confirmation, blind count entry, and
  two personal shortcut lists. **Each of those is a judgement somebody
  could disagree with**, and the reasons are in the decorators.
- **Look for a password in the trail.** You will not find one. Anything
  whose key looks like a credential is redacted at any depth, before
  it is stored — and anything over 64 KB is replaced by a note saying
  how big it was.

## What is deliberately not here

- **Nothing draws anybody's attention to anything** (`AUD-OPEN-01`).
  The tiles are correct and live on a screen somebody visits when they
  remember. A break-glass access at 11 p.m. is recorded and unnoticed.
  **One ten-minute cron closes this and the same gap in three other
  modules** — it is the highest ratio of value to effort left.
- **Staff have not been told their record views are logged**
  (`AUD-OPEN-02`, `AUD-Q-01`). A log staff do not know about is a trap;
  one they do know about is mostly a deterrent, which is most of its
  value.
- **Retention is a sentence, not a mechanism** (`AUD-OPEN-03`).
  Entries are kept because nothing deletes them.

## Notes

<!-- yours -->
