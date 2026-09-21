# Audit Trail (AUD)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Built. Open items in [v0-14-audit-trail-end-item-OPEN.md](v0-14-audit-trail-end-item-OPEN.md) |
| **Delivery phase** | Phase 0 |
| **Spec sections** | 30 |
| **Depends on** | IAM, TEN |
| **Depended on by** | Every module (as a consumer of their events) |
| **Est. effort** | ~15 h |

---

## 1. Purpose & business value

"Who did what, when, and what did it look like before?" This module answers that for every consequential action in the system — including, critically, *who looked at* a patient's record, not just who changed it.

It exists for four reasons: clinical-legal defensibility, financial control (discounts, voids, stock adjustments), PDPA breach investigation, and the clinic owner's own peace of mind. It is built in Phase 0 because an audit trail retrofitted in month four leaves the first months of real data unauditable — exactly the months you will one day need to reconstruct.

## 2. Actors & permissions

| Actor | Uses AUD to |
|---|---|
| Every module | Write entries (via interceptor or explicit call) |
| ADMIN | Search and read the trail; see the audit dashboard |
| Auditor (V1 role) | Read-only access to the trail |

| Action | ADMIN | Others |
|---|:-:|:-:|
| `audit.read` | ✓ | – |
| Write | System only | System only |

No human has write, update or delete access to `audit_log`. Not even ADMIN.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| AUD-F-01 | Append-only `audit_log` table; the app DB role has `INSERT` and `SELECT` only. No `UPDATE`/`DELETE` grant exists for any application role. | Must |
| AUD-F-02 | Each entry records: tenant, branch, actor (user id + display name snapshot), action, entity type, entity id, before (jsonb), after (jsonb), diff summary, IP, user agent, request id, occurred_at, and optional `subject_patient_id` for patient-related actions. | Must |
| AUD-F-03 | A Nest interceptor audits every mutating request automatically from route metadata (`@Audited('entity.action')`), capturing entity id from the response. | Must |
| AUD-F-04 | Services emit explicit audit entries for domain-meaningful events where an HTTP-level record is insufficient (e.g. a discount applied inside an invoice update, a warning override inside a prescription save). | Must |
| AUD-F-05 | **Read access to clinical records is audited**: opening a consultation, a triage record, a prescription, or a patient's clinical tab writes a `clinical.viewed` entry with `subject_patient_id`. | Must |
| AUD-F-06 | Unmasking an IC/passport number is audited (`patient.id_unmasked`). | Must |
| AUD-F-07 | Break-glass access (ADMIN reading clinical data) is audited as `audit.break_glass` and counted on the dashboard. | Must |
| AUD-F-08 | Every domain event in the catalogue is persisted to the audit log by a subscriber, so the log is also the event history. | Must |
| AUD-F-09 | Sensitive fields (`password_hash`, `mfa_secret_enc`, full IC) are redacted from before/after snapshots by a field allow/deny list per entity. | Must |
| AUD-F-10 | ADMIN can search by date range, actor, action, entity type, entity id, patient, branch; results paginated newest-first. | Must |
| AUD-F-11 | A per-patient "access history" view lists everyone who viewed or changed that patient's records. | Must |
| AUD-F-12 | Audit dashboard: failed logins, break-glass count, voids, stock adjustments, discounts above cap, unmasks — last 24 h / 7 d. | Should |
| AUD-F-13 | Export of a filtered range to CSV (audited itself). | Should |
| AUD-F-14 | Monthly partitioning of `audit_log` by `occurred_at`, with automated partition creation. | Should (before it exceeds ~5 M rows) |
| AUD-F-15 | Retention: audit entries are kept for the clinical record retention period; never purged before it. | Must |

## 4. Key workflows

**Automatic (interceptor)**
1. Route decorated `@Audited('invoice.void')`
2. Interceptor captures `before` by calling the handler's declared loader (or by re-reading entity by id) — optional per route
3. Handler runs; on success, interceptor writes the entry with `after` from the response and `request_id`
4. Failure paths: 4xx are not audited (except auth failures); 5xx write an `error` entry without `after`

**Explicit (service)**
```ts
await this.audit.record(tx, {
  action: 'prescription.warning_overridden',
  entityType: 'prescription_item', entityId: item.id,
  subjectPatientId: patient.id,
  before: null, after: { warning, reason },
})
```
Written **inside the same transaction** as the domain change, so an audit entry never exists without its change and vice versa.

