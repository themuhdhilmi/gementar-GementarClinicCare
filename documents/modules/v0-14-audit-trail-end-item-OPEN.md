# Audit trail — open end items

Everything about `AUD` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The trail itself is finished and hard to argue with: every mutating
route is declared and checked in CI, every entry shares the transaction
of the change it describes, the table refuses an `UPDATE` and a `DELETE`
at the database, and it is partitioned by month before it needs to be.

What is missing is almost entirely **the part where somebody reads it**.
A log nobody looks at is a log that could have been switched off, and
nothing here is on anybody's morning routine yet.

| | |
|---|---|
| **Module** | [v0-14-audit-trail.md](v0-14-audit-trail.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides whether any of this matters

| # | Item | Done when |
|---|---|---|
| **AUD-OPEN-01** | **Nothing draws anybody's attention to anything.** The dashboard has six tiles and they are correct; they are on a screen an administrator visits when they remember to. A break-glass access at 11 p.m., forty failed sign-ins in an hour, an identity number revealed forty times in a day — all recorded, none noticed. This is the same gap as `CON-OPEN-02` and `INV-OPEN-14`, and it is the softest "not a blocker" on the readiness page for all three. | A ten-minute cron that greps for the handful of things worth an email and sends one. It is an hour's work, it closes three registers at once, and it should happen before go-live even though nothing forces it. `AUD-Q-02` is the polished version of the same idea. |

## B. Before the clinic is told what is captured

| # | Item | Done when |
|---|---|---|
| **AUD-OPEN-02** | **Staff have not been told their record views are logged (AUD-Q-01, §18).** Every clinical read writes `clinical.viewed` with the patient's id and the reader's name. That is right, it is what PDPA accountability needs, and nobody who works there knows. The specification recommends a footer note on the clinical screens and there is none. | The owner decides the wording, a line goes on the consultation and patient screens, and it is said out loud in training. Telling people is not a courtesy — a log staff do not know about is a trap, and one they do know about is a deterrent, which is most of its value. |
| **AUD-OPEN-03** | **Retention is a sentence, not a mechanism (AUD-F-15).** Entries are kept because nothing deletes them, which is the right default and is not a policy. The clinical retention period has not been written down anywhere that code can read, and the deliberate act that would eventually delete — dropping the append-only trigger in a change window — has no written procedure. | The retention period is settled with the clinic (`05-safety-and-compliance.md` §3), and the procedure for a retention deletion is written before it is ever needed rather than improvised by somebody at 9 p.m. |
| **AUD-OPEN-04** | **`AUD-N-03` is `IAM-OPEN-09` wearing a different hat.** The audit trail is in the nightly backup exactly as much as the database is, which is to say: not at all, because there is no backup. A partitioned table also restores as a set of partitions, which is a thing to have discovered during a rehearsal rather than during an incident. | `IAM-OPEN-09`, with one restore rehearsal that checks the partitions and their policies came back, not only the rows. |

## C. Measured, or not measured

| # | Item | Done when |
|---|---|---|
| **AUD-OPEN-05** | **`AUD-N-02` has not been measured at the size it names.** The specification asks for a first page under 500 ms at ten million rows over twelve months. `audit-search-load.e2e-spec.ts` exists, is off by default, and seeds a hundred thousand rows across twelve months — a hundredth of the target. It also asserts partition pruning, which is the property that makes the number hold as the table grows. | `AUD_LOAD_TEST=true npm run test:e2e -- test/audit-search-load.e2e-spec.ts`, on the production host, with the figure written into §13. The pilot will not see ten million rows for years; what matters before go-live is that the plan prunes. |
| **AUD-OPEN-06** | **`AUD-N-01` — three milliseconds per audit write — has not been measured either.** It is one insert in a transaction that is already open, so it is almost certainly fine. "Almost certainly" is not a measurement. | Re-run with the other latency numbers on the real host (`IAM-OPEN-01` and friends), which are all on this list for the same reason. |

## D. Smaller things, honestly listed

| # | Item | Why it is here |
|---|---|---|
| **AUD-OPEN-07** | **The interceptor is a backstop, not the mechanism the specification describes.** `AUD-F-03` imagines a Nest interceptor that audits every mutating request from route metadata, reconstructing `before` and `after`. What exists is 156 routes each declaring `@Audited` or `@NotAudited`, a lint rule that fails CI when one says neither, and an interceptor that writes a plain entry **only if the handler wrote nothing itself**. The services write richer entries inside the transaction, which is the only way `AUD-R-02` can hold. The guarantee the specification wanted is met; the mechanism is not the one it named. Written up in §22. |
| **AUD-OPEN-08** | **`AUD-F-08` is met sideways too.** No subscriber persists domain events, because the bus publishes after commit and a subscriber could not share the transaction. Instead `event-coverage.spec.ts` asserts that every one of the 88 domain events either has an audit action recording the same act, is an alias for one, or is on a written list of derived signals — alerts and flags that nobody caused. If a new event appears in none of those, the test fails. Also §22. |
| **AUD-OPEN-09** | **Eight routes are `@NotAudited` and each is a judgement somebody could disagree with.** Consultation autosave and its diagnoses (the record is made at signature), prescription notes and the interaction check, patient search and duplicate checking, MFA enrolment before it is confirmed, blind count entry, and two personal shortcut lists. The reasons are in the decorators and in the lint output. Worth a second opinion from somebody who has had to answer a complaint. |
| **AUD-OPEN-10** | **A diff is shallow.** `shallowDiff` compares top-level keys with `JSON.stringify`, so a change three levels inside a settings object shows as "settings changed" and the reader opens the full snapshots. That is usually what they want; occasionally it is not. |
| **AUD-OPEN-11** | **The export cap is a number nobody has hit.** Fifty thousand rows, and the response says `truncated: true` when it is reached rather than paging. The audit entry for the export records that it was truncated, so at least the gap is visible. Ninety-two days at pilot volume is nowhere near it. |
| **AUD-OPEN-12** | **There is no screen for `patient.document_viewed` or `controlled_register.viewed`.** Both are written, both are searchable through the filter bar, neither has a tile. They are the two other "somebody looked at something sensitive" counters and they were left off because six tiles is already a lot to scan. |
| **AUD-OPEN-13** | **The access-history view takes a patient id, pasted.** On the patient's own record it is a tab and needs nothing typed. On the audit screen, filtering by patient means pasting a uuid, because there is no patient picker there. |
| **AUD-OPEN-14** | **A row in `audit_log_unclaimed` has never actually happened.** The default partition and the `SECURITY DEFINER` count that watches it are both exercised by a test that asserts the count is zero. Nothing has tested the path where it is not — which would mean a month passed with no partition, and the maintenance job failing ninety times running. |
| **AUD-OPEN-15** | **`AUD-T-03` is proved one level below the route.** "The audit insert fails, so the change rolls back" is asserted by writing a patient and a bad audit entry in one transaction and watching both disappear — which proves the rule exactly. The first version did it through the HTTP route, with a trigger on `audit_log`, and `CREATE TRIGGER` takes an ACCESS EXCLUSIVE lock on a table every other suite writes to several times a second: it failed seven tests in two other files, and the version after that hung the whole run. The route-level version would be better evidence and there is no safe way to get it while the suites run in parallel. |

---

## What is actually finished

- Every one of the 156 mutating routes declares whether it is audited,
  and `npm run lint:audited` fails the build if a new one does not.
- Every entry shares the transaction of the change it describes. If the
  insert fails, the change rolls back — proved by making the insert fail
  and watching a patient registration disappear with it.
- `audit_log` refuses `UPDATE` and `DELETE`, through the parent and
  through a partition reached directly, for the application role and for
  the owner.
- Partitioned by month, with a default partition so a missed cron cannot
  stop the clinic, a daily job that keeps three months ahead, and a loud
  report if anything was ever stranded.
- Secrets are redacted before persistence, by key, at any depth; a
  snapshot over 64 KB is replaced by a note saying how big it was.
- Clinical reads, break-glass access and identity unmasking are all
  recorded with the patient they were about, which is what makes the
  per-patient access history answerable in one index.
- The CSV export needs a fresh password, records itself with the filter
  that produced it, and defuses any cell a spreadsheet would treat as a
  formula.
