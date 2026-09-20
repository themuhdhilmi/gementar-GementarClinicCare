# Tenancy & Branch (TEN)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 0 |
| **Spec sections** | 26, 27 |
| **Depends on** | IAM |
| **Depended on by** | Every module |
| **Est. effort** | ~20 h |

> `../03-multi-tenancy.md` is the design rationale. This spec is the build contract.

---

## 1. Purpose & business value

Gementar ClinicCare is sold to many clinic companies. Each is a **tenant** with its own branches, staff, patients, stock and money. A tenant must never see another tenant's data — not by convention, not by careful coding, but by construction. This module is what makes that true, and it is the module whose failure would end the company.

Within a tenant, a **branch** is a physical clinic. Stock, queues, cash drawers and staff shifts are physical, so they belong to a branch. Patients, the medicine catalogue and memberships are not, so they belong to the tenant. That distinction is the second thing this module gets right.

## 2. Actors & permissions

| Actor | Uses TEN to |
|---|---|
| Every request | Resolve tenant + branch context; be isolated |
| ADMIN | Create and configure branches; set operating hours; set tenant-level settings |
| Platform operator (you) | Create tenants; suspend; set plan (V1 makes this self-serve) |

| Action | ADMIN | Others |
|---|:-:|:-:|
| View branches they have a role at | ✓ | ✓ |
| `admin.settings` — create/edit branch, tenant settings | ✓ | – |
| Create tenant, suspend tenant, set plan | Platform only | – |

## 3. Functional requirements

### Tenant
| ID | Requirement | Priority |
|---|---|---|
| TEN-F-01 | A tenant has a name, slug (subdomain-safe, immutable), status, plan, timezone (default `Asia/Kuala_Lumpur`), currency (`MYR` only in V0), and a `settings jsonb`. | Must |
| TEN-F-02 | Tenants are created by a platform-level CLI/seed in V0 (no self-serve). | Must |
| TEN-F-03 | Suspending a tenant blocks all logins and returns 403 on all API calls for that tenant, with a clear message. Data is retained. | Must |
| TEN-F-04 | Tenant settings are a validated JSON document with a schema and defaults (e.g. `billing.max_discount_pct_frontdesk`, `queue.number_format`, `clinical.abnormal_thresholds`). Modules read settings through a typed `SettingsService`, never raw JSON. | Must |
| TEN-F-05 | Module feature flags per tenant (`modules.membership.enabled` …) exist in V0, all V1+ flags default off. | Should |

### Branch
| ID | Requirement | Priority |
|---|---|---|
| TEN-F-06 | A branch has name, code (short, unique per tenant, used in numbering series), address, phone, email, registration/licence number, operating hours (per weekday, multiple ranges), status, and its own `settings jsonb` overriding tenant settings. | Must |
| TEN-F-07 | ADMIN creates, edits, and deactivates branches. Deactivation is blocked while the branch has open encounters or non-zero stock. | Must |
| TEN-F-08 | Every physical entity (encounter, batch, stock movement, invoice, payment, cash session) carries `branch_id`. | Must |
| TEN-F-09 | Branch settings resolve as `branch.settings ⊕ tenant.settings ⊕ defaults`. | Must |
| TEN-F-10 | Branch letterhead assets (logo, header text, footer text) stored for DOC. | Should |

### Isolation
| ID | Requirement | Priority |
|---|---|---|
| TEN-F-11 | Every table has `tenant_id uuid NOT NULL` with RLS `ENABLE` + `FORCE`, and a policy with both `USING` and `WITH CHECK` against `current_setting('app.tenant_id', true)::uuid`. | Must |
| TEN-F-12 | The application connects as a role that is **not** the table owner and does **not** have `BYPASSRLS`. Migrations run as a separate privileged role. | Must |
| TEN-F-13 | `withTenant(ctx, fn)` wraps each request's database work in one interactive transaction that first executes `set_config('app.tenant_id', $1, true)`. | Must |
| TEN-F-14 | A generated test asserts, for every table in the schema, that RLS is enabled and forced and a tenant policy exists. New tables fail CI until covered. | Must |
| TEN-F-15 | The isolation suite (`../03-multi-tenancy.md`) runs in CI on every push. | Must |
| TEN-F-16 | Branch-level access is enforced in the application layer via `user_branch_role`, not in RLS. | Must |
| TEN-F-17 | Slow work (PDF, S3, outbound HTTP) never runs inside the tenant transaction. A lint rule flags known slow clients being called inside `withTenant`. | Should |

## 4. Key workflows

**Request lifecycle**
1. Auth guard resolves session → `TenantContext`
2. Interceptor opens `withTenant` transaction, sets `app.tenant_id`
3. Handler runs with a scoped `tx`; services receive `tx`, never the global client
4. Commit → domain events dispatched → response

