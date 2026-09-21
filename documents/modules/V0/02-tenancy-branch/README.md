# 02 · Tenancy & Branch (TEN)

The clinic's own settings, the branch layer over them, and the isolation
that means one clinic can never see another's anything.

**Register:** [`../v0-02-tenancy-branch-end-item-OPEN.md`](../../v0-02-tenancy-branch-end-item-OPEN.md)

## Setup

Sign in as **Dr Aisyah**. All of this is administrator-only.

## Walk through

1. **Clinic.** The form is generated from the schema the API serves, so
   every field carries its own help text and default. Nothing here is
   hand-written HTML.
2. **Change the front desk discount limit** from 10 to 15. Save. It
   applies everywhere immediately.
3. **Branches → Cawangan Cheras → settings.** Tick the box beside the
   discount limit and give *this branch* a different number. Save.
4. **Go back to Clinic and change the limit again.** The branch keeps
   its override. Untick the override and the branch follows the clinic
   again — **including the change you just made**, because only the
   difference is ever stored, never a copy.
5. **Upload a letterhead logo** on the branch. PNG, JPEG or SVG, up to
   512 KB. Then set the header and footer text.
6. **Go and issue a medical certificate** ([13](../13-documents/README.md)) and
   look at the top of it. That is the same logo, inlined into the
   document so it still renders in five years.

## Try to break it

- **Rename something that is not an image to `.png`** and upload it.
  Refused — the file is judged by its first bytes, not by its name.
- **Type a discount limit of 500.** Refused by the schema, with the
  range in the message.
- **Open the browser console on any screen** and look at a request. No
  tenant id is sent. It comes from your session and cannot be supplied
  by the caller — there is a lint rule (`npm run lint:dto`) that fails
  the build if a DTO ever grows one.
- **Try to reach another clinic's data.** You cannot from the UI, and
  you cannot from SQL either: every tenant-owned table has row-level
  security `FORCE`d, which applies to the table's owner too. The test
  `tenant-isolation.e2e-spec.ts` asserts every table is covered and that
  no model went unclassified.

## What is deliberately not here

- **Five default settings are guesses** (`TEN-OPEN-14`) — the discount
  limit, cash rounding, the daily queue reset, and whether a diagnosis
  is needed to sign. Read them aloud to the owner; it takes ten minutes.
- **The application connects as the owner of its tables**
  (`TEN-OPEN-15`, `IAM-OPEN-05`). Isolation holds regardless, because
  the policies are `FORCE`d — but that account could drop a policy, and
  it is the one facing the internet. `prisma/sql/app-role.sql` and
  `09-database-roles.md` are written and have never been run against
  production.
- **There is one branch.** Everything is built for several; nothing has
  been tried with two.

## Notes

<!-- yours -->
