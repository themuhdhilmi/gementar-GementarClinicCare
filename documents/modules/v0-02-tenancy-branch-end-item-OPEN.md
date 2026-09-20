# Tenancy & Branch — open end items

Everything about `TEN` that is **not finished, not provable yet, or waiting on
someone else**. The module specification says what was built; this says what is
still owed, and how each one will be known to be done.

Nothing here blocks the pilot build. Three things block **go-live**, and they
are marked so. One of them, `TEN-OPEN-15`, is a Must requirement that is not
met, rather than something deferred.

| | |
|---|---|
| **Module** | [v0-02-tenancy-branch.md](v0-02-tenancy-branch.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

**How to use it.** Work through it at two moments: when the module it depends
on lands, and again as a block before go-live. Tick an item only when its
"done when" line is true, and move the line into the module's §21 so the
history stays in one place. Items are `TEN-OPEN-nn` so they can be referenced
from commits and from other modules.

---

## A. A requirement that is not met

| # | Item | Done when |
|---|---|---|
| **TEN-OPEN-15** | **TEN-F-12: the application connects as the owner of its tables.** It is not a superuser and cannot bypass row-level security, and policies are FORCEd so they apply to the owner as well. Isolation holds. What does not hold is the second line of defence: this account could `DROP POLICY` or `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, and it is the account facing the internet. The same as `IAM-OPEN-05`, recorded here because TEN-F-12 is where the requirement is written. **Blocks go-live.** | `prisma/sql/app-role.sql` has been run by an account with `CREATEROLE`, production `DATABASE_URL` points at `cliniccare_app`, migrations run under the owner's credentials only, the end-to-end suite passes against the new role, and `/api/v1/health` reports `role: "unprivileged"`. Steps: [`../planning/09-database-roles.md`](../planning/09-database-roles.md). |

## B. Guards that are real but currently guard nothing

| # | Item | Done when |
|---|---|---|
| ~~**TEN-OPEN-01**~~ | ~~**Nothing registers a branch deactivation check (TEN-F-07).**~~ **Closed 2026-09-21.** `ENC` registers an open-encounters check on start-up, so a branch with patients still in its queue cannot be closed. `INV` still owes a stock check, which is `ENC-OPEN-04`'s neighbour and tracked as `TEN-OPEN-16`. | Done. |
| **TEN-OPEN-16** | **Stock does not block deactivation yet.** The registry now has one check in it. A branch with medicine on its shelves should not be closable either. | `v0-09-inventory.md` registers a non-zero-stock check, with its own test. |
| **TEN-OPEN-02** | **`branch_id` on physical entities is a convention, not a constraint (TEN-F-08).** Nothing enforces that a new physical table carries one, the way TEN-T-06 enforces row-level security. Today there are no physical tables, so there is nothing to catch. | The scoping table in `../03-multi-tenancy.md` is turned into a generated test, the way TEN-T-06 was: each new table declares itself physical or catalogue, and a physical one without `branch_id` fails CI. Do this when the third physical table lands, not before — two is not enough to see the pattern. |
| **TEN-OPEN-03** | **The slow-work lint cannot see through a service call (TEN-F-17).** It catches a slow client written literally inside a `withTenant` block. Every request handler already runs inside one, so slow work three calls deep is invisible to it. The runtime assertion covers the mailer and nothing else. | Each slow client added — object storage, PDF rendering, MyInvois — calls `assertOutsideScope` on its way out, the way the mailer does. That is the control; the lint is the net. Check it at each of `v0-13-documents.md` and `v1-05-einvoice-myinvois.md`. |

## C. Numbers to redo on the real host

| # | Item | Done when |
|---|---|---|
| **TEN-OPEN-04** | **TEN-N-01 measured on a LAN, not on the target.** Three round trips is the counted, stable figure; what they cost is the network's business. On this machine it is ~2.2 ms against a 2 ms budget, and on the production topology it should be ~0.15 ms. | Rolled into `IAM-OPEN-01`: run `test/auth-latency.e2e-spec.ts` and `test/roundtrips.e2e-spec.ts` on the production VPS and write both numbers into §13. |
| **TEN-OPEN-05** | **TEN-N-05 has never fired.** The 5 s cap is configured and the log message is written, but no transaction has ever hit it, so the path is unproven. | A deliberate overrun on staging has produced the log line naming the handler, once. Cheap to do; do it while setting the production environment up. |

## D. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **TEN-OPEN-06** | **Nobody can switch a module on except by CLI (TEN-F-05).** The flags exist, resolve and are shown on the clinic screen, read-only. Turning one on is `npm run tenant -- modules`. That is deliberate for V0, when switching one on is a commercial conversation rather than a toggle. | `v1-08-admin-settings.md`, which owns the self-serve surface. Until then the CLI is the interface and it is written up in §8. |
| **TEN-OPEN-07** | **A module flag gates nothing.** No route or screen consults `SettingsService.require` yet, because every module that has one is unbuilt. The mechanism is tested; its use is not. | The first V1 module ships and calls `require` on its own flag, with a test that a clinic without it gets 403 rather than a half-working screen. |
| **TEN-OPEN-08** | **The letterhead is stored and never printed.** Header text, footer text and the logo round-trip correctly and are shown on the branch screen. Nothing renders them onto a document. | `v0-13-documents.md` renders a receipt using them, and someone looks at the printed page. Sizes and proportions are a template question that only a real page answers. |
| **TEN-OPEN-09** | **The logo lives in the database.** Right for V0: one small file per branch, in the same backup as the rows referencing it. Wrong at scale, or the moment patient-facing attachments exist. | Object storage exists (V1). Then `letterhead_logo` becomes a key, with a one-way copy migration, and the route becomes a redirect. Do not do this earlier for tidiness. |
| **TEN-OPEN-10** | **Settings schema migration has never been exercised.** `SETTINGS_SCHEMA_VERSION` is 1, and §14 says an upgrade transforms stored JSON with old keys mapped or dropped and a logged warning. There is no such transform, because there has been no version 2. | Version 2 happens. Write the transform with the change, not afterwards, and give it a test with a version-1 document as its input. |

## E. To confirm with the pilot clinic, in the room

| # | Item | Done when |
|---|---|---|
| **TEN-OPEN-11** | **TEN-Q-01: one clinic, or the first of several?** Nothing in the build depends on the answer. It decides when `v2-01-multi-branch.md` is scheduled. | Asked, and the answer written into §20. |
| **TEN-OPEN-12** | **TEN-Q-02: which licence number goes on a receipt?** Stored as free text and printed as typed. The question is which of their several numbers they expect to see, and whether it should be labelled. | Confirmed, and reflected in the `DOC` template rather than in a validation rule. |
| **TEN-OPEN-13** | **TEN-Q-03: hosting region.** Assume Malaysia. **Blocks go-live** only in the sense that the box has to be bought somewhere. | The VPS is in Malaysia, and the backup destination (`IAM-OPEN-09`) is in the same jurisdiction. An encrypted dump in a bucket in Virginia is the part people forget. |
| **TEN-OPEN-14** | **Are the default settings right for this clinic?** The discount limit of 10%, rounding cash to 5 sen, restarting queue numbers daily, and not requiring a diagnosis to sign were all chosen as sensible for a small Malaysian practice. They are guesses. **Blocks go-live** in the sense that a wrong discount limit is a real loss. | Each of the five defaults has been read aloud to whoever runs the clinic and either confirmed or changed on the settings screen. |

---

## Closed on 2026-09-21

Kept so the list reads as a history rather than only a backlog.

- Settings became a validated, self-describing document: the screen is
  generated from the schema, so a new setting needs one edit rather than two.
- Two instances of the same trap found and fixed: a patch schema built with
  `.partial()` keeps each field's default, which silently freezes a clinic on
  today's values. Once in settings, once in the letterhead.
- `null` in a patch now removes an override rather than being refused, so
  unticking a branch override makes it follow the clinic again.
- Tenant suspension answers 403 with an explanation, instead of a 401 that
  sends someone to a login that cannot help them.
- The platform CLI: create, list, suspend, resume, set-plan and modules, each
  writing to the clinic's own audit trail as the platform operator.
- Letterhead stored and served, with the file judged by its bytes rather than
  by what the browser claims, and SVG served sandboxed.
- Settings resolution cached for the life of the unit of work, which needs no
  invalidation because the cache cannot outlive the request.
- Transactions labelled with their handler and capped at five seconds.
- The slow-work rule, proved against a planted violation.