**Onboard a new tenant (V0, platform-side)**
1. `pnpm cli tenant:create --name --slug --admin-email` → tenant, first branch, first ADMIN invite
2. ADMIN logs in, completes branch details, letterhead, settings
3. Catalogue import (INV), staff (IAM), opening stock (INV)

**Add a branch (V2 in practice, but supported from V0)**
1. ADMIN → Branches → New
2. Assign staff roles at the branch (IAM)
3. Branch appears in switcher for those users; stock starts at zero

## 5. Data model

```
tenant
  id            uuid pk
  name          text not null
  slug          text not null unique     -- immutable
  status        enum(ACTIVE, SUSPENDED, CLOSED) not null
  plan          text not null default 'pilot'
  timezone      text not null default 'Asia/Kuala_Lumpur'
  currency      char(3) not null default 'MYR'
  settings      jsonb not null default '{}'
  modules       jsonb not null default '{}'   -- feature flags
  tin           text                          -- for e-Invoice (V1)
  business_reg_no text
  -- NOTE: tenant itself is not RLS-scoped by tenant_id (it *is* the tenant);
  -- access is by platform role or by session tenant match in the service layer.

branch
  id            uuid pk
  tenant_id     uuid not null → tenant
  code          text not null                 -- e.g. 'KL01', used in numbering
  name          text not null
  address_line1 text, address_line2 text, city text, state text, postcode text
  phone         text, email text
  licence_no    text                          -- clinic registration (e.g. PHFSA/KKM)
  timezone      text                          -- overrides tenant if set
  operating_hours jsonb not null default '{}' -- { mon: [["09:00","13:00"],["14:00","21:00"]], ... }
  settings      jsonb not null default '{}'
  letterhead    jsonb                         -- { logoKey, headerText, footerText }
  status        enum(ACTIVE, INACTIVE) not null
  UNIQUE (tenant_id, code)
  INDEX (tenant_id, status)

tenant_setting_schema   -- code-level, not a table: zod schema with defaults, versioned
```

## 6. State machines

**Tenant**: `ACTIVE` ⇄ `SUSPENDED` → `CLOSED` (terminal; data retained per retention policy, logins impossible).
**Branch**: `ACTIVE` ⇄ `INACTIVE` (guarded by TEN-F-07).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| TEN-R-01 | `tenant_id` is never accepted from any request input. | Auth guard; CI grep on DTOs |
| TEN-R-02 | Every table: `tenant_id NOT NULL`, RLS enabled + forced, policy with USING + WITH CHECK. | Generated test (TEN-F-14) |
| TEN-R-03 | The app DB role has no `BYPASSRLS` and owns no tables. | Migration + startup assertion that queries `pg_roles` and refuses to boot otherwise |
| TEN-R-04 | With `app.tenant_id` unset, every tenant-scoped query returns zero rows and every insert fails. | Isolation suite |
| TEN-R-05 | `branch_id`, where present, must reference a branch of the same tenant. | FK + composite check `(tenant_id, branch_id)` via a `branch (id, tenant_id)` unique constraint |
| TEN-R-06 | A user's active branch must be one they hold a role at. | Auth guard on every request, not just on switch |
| TEN-R-07 | Physical entities are always branch-scoped; catalogue entities never are. See the scoping table in `../03-multi-tenancy.md`. | Schema review; each module spec declares scope |
| TEN-R-08 | Branch `code` is immutable once any numbered document exists for it. | Service |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/tenant` | session | Own tenant summary + resolved settings for the active branch |
| PATCH | `/tenant/settings` | `admin.settings` | Validated against schema; returns resolved result |
| GET | `/branches` | session | Branches the user has a role at |
| GET | `/branches/all` | `admin.settings` | All tenant branches |
| POST | `/branches` | `admin.settings` | |
| GET | `/branches/:id` | session (role at branch) | |
| PATCH | `/branches/:id` | `admin.settings` | |
| PATCH | `/branches/:id/settings` | `admin.settings` | |
| PUT | `/branches/:id/letterhead` | `admin.settings` | Multipart logo |
| POST | `/branches/:id/deactivate` | `admin.settings` | Guarded (TEN-F-07) |
| POST | `/branches/:id/activate` | `admin.settings` | |

Platform-only (CLI, not HTTP in V0): `tenant:create`, `tenant:suspend`, `tenant:resume`, `tenant:set-plan`.

## 9. Domain events

**Emits:** `branch.created`, `branch.updated`, `branch.deactivated`, `tenant.settings_changed`, `tenant.suspended`
**Consumes:** none

## 10. Audit events

All of §9, plus every settings change with before/after diff. Tenant suspension records the platform actor.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Admin → Clinic settings | Tenant name, timezone, business details, TIN; grouped settings form generated from the schema with inline help |
| Admin → Branches | List; create/edit form; operating hours editor (per day, multiple ranges, copy-to-all); letterhead upload with live preview; deactivate with guard explanation |
| Branch switcher | In header (owned by IAM UI, data from TEN) |

## 12. Validation

- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`, immutable
- Branch code: `^[A-Z0-9]{2,8}$`, unique per tenant, immutable after first document
- Operating hours: ranges within a day do not overlap; `HH:MM` 24 h
- Postcode: 5 digits for MY addresses
- Settings: rejected unless valid against the current schema version; unknown keys rejected

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| TEN-N-01 | `set_config` + transaction wrapping adds ≤ 2 ms p95 per request. |
| TEN-N-02 | Startup refuses to boot if the DB role has `BYPASSRLS` or owns any table (TEN-R-03). |
| TEN-N-03 | Isolation suite runtime < 60 s so it runs on every push without being skipped. |
| TEN-N-04 | Settings resolution is cached per request; changes are visible on the next request. |
| TEN-N-05 | No tenant transaction may exceed 5 s; a timeout aborts it and logs the handler name. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Developer forgets `withTenant` on a new endpoint | The global Prisma client is not injectable into handlers; only the scoped `tx` is. Using the global client outside migrations/jobs fails lint. |
| Background job (nightly reconciliation) needs to span tenants | Jobs iterate tenants explicitly and open `withTenant` per tenant. There is no "all tenants" query path in application code. |
| Tenant suspended mid-shift | In-flight requests complete; next request 403. Clinic sees a suspension banner with the platform contact. |
| Two branches share the same physical stock room | Not supported. Model as one branch. Document this constraint for sales. |
| Branch timezone differs from tenant | Supported (e.g. Sabah clinic under KL HQ is the same zone, but keep it general). Reports use branch timezone. |
| Settings schema version upgrade | Migration transforms stored JSON; old keys are mapped or dropped with a logged warning. Never silently ignored. |

