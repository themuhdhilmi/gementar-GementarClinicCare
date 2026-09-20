# Audit Trail (AUD)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
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
| GET | `/audit` | `audit.read` | Filters: `from,to,actorId,action,entityType,entityId,patientId,branchId`; cursor pagination |
| GET | `/audit/:id` | `audit.read` | Full entry with diff |
| GET | `/patients/:id/access-history` | `audit.read` | AUD-F-11 |
| GET | `/audit/dashboard` | `audit.read` | AUD-F-12 aggregates |
| POST | `/audit/export` | `audit.read` + reauth | CSV of a filtered range; itself audited |

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

| ID | Question | Who |
|---|---|---|
| AUD-Q-01 | Should staff be shown "your record views are logged" on the clinical screens? (Recommended: yes, small footer note.) | You / clinic |
| AUD-Q-02 | Does the clinic want a monthly audit summary emailed to the owner? (V1 NTF, cheap.) | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] AUD-T-01 … T-09 green
- [ ] Grants + trigger verified by attempting a direct SQL update as the app role
- [ ] `@Audited`/`@NotAudited` lint rule enforced
- [ ] Redaction deny-list documented in code and here
- [ ] Partitioning in place with automated maintenance
- [ ] Every V0 module's §10 audit events cross-checked against this catalogue at Phase 4