**Investigation**
1. ADMIN → Audit → filter by patient → sees every view/change with actor and time
2. Click entry → full before/after diff, request id for log correlation

## 5. Data model

```
audit_log   (append-only, partitioned by month on occurred_at from AUD-F-14)
  id                uuid pk
  tenant_id         uuid not null
  branch_id         uuid
  actor_id          uuid                    -- null for system jobs
  actor_name        text not null           -- snapshot; survives user rename
  actor_role        text
  action            text not null           -- 'invoice.void', 'clinical.viewed', ...
  entity_type       text not null
  entity_id         uuid
  subject_patient_id uuid                   -- for patient-centric queries
  before            jsonb
  after             jsonb
  diff              jsonb                   -- computed shallow diff for display
  reason            text                    -- when the action required one
  ip                inet
  user_agent        text
  request_id        text
  occurred_at       timestamptz not null default now()
  INDEX (tenant_id, occurred_at desc)
  INDEX (tenant_id, actor_id, occurred_at desc)
  INDEX (tenant_id, subject_patient_id, occurred_at desc)
  INDEX (tenant_id, entity_type, entity_id)
  INDEX (tenant_id, action, occurred_at desc)

audit_redaction_rule   -- code-level config, not a table
```

Grants:
```sql
REVOKE ALL ON audit_log FROM app_role;
GRANT INSERT, SELECT ON audit_log TO app_role;
-- and a BEFORE UPDATE OR DELETE trigger that RAISEs, as belt-and-braces
```

## 6. State machines