## 15. Compliance

- Data isolation is the primary PDPA technical control. The isolation suite output is part of the compliance evidence pack.
- Branch `licence_no` and tenant `business_reg_no` / `tin` are needed for e-Invoice (V1 `EIV`) and printed documents.
- Data residency: tenant data lives in one region; the region is recorded on the tenant (`settings.region`) for when a second region exists.

## 16. Reporting outputs

- Branch list with status (admin dashboard)
- Per-branch breakdowns for every RPT/FIN report are keyed on `branch_id` from this module

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| TEN-T-01 | Given tenants A and B each with one patient, when A lists patients, then only A's patient is returned. |
| TEN-T-02 | Given A knows B's patient id, when A reads it, then 404. |
| TEN-T-03 | Given A knows B's patient id, when A updates it, then 404 and B's row is unchanged. |
| TEN-T-04 | Given A attempts an insert with `tenant_id = B`, then Postgres rejects it (WITH CHECK). |
| TEN-T-05 | Given `app.tenant_id` unset, when any tenant table is queried, then zero rows. |
| TEN-T-06 | Given the full schema, when the generated RLS test runs, then every table has RLS enabled, forced, and a policy — and adding a table without them fails. |
| TEN-T-07 | Given the app role has `BYPASSRLS`, when the API boots, then it refuses with a clear error. |
| TEN-T-08 | Given a user with a role at branch A only, when they set active branch B, then 403. |
| TEN-T-09 | Given a branch with open encounters, when ADMIN deactivates it, then rejected with the count of open encounters. |
| TEN-T-10 | Given an invalid settings key, when PATCHed, then 422 naming the key. |

## 18. Migration & rollout

- Phase 0: create pilot tenant + branch via CLI; record `licence_no`, letterhead
- Second branch for the pilot group (if any) created in V2 when BRN ships, though the schema supports it now

## 19. Out of scope

- Tenant self-service signup, billing plans, module toggle UI → V1 `ADM`
- Stock transfer, branch pricing, HQ consolidation → V2 `BRN`
- Database-per-tenant → not planned
- Multi-region → V3

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| TEN-Q-01 | Is the pilot a single clinic, or one branch of a group that will add more? Affects how soon BRN is needed. | Pilot clinic |
| TEN-Q-02 | Clinic registration / licence number format to print on documents? | Pilot clinic |
| TEN-Q-03 | Does the clinic have a view on data leaving Malaysia (hosting region)? | Pilot clinic |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] TEN-T-01 … T-10 green in CI
- [ ] Generated RLS test covers every table and is wired into CI
- [ ] Startup role assertion in place
- [ ] Settings schema v1 documented with every key, type and default
- [ ] `../03-multi-tenancy.md` updated with any deviations
- [ ] Open questions answered
