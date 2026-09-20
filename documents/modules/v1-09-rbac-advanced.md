# Advanced RBAC (RBC)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 29 |
| **Depends on** | IAM, TEN, AUD |
| **Depended on by** | ADM, every module's permission checks |
| **Est. effort** | ~35 h |

---

## 1. Purpose & business value

Four fixed roles fit one clinic; they do not fit a chain with a finance officer, an HR manager, an auditor, a locum with restricted hours and a branch manager who must not see HQ finance. This module makes roles configurable per tenant, adds granular permissions, branch-level scoping rules, and clinical-data access controls — without changing how modules check permissions (still `(user, branch, permission)`).

## 2. Actors & permissions

| Action | ADMIN (Org admin) | Branch manager | Others |
|---|:-:|:-:|:-:|
| `rbac.manage` — roles, permission sets | ✓ | – | – |
| Assign roles within own branch (`admin.users` scoped) | ✓ | ✓ | – |
| View permission matrix | ✓ | ✓ | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| RBC-F-01 | Permission catalogue as code (README list, extended by each module) with descriptions, risk level, and "requires reauth" flag; exposed read-only to the UI. | Must |
| RBC-F-02 | Roles per tenant: system roles (`ORG_ADMIN`, `BRANCH_MANAGER`, `DOCTOR`, `NURSE`, `RECEPTION`, `DISPENSER`, `CASHIER`, `FINANCE`, `HR`, `AUDITOR`) seeded and editable (except ORG_ADMIN), plus custom roles; each role = set of permissions + scope rules. V0's four roles map onto these on migration. | Must |
| RBC-F-03 | Scope rules per role assignment: branch list or all; time window (locum: valid from/to; shift hours optional); department (V2 HR). | Must |
| RBC-F-04 | **Clinical data access policy** per tenant: doctors see all patients' clinical records (default) or only patients they have treated / at their branch; nurses see clinical for open encounters at their branch; break-glass for ORG_ADMIN configurable (on/off/alert-only); every clinical read audited (V0) with the policy decision recorded. | Must |
| RBC-F-05 | Segregation-of-duties constraints: configurable pairs that cannot be held by one user at one branch (e.g. `invoice.discount` above cap + `payment.void`; `po.approve` + `po.create` if segregation on). | Should |
| RBC-F-06 | Permission matrix view (roles × permissions) with diff on change; simulation ("what can user X do at branch Y"). | Must |
| RBC-F-07 | Auditor role: read-only across audit, finance reports, clinical aggregates; explicitly no patient-level clinical detail unless granted. | Must |
| RBC-F-08 | Role change propagation via `permission_version` (IAM-R-04) — effective on next request; active sessions of downgraded users are re-evaluated. | Must |
| RBC-F-09 | Approval elevation (BIL's discount elevation, INV adjustments) generalised: any permission can be marked "elevatable by <role>" with reauth. | Should |

## 4. Key workflows

Chain owner creates `FINANCE` user with all-branch finance permissions but no clinical · Locum doctor assigned `DOCTOR` at branch B valid 2 weeks → auto-expires · Auditor reviews discounts and audit log without seeing any consultation.

## 5. Data model

```
role                  id, tenant_id (null = system template), code, name, description, is_system, permissions text[], scope_defaults jsonb, active
role_permission_override   (optional granular per-tenant tweak of a system role) role_id, permission, allow bool
user_role_assignment  id, tenant_id, user_id, role_id, branch_id (nullable = all), valid_from, valid_to, assigned_by, assigned_at, revoked_at
                      -- supersedes user_branch_role from V0 (migrated)
clinical_access_policy  tenant_id pk, doctor_scope enum(ALL, TREATED, BRANCH), nurse_scope enum(OPEN_ENCOUNTERS_BRANCH, BRANCH, NONE), admin_break_glass enum(ON, ALERT, OFF), reception_clinical bool
sod_constraint        id, tenant_id, permission_a, permission_b, description, active
permission_catalog    (code) code pk, module, description, risk enum(LOW, MED, HIGH), reauth bool, elevatable_by text[]
```

## 6. State machines

Assignment: `ACTIVE` (within validity) → `EXPIRED` | `REVOKED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| RBC-R-01 | Effective permissions for `(user, branch)` = ∪ permissions of active assignments whose scope includes the branch and whose validity includes now. | Resolver (cached per request) |
| RBC-R-02 | `ORG_ADMIN` cannot be edited; at least one active ORG_ADMIN always exists. | Service + trigger |
| RBC-R-03 | Clinical read checks consult the policy and record the decision path in the audit entry. | Clinical guard |
| RBC-R-04 | SoD violations block assignment (or warn, per constraint config). | Service |
| RBC-R-05 | Modules never enumerate roles; they check permissions only. | Code review + lint (no `role ===` outside IAM/RBC) |

## 8. API surface

`/rbac/permissions` (catalogue) · `/rbac/roles` CRUD · `/rbac/assignments` CRUD (scoped) · `GET /rbac/matrix` · `GET /rbac/simulate?userId&branchId` · `/rbac/clinical-policy` get/put · `/rbac/sod` CRUD.

## 9. Domain events

**Emits:** `role.created/updated/deleted`, `assignment.created/revoked/expired`, `clinical_policy.changed`, `sod.violation_blocked`
**Consumes:** none

## 10. Audit events

All §9 with before/after permission sets; simulation runs (light); policy changes surfaced on the audit dashboard.

## 11. Screens & UX requirements

Roles list and editor (permission tree grouped by module with risk badges; scope defaults) · Matrix view with search and diff · User assignment editor with validity dates and branch scope · Clinical policy page with plain-language explanations · SoD constraints list · "Simulate as" panel.

## 12. Validation

Role code unique per tenant; permissions must exist in catalogue; validity `to ≥ from`; branch belongs to tenant; SoD checked on assignment.

## 13. Non-functional requirements

Permission resolution ≤ 2 ms per request (cached) · matrix render ≤ 500 ms for 30 roles × 80 permissions · assignment expiry job hourly.

## 14. Edge cases & failure modes

User with overlapping assignments (union) · role deleted while assigned (blocked; deactivate instead) · locum validity ends mid-shift (grace until encounter closes, configurable) · policy `TREATED` for a doctor covering a colleague (temporary grant by branch manager, audited) · ORG_ADMIN break-glass OFF and an emergency (branch manager grants temporary clinical read; audited).

## 15. Compliance

Least-privilege and clinical access minimisation (PDPA); auditor role supports external audits; SoD supports financial control expectations.

## 16. Reporting outputs

Users by role/branch; permission changes over time; break-glass usage; SoD violations blocked; expiring assignments.

## 17. Acceptance tests (representative)

RBC-T-01 custom role with `invoice.read` only → can read, cannot issue · T-02 assignment valid_to yesterday → 403 today · T-03 policy TREATED → doctor cannot open an untreated patient's consultation; audit records policy decision · T-04 SoD pair → assignment blocked · T-05 role permission removed → user's next request lacks it (permission_version) · T-06 last ORG_ADMIN cannot be revoked.

## 18. Migration & rollout

Migrate `user_branch_role` → `user_role_assignment` with system roles; pilot reviews the matrix; clinical policy set explicitly (default ALL for doctors).

## 19. Out of scope

Attribute-based policies beyond scope rules → V3 · SSO group mapping → V3 `SEC` · patient-granted access (portal sharing) → V2 `PPT`.

## 20. Open questions

RBC-Q-01 desired clinical visibility across doctors · Q-02 whether branch managers may assign roles · Q-03 SoD pairs the owner/accountant want enforced.

## 21. Definition of done

- [ ] Must requirements implemented; RBC-T-01 … T-06 green
- [ ] V0 roles migrated; matrix reviewed by the pilot owner
- [ ] Open questions answered