None. Entries are immutable facts.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| AUD-R-01 | No application path can update or delete an audit entry. | DB grants + trigger |
| AUD-R-02 | Explicit audit writes share the transaction of the change they describe. | `record(tx, …)` requires a `tx` argument; no non-transactional overload |
| AUD-R-03 | Every mutating route is either `@Audited` or explicitly `@NotAudited(reason)`. | Lint rule + CI |
| AUD-R-04 | Clinical reads are audited at the API layer, not the UI layer, so direct API calls are captured. | Clinical module controllers |
| AUD-R-05 | Redaction is deny-list-by-default for known sensitive fields and applied before persistence, never at display. | Audit service |
| AUD-R-06 | `actor_name` is snapshotted at write time. | Audit service |
| AUD-R-07 | Audit entries are tenant-scoped by RLS like everything else. | TEN |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/audit` | `audit.read` | Filters: `from,to,actorId,action,actionGroup,entityType,entityId,patientId,branchId`. **Page numbers, not a cursor** — the screen has Previous and Next and a total, which a cursor cannot give. A range is mandatory in effect: it defaults to 30 days and is capped at 366, because that is what lets Postgres skip partitions. |
| GET | `/audit/:id` | `audit.read` | Full entry with diff **and both snapshots**. The list carries neither: a page of fifty 64 KB snapshots is megabytes nobody reads. |
| GET | `/patients/:id/access-history` | `audit.read` | AUD-F-11 |
| GET | `/audit/dashboard` | `audit.read` | AUD-F-12 aggregates |
| POST | `/audit/export` | `audit.read` + reauth | CSV of a filtered range, at most 92 days and 50,000 rows; itself audited, with the filter that produced it. |

No write endpoints.

## 9. Domain events

**Emits:** `audit.break_glass`, `audit.exported`
**Consumes:** every event in the catalogue (persists each)

## 10. Audit events

This module *is* the audit log. The minimum set that must be present by end of Phase 0 (extended by each module's §10):

| Category | Actions |
|---|---|
| Access | `auth.login`, `auth.login_failed`, `auth.logout`, `auth.locked`, `session.revoked`, `mfa.*` |
| Users | `user.created`, `user.disabled`, `user.enabled`, `user.role_changed`, `user.password_reset` |
| Tenant | `branch.*`, `tenant.settings_changed` |
| Clinical | `clinical.viewed`, `consultation.signed`, `consultation.amended`, `prescription.*`, `triage.recorded` |
| Patient | `patient.registered`, `patient.updated`, `patient.merged`, `patient.id_unmasked`, `patient.allergy_*`, `patient.exported` |
| Stock | `stock.moved` (all types), `stock.adjusted` (with reason), `catalogue.changed` |
| Money | `invoice.issued`, `invoice.voided`, `invoice.discounted`, `payment.received`, `payment.voided`, `eod.closed` |
| Admin | `admin.settings_changed`, `catalogue.price_changed` |
| Meta | `audit.break_glass`, `audit.exported` |

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Admin → Audit log | Filter bar (date, actor, action group, entity, patient search); virtualised list; row expands to before/after diff rendered as a two-column comparison with changed keys highlighted |
| Patient → Access history | Chronological list of who viewed/changed, with role and branch |
| Admin → Audit dashboard | Tiles: failed logins, break-glass, voids, adjustments, over-cap discounts, unmasks; each links to the filtered log |

## 12. Validation

- Filter date range ≤ 366 days per query
- Export range ≤ 92 days
- `action` values validated against the registered catalogue

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| AUD-N-01 | Audit write adds ≤ 3 ms p95 to a request (single insert, same transaction). |
| AUD-N-02 | Search by patient or actor over 12 months returns first page < 500 ms at 10 M rows (indexes above; partition pruning). |
| AUD-N-03 | Audit storage is included in the nightly backup and restore rehearsal. |
| AUD-N-04 | Partition maintenance is automated; a missing future partition alerts 7 days ahead. |
| AUD-N-05 | Snapshots are capped at 64 KB per side; larger entities store a reference and a diff only. |

### The redaction deny-list (AUD-F-09, AUD-R-05)

Applied **before persistence**, to every key at every depth, in
`audit.service.ts`. A key is redacted when its name matches any of:

`pass` · `secret` · `token` · `hash` · `recovery` · `kek` · `pepper` ·
`otp` · `credential` · `cookie`

Also redacted regardless of key name: any `Buffer` or `Uint8Array`
(a logo, a signature image, a scanned card), and anything nested more
than six levels deep. Dates become ISO strings and `bigint` becomes a
string, so an entry is JSON somebody can read in five years.

It is a **deny-list by key**, not an allow-list by entity, which is the
weaker of the two choices and the one that survives contact with new
modules: an allow-list per entity is a list somebody forgets to extend,
and the failure mode of forgetting is a secret in the log. The failure
mode here is a field called something unexpected, which is why the names
are broad — `hash` catches `passwordHash`, `contentHash` and
`fileHash`, and losing the last two from an audit entry costs nothing.

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Handler succeeds but audit insert fails | The transaction rolls back — the change does not happen. Audit is not best-effort. |
| Bulk operations (import 5 000 patients) | One `patient.imported` entry per batch with counts and a manifest reference, plus per-row entries only for rows that changed existing data. |
| Read audit volume on a busy day | A doctor opening 60 patients/day × 4 staff ≈ 250 clinical.viewed/day/branch. Trivial. Do not debounce or sample. |
| User renamed after entries exist | `actor_name` snapshot preserves the historical name; UI shows current name in a tooltip. |
| Entity hard-deleted (admin catalogue cleanup) | Audit entry retains `entity_id` and the last `before` snapshot; entity link shows "deleted". |
| System/cron actor | `actor_id null`, `actor_name = 'system:<job-name>'`. |
| Request id correlation | `request_id` also appears in application logs; error tracking includes it. |

## 15. Compliance

- Primary evidence for PDPA access accountability and breach investigation.
- Clinical view logging supports professional-conduct inquiries ("who accessed this patient's record").
- Immutability is technical (grants + trigger), which is what an auditor will ask about.
- Retention aligned with clinical records (`../05-safety-and-compliance.md` §3).

## 16. Reporting outputs

- Audit dashboard tiles (AUD-F-12)
- Per-user activity summary (V1 HR/ADM)
- Discount and void reports draw on audit `reason` fields (RPT/FIN)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| AUD-T-01 | Given the app role, when it attempts `UPDATE audit_log` or `DELETE FROM audit_log`, then Postgres rejects it. |
| AUD-T-02 | Given a `@Audited` route, when it succeeds, then exactly one entry exists with matching `request_id`, actor, entity id and `after`. |
| AUD-T-03 | Given a `@Audited` route, when the audit insert is forced to fail, then the domain change is rolled back. |
| AUD-T-04 | Given a DOCTOR opens a consultation, then a `clinical.viewed` entry exists with `subject_patient_id`. |
| AUD-T-05 | Given an entity with `password_hash`, when audited, then the snapshot omits it. |
| AUD-T-06 | Given a mutating route with neither `@Audited` nor `@NotAudited`, when CI runs, then lint fails. |
| AUD-T-07 | Given ADMIN opens a patient's clinical tab, then `audit.break_glass` is recorded and the dashboard count increments. |
| AUD-T-08 | Given 100 000 seeded entries, when filtered by patient over 12 months, then first page < 500 ms. |
| AUD-T-09 | Given an export, then an `audit.exported` entry exists recording the filter used. |

## 18. Migration & rollout

- Live from the first Phase 0 deploy; the pilot's very first login is audited
- Partitioning enabled before go-live (cheap now, painful later)
- Explain to the clinic owner what is captured — it is a selling point, and staff should know record views are logged

## 19. Out of scope

- Tamper-evident hash chaining / external anchoring → V3 `SEC`
- SIEM export / streaming → V3 `INT`
- Auditor role with read-only scope → V1 `RBC`
- Per-user activity reports for HR → V2 `HR`

## 20. Open questions

| ID | Question | Who | Answer, or what was built without one |
|---|---|---|---|
| AUD-Q-01 | Should staff be shown "your record views are logged" on the clinical screens? (Recommended: yes, small footer note.) | You / clinic | **Not answered, and nothing says so on any screen.** Every clinical read is recorded with the reader's name; nobody who works there has been told. A log staff do not know about is a trap; one they do know about is mostly a deterrent, which is the point. `AUD-OPEN-02`. |
| AUD-Q-02 | Does the clinic want a monthly audit summary emailed to the owner? (V1 NTF, cheap.) | Pilot clinic | **Not answered.** Worth asking alongside `AUD-OPEN-01`, which is the ten-minute version of the same thing and is worth doing whatever they say. |

## 21. Definition of done

- [x] **All Must requirements implemented** — `AUD-F-03` and `AUD-F-08` by a different mechanism from the one described; see §22 and `AUD-OPEN-07`/`AUD-OPEN-08`. Everything else as written.
- [x] **AUD-T-01 … T-09 green** — all nine, inside 19 tests in `test/audit.e2e-spec.ts`, except `AUD-T-08`, which is a load test that is off by default (`AUD-OPEN-05`).
- [x] **Grants + trigger verified by attempting a direct SQL update as the app role** — AUD-T-01, three ways: through the parent, through a partition reached directly, and as the owner. The grants themselves are `IAM-OPEN-05`, which is the unprivileged role nobody has created yet; the trigger holds regardless, which is why it is there.
- [x] **`@Audited`/`@NotAudited` lint rule enforced** — `npm run lint:audited`, in `npm run lint`, across all 156 mutating routes. It also refuses an action that is not in the catalogue, and an exemption with no real reason.
- [x] **Redaction deny-list documented in code and here** — `audit.service.ts`, by key at any depth, plus a 64 KB cap per snapshot side. See §13 below.
- [x] **Partitioning in place with automated maintenance** — monthly, with a default partition so a missed job cannot stop the clinic, a daily job three months ahead, and a `SECURITY DEFINER` count that reports anything stranded.
- [ ] **Every V0 module's §10 audit events cross-checked against this catalogue at Phase 4** — done for the 88 domain events by `event-coverage.spec.ts`, which fails if a new one is neither recorded nor documented as derived. The per-module §10 lists have not been walked by hand.
- [x] **Open questions answered** — §20, two of two as "asked, not answered".

### Traceability

| Requirement | Where it lives | Proved by |
|---|---|---|
| AUD-F-01 append-only | Trigger on the partitioned parent | AUD-T-01 |
| AUD-F-02 what an entry holds | `audit_log`, `AuditService.record` | AUD-T-02 |
| AUD-F-03 interceptor from route metadata | `@Audited`, `AuditInterceptor` | A backstop, not the mechanism — §22, `AUD-OPEN-07` |
| AUD-F-04 explicit service entries | `record(tx, …)` everywhere | Most of the trail; the interceptor rarely fires |
| AUD-F-05 clinical reads audited | PAT, CON, TRI controllers | AUD-T-04 |
| AUD-F-06 unmasking audited | `patients.controller` | "unmasking an identity number is recorded" |
| AUD-F-07 break-glass | `PermissionGuard` | AUD-T-07, including that a doctor doing the same is not flagged |
| AUD-F-08 events are the log | `event-coverage.ts` | 88 events, each recorded, aliased or documented as derived |
| AUD-F-09 redaction | `redact`, by key at any depth | AUD-T-05 |
| AUD-F-10 search | `AuditQueryService.search` | Filters by actor, group, entity and patient |
| AUD-F-11 access history | `accessHistory` | Its own test, and a tab on the patient record |
| AUD-F-12 dashboard | `dashboard` | Six tiles, each linking to the entries behind it |
| AUD-F-13 export | `exportCsv` | AUD-T-09, including the spreadsheet-formula defence |
| AUD-F-14 partitioning | `20260921200000_audit_partitioning` | Writes land in the right month; the job keeps ahead |
| AUD-F-15 retention | Nothing deletes | True by default, not by policy — `AUD-OPEN-03` |
| AUD-R-01 no rewrite | Trigger | AUD-T-01 |
| AUD-R-02 shares the transaction | `record(tx, …)` has no other form | AUD-T-03: the entry fails, the patient is not created. Proved below the route — `AUD-OPEN-15` |
| AUD-R-03 every route declares | `check-audited-routes.ts` | AUD-T-06, all three failure modes |
| AUD-R-04 audited at the API | Controllers, not the UI | AUD-T-04 goes straight to the API |
| AUD-R-05 redact before persistence | `record` | AUD-T-05 |
| AUD-R-06 actor name snapshotted | `record` | "the actor name is a snapshot, not a join" |
| AUD-R-07 tenant-scoped by RLS | Parent **and** every partition | The direct-partition read is scoped too |
| AUD-N-01 ≤ 3 ms | One insert in an open transaction | **Not measured** — `AUD-OPEN-06` |
| AUD-N-02 < 500 ms at 10 M | Five indexes, partition pruning | **Not measured at that size** — `AUD-OPEN-05` |
| AUD-N-03 in the backup | — | `IAM-OPEN-09`, `AUD-OPEN-04` |
| AUD-N-04 partition maintenance | `AuditPartitionJob` | Three months ahead; idempotent; reports stranded rows |
| AUD-N-05 64 KB cap | `cap()` | An 80 KB snapshot becomes a note saying it was 80 KB |

## 22. Notes worth keeping

1. **`@Audited` is a declaration, not the mechanism.** The specification
   imagines an interceptor that audits every mutating request by itself,
   reconstructing `before` and `after` from the route. An interceptor
   cannot see that a discount was applied inside an invoice update, or
   that a prescriber overrode an interaction warning, or which of four
   rows a transition touched. The services record all of that, inside
   the transaction, where AUD-R-02 requires it. So the decorator names
   the action, the lint rule makes the declaration mandatory on all 156
   mutating routes, and the interceptor writes a plain entry **only if
   the handler wrote nothing itself**. "Every mutating route is audited"
   becomes true by construction rather than by everyone having
   remembered, and the detail is not traded for uniformity.

2. **No subscriber persists domain events, deliberately.** AUD-F-08 asks
   for one. The bus publishes *after* commit and only logs a failing
   subscriber, so an entry written from there could not share the fate of
   its change — which is the one rule this module cannot bend — and it
   would double-log almost everything. Instead `event-coverage.spec.ts`
   asserts that each of the 88 domain events either has an audit action
   recording the same act, is an alias for one, or is on a written list
   of derived signals: a low-stock alert, an abnormal vital, a warning
   raised. Nobody *did* those, and an entry whose actor is a cron job
   buries the ones where somebody chose something.

3. **The default partition exists because audit is not best-effort.** A
   write with no partition for its month fails; a failed audit write
   rolls back the change it describes; so a cron that did not run would
   stop a doctor signing a note. The default partition means that
   failure mode becomes "some rows are in the wrong file and a job
   shouts about it every morning", which is recoverable in a change
   window. The trade is deliberate: the log has to be reliable, and the
   clinic has to keep working.

4. **Each partition carries its own row-level security, and that bit us
   once.** A partition reached directly bypasses the parent's policies,
   so every one gets the same `tenant_isolation` policy when it is
   created. The consequence is easy to miss: a *platform*-scope query
   has no tenant, so `SELECT count(*) FROM audit_log_unclaimed` returns
   zero however many rows are stranded — the check that was meant to
   shout would have been silent forever. It goes through a
   `SECURITY DEFINER` function that returns a number and never a row.

5. **The CSV export defuses spreadsheet formulas.** A cell beginning
   `=`, `+`, `-` or `@` is a formula to Excel, and this file is full of
   strings a user chose — an actor's name, a cancellation reason.
   `=cmd|'/c calc'!A1` typed into a reason field is an attack on
   whoever opens the export, not on this system. A leading apostrophe
   makes it text, and there is a test that types exactly that.

6. **The gap is not the trail, it is the reading of it.** Everything
   here is recorded, immutable, searchable and fast. Nothing tells
   anybody that a break-glass access happened at 11 p.m.
   `AUD-OPEN-01` is an hour of work and closes the same gap in three
   other modules.
