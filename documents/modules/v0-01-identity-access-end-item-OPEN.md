# Identity & Access — open end items

Everything about `IAM` that is **not finished, not provable yet, or deliberately
deferred**. The module specification says what was built; this says what is
still owed, and how each one will be known to be done.

Nothing here blocks the pilot build. Several things here block **go-live**, and
they are marked so.

| | |
|---|---|
| **Module** | [v0-01-identity-access.md](v0-01-identity-access.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

**How to use it.** Work through it at two moments: when the module it depends
on lands, and again as a block before go-live. Tick an item only when its
"done when" line is true, and move the line into the module's §21 so the
history stays in one place. Items are `IAM-OPEN-nn` so they can be referenced
from commits and from other modules.

---

## A. Measurements that must be redone on the real host

Both numbers in the specification came from a development laptop with the
database one network hop away. Neither is the number that matters.

| # | Item | Done when |
|---|---|---|
| **IAM-OPEN-01** | **Auth guard latency.** Measured 11 ms p50 / 17.6 ms p95 against a LAN database; the budget is 5 ms p95. About 4 ms of it is round trips that disappear when PostgreSQL is on the same host. | `npm run test:e2e -- test/auth-latency.e2e-spec.ts` has been run on the production VPS and the numbers are written into §13. If it is still above 5 ms, decide explicitly: accept it, or change the design. Do not quietly leave the requirement failing. |
| **IAM-OPEN-02** | **Argon2id cost.** The process times one hash at startup and warns outside 200–300 ms. On this laptop it reports 46 ms, which is too cheap. | The production log's first hashing line reads inside 200–300 ms, and `ARGON2_MEMORY_KIB` / `ARGON2_ITERATIONS` in the production environment came from `npm run measure:argon2` run **on that host**. Re-check yearly (IAM-N-02). |
| **IAM-OPEN-03** | **Sign-in to workspace.** 127 ms p95 here, against §11's one second. Will be slower on a VPS with a real Argon2 cost and a real network. | Measured on production with real hashing cost, and still under one second on the clinic's own hardware and connection. |

## B. Decisions that are yours, not the code's

| # | Item | Done when |
|---|---|---|
| **IAM-OPEN-04** | **Email provider (IAM-Q-03).** The Resend transport is built and tested; nothing is chosen or configured. Until then invitations and resets are hand-carried links. **Blocks go-live.** | A sending domain exists with SPF, DKIM and DMARC records, `MAIL_TRANSPORT=resend` and `RESEND_API_KEY` are set in production, and a real invitation and a real password reset have each arrived in an inbox — not in spam. |
| **IAM-OPEN-05** | **Unprivileged database role (IAM-Q-05).** The application connects as the owner of its tables, so it could drop a policy. Row-level security is FORCEd, so isolation itself holds. **Blocks go-live.** | `prisma/sql/app-role.sql` has been run by someone with `CREATEROLE`, production `DATABASE_URL` points at `cliniccare_app`, and `/api/v1/health` reports the role as `unprivileged`. |
| **IAM-OPEN-06** | **Rate limit and lockout numbers (§22 note 7).** Five failures per email per fifteen minutes trips long before ten *consecutive* failures can accumulate, so the lockout rarely fires. Both are implemented exactly as specified. | The pair has been reconsidered together, with the pilot's actual behaviour in mind, and either changed or confirmed in writing. |
| **IAM-OPEN-07** | **Duplicate email across tenants (IAM-Q-04).** Login fails, deliberately, rather than guessing. Only matters when a second clinic company signs. | Clinic two exists, and the chosen answer — a clinic picker, a per-clinic subdomain, or globally unique addresses — is implemented and tested. |

## C. Operational, before the clinic depends on this

None of these are IAM code. All of them decide whether IAM's guarantees mean
anything in practice.

| # | Item | Done when |
|---|---|---|
| **IAM-OPEN-08** | **A second administrator.** There is exactly one, and MFA is mandatory for administrators. If that person loses their phone *and* their recovery codes, no one can reset the second factor through the application; recovery needs database access and the command-line script. **Blocks go-live.** | At least two active administrators exist at the pilot, each enrolled with their recovery codes stored somewhere that is not the same drawer. |
| **IAM-OPEN-09** | **Backups, and a rehearsed restore.** The database holds a real schema and no backup exists. `02-architecture.md` calls this Phase 0 and not optional. **Blocks go-live, and arguably blocks everything else.** | Nightly `pg_dump`, encrypted, off the box; 30 daily and 12 monthly retained; **one restore performed and timed**, with the time written down. WAL archiving before a second clinic. |
| **IAM-OPEN-10** | **The encryption key has one copy.** `APP_KEK_V1` lives in a `.env` on one laptop. Lose it and every enrolled MFA secret is undecryptable, so everyone re-enrols. Leak it beside a database dump and those secrets are readable. **Blocks go-live.** | The production key is stored outside the repository and outside the database backup, with a written recovery procedure, and the rotation path (`APP_KEK_V2` plus `APP_KEK_ACTIVE`) has been exercised once on staging. |
| **IAM-OPEN-11** | **TLS, and a staging environment.** The HSTS header is set (IAM-N-04) but nothing terminates TLS, and there is no staging. Migrations now rewrite an enum and expand rows; those should never meet patient data for the first time. **Blocks go-live.** | Caddy terminates TLS in front of both applications, HSTS is observed on a real request, and a staging environment has taken the full migration set at least once. |
| **IAM-OPEN-12** | **Nobody is told about break-glass access.** The count is on the audit dashboard, visible only to whoever opens it. | Either a weekly review habit is agreed with the clinic and written down, or `NTF` (V1) notifies on it. |

## D. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **IAM-OPEN-13** | **Employee record link (IAM-F-18).** A user optionally points at an `employee`; IAM owns the login, HR owns the employment. | `v2-05-staff-hr.md` |
| **IAM-OPEN-14** | **Session expiry warning and a fast "switch user" (IAM-Q-02 follow-ons).** An hour of inactivity currently ends in a redirect on the next click. Harmless on a list screen, expensive in a half-written consultation note. | `v0-06-consultation.md` for the warning and autosave; the switch-user affordance once the queue screens exist |
| **IAM-OPEN-15** | **Per-tenant session and MFA policy.** Idle timeout, absolute lifetime and whether "trust this device" is allowed at all are environment settings today. | `v1-08-admin-settings.md`, or `v1-09-rbac-advanced.md` |
| **IAM-OPEN-16** | **Custom roles and an editable permission map.** Six fixed roles today. | `v1-09-rbac-advanced.md` (`RBC`) |
| **IAM-OPEN-17** | **Audit retention and partitioning.** `audit_log` is append-only and grows without limit; monthly partitioning was specified and deferred. Small at clinic volume, not small forever. | `v0-14-audit-trail.md` |
| **IAM-OPEN-18** | **`FRONTDESK` in other module specifications.** Thirty specifications written before the role split still name it. The catalogue in `README.md` is the contract. | Each module, as it is picked up: map `FRONTDESK` to the right one of reception, dispenser or cashier. |
| **IAM-OPEN-19** | **Break-glass on real clinical data.** Proven today against a probe route, because no clinical module exists. | `v0-06-consultation.md`: confirm the audit entry carries the real patient id. |

## E. To confirm with the pilot clinic, in the room

| # | Item | Done when |
|---|---|---|
| **IAM-OPEN-20** | **Does the front-desk split match how they actually work?** The permission mapping in §20 is a proposal. Reception cannot cancel a payment; the cashier cannot dispense; both were judgement calls. | The clinic has seen the three role descriptions in the staff drawer and confirmed or corrected them. |
| **IAM-OPEN-21** | **Is an hour of inactivity right?** Chosen on the assumption of a shared reception computer (IAM-Q-02). | Watched during Phase 1 training. If staff are signed out mid-task, raise `SESSION_IDLE_MINUTES`; if a counter sits open and unattended, lower it. |
| **IAM-OPEN-22** | **Do they understand that accounts are personal?** Every clinical record carries the name of whoever was signed in. The commonest failure in a small clinic is one shared login. | Said explicitly during training, and no account shows an implausible number of concurrent sessions in the first fortnight. |

---

## Closed on 2026-09-21

Kept so the list reads as a history rather than only a backlog.

- Front desk split into reception, dispenser and cashier, with a migration that
  expanded existing assignments and tests proving a cashier cannot dispense.
- Session timeouts shortened to one hour idle and twelve hours absolute.
- Active users by role and branch, the last missing §16 report.
- MFA enrolment: the secret no longer rotates when the screen is reopened, a
  rejected code is audited at enrolment as well as at sign-in, and the replay
  cache is cleared when a new secret is issued.
- Rejected codes are recorded in their own transaction, so a refusal is audited
  **and counted towards the rate limit** rather than rolled back with the
  request. The sign-in path had the same bug.
- Auth guard latency measured, and its two transactions merged into one.
- Trusted-device flow tested end to end, including that it skips only the
  second factor and stops counting after an administrator resets MFA.
