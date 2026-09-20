# Tenancy & Branch (TEN)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Built. Open items in [v0-02-tenancy-branch-end-item-OPEN.md](v0-02-tenancy-branch-end-item-OPEN.md) |
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
  letterhead    jsonb                         -- { headerText, footerText }
  letterhead_logo            bytea            -- the image itself, ≤ 512 KiB
  letterhead_logo_mime       varchar(60)
  letterhead_logo_updated_at timestamptz(3)
  status        enum(ACTIVE, INACTIVE) not null
  UNIQUE (tenant_id, code)
  INDEX (tenant_id, status)

tenant_setting_schema   -- code-level, not a table: zod schema with defaults, versioned
```

**As built, two deviations from the sketch above.** The logo is three columns
rather than a `logoKey` in the jsonb: there is no object storage in V0, and an
image inside `letterhead` would be carried by every read of a branch. See §22
note 8. And `operating_hours` stores only the days the clinic is open — a day
it is shut is an absent key, not an empty list — so "not set" and "closed
every day" cannot be confused.

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
| PATCH | `/branches/:id/letterhead` | `admin.settings` | Header and footer text |
| PUT | `/branches/:id/letterhead/logo` | `admin.settings` | Multipart logo, PNG/JPEG/SVG, ≤ 512 KB |
| GET | `/branches/:id/letterhead/logo` | session (role at branch) | The image, on its own route so a branch read never carries it |
| DELETE | `/branches/:id/letterhead/logo` | `admin.settings` | |
| POST | `/branches/:id/deactivate` | `admin.settings` | Guarded (TEN-F-07) |
| POST | `/branches/:id/activate` | `admin.settings` | |

Platform-only, over the CLI rather than HTTP in V0 (TEN-F-02):

```bash
npm run tenant --workspace @gementar/api -- create   --slug klinik-pilot --name "Klinik Pilot" --branch KL01
npm run tenant --workspace @gementar/api -- list
npm run tenant --workspace @gementar/api -- suspend  --slug klinik-pilot --reason "Unpaid invoice"
npm run tenant --workspace @gementar/api -- resume   --slug klinik-pilot
npm run tenant --workspace @gementar/api -- set-plan --slug klinik-pilot --plan standard
npm run tenant --workspace @gementar/api -- modules  --slug klinik-pilot --on appointments
```

Each one writes to the clinic's own audit trail as `platform:<operator>`, with no
actor id — there is no user row for whoever runs the platform, and an entry
that says so is more honest than one that borrows an administrator's name.

## 9. Domain events

**Emits:** `branch.created`, `branch.updated`, `branch.deactivated`, `tenant.settings_changed`, `tenant.suspended`
**Consumes:** none

## 10. Audit events

All of §9, plus every settings change with before/after diff. Tenant suspension records the platform actor.

## 11. Screens & UX requirements

| Screen | Requirements | Built |
|---|---|---|
| Admin → Clinic settings | Tenant name, timezone, business details, TIN; grouped settings form generated from the schema with inline help | `/admin/clinic`. The settings half is generated from `schema.fields`, so a setting added on the server appears here with its help text and default. The module list is shown read-only, because switching one on is a commercial conversation, not a toggle. |
| Admin → Branches | List; create/edit form; operating hours editor (per day, multiple ranges, copy-to-all); letterhead upload with live preview; deactivate with guard explanation | `/admin/branches`. One drawer rather than a wizard, because most clinics open it twice ever. Per-branch setting overrides are a tick box beside each setting, and unticking one removes it rather than freezing today's value (§22 note 2). |
| Branch switcher | In header (owned by IAM UI, data from TEN) | Built with IAM. Shown only when someone holds a role at more than one branch. |

## 12. Validation

- Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`, immutable
- Branch code: `^[A-Z0-9]{2,8}$`, unique per tenant, immutable after first document
- Operating hours: ranges within a day do not overlap; `HH:MM` 24 h
- Postcode: 5 digits for MY addresses
- Settings: rejected unless valid against the current schema version; unknown keys rejected

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| TEN-N-01 | `set_config` + transaction wrapping adds ≤ 2 ms p95 per request. **Three round trips, counted exactly.** See below. |
| TEN-N-02 | Startup refuses to boot if the DB role has `BYPASSRLS` or owns any table (TEN-R-03). `assertDatabaseGuards()`, proved by TEN-T-07. |
| TEN-N-03 | Isolation suite runtime < 60 s so it runs on every push without being skipped. **Measured: 2.0 s for 17 tests.** |
| TEN-N-04 | Settings resolution is cached per request; changes are visible on the next request. `SettingsService` over `DbService.once`. |
| TEN-N-05 | No tenant transaction may exceed 5 s; a timeout aborts it and logs the handler name. `DB_TX_TIMEOUT_MS`, default 5000. |

### TEN-N-01, counted rather than timed

Wrapping a request costs exactly three round trips: `BEGIN`, the `set_config`
that fixes the tenant, and `COMMIT`. `test/roundtrips.e2e-spec.ts` counts them
from the driver's query log and fails if a fourth appears, which is a stabler
test than a millisecond budget — the milliseconds are the network's, and the
count is the code's.

Three round trips against a database on the same host is about 0.15 ms, well
inside the 2 ms allowed. Against the LAN this was developed on it is nearer
2.2 ms, which is the network and not this module. `IAM-OPEN-01` covers
re-measuring both on the production host.

### TEN-N-04, and why the cache cannot go stale

`SettingsService` resolves the three layers once and keeps the answer in the
unit of work's own store, which is created when the transaction opens and
discarded when it closes. There is no cross-request cache, so there is no
invalidation to get wrong: a change made by one request is read fresh by the
next. The one case that needs care is the request that *makes* the change, and
it calls `invalidate` before reading back.

### TEN-N-05, and how the handler gets named

The interceptor that opens the per-request transaction labels it with the
controller and method. A transaction that overruns is aborted by PostgreSQL
and the log says which handler held it, rather than leaving a bare `P2028`.
`TEN-F-17` is the matching preventative: `npm run lint:slow` refuses source
that calls a slow client inside a scope, and `assertOutsideScope` refuses it at
runtime in the mailer, which is the one slow client that exists today.

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

- **Branch list with status** — the table on `/admin/branches`, with the code,
  where it is, which days it is open and whether it is active. `GET
  /branches/all` is the same data for anything else that needs it.
- **Per-branch breakdowns** for every RPT/FIN report are keyed on `branch_id`
  from this module. Nothing to build here: the requirement is that `branch_id`
  is present and correct on physical records, which is TEN-F-08 and is
  enforced by each module as it lands.

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

All three are questions for the clinic, not decisions the code can make. What
the code does in the meantime, so that none of them blocks the build:

### TEN-Q-01 — one clinic, or the first of several?

**Built as if the answer is "several", because the cost of doing so was
nothing.** A branch was always going to be a row rather than a deployment, and
every physical record already carries `branch_id` (TEN-F-08). The branch
screen creates the second branch as readily as the first, the header already
switches between them, and a user holds a role per branch rather than one role
overall.

What is genuinely deferred to `BRN` (V2) is everything *between* branches:
stock transfers, consolidated reporting, pricing that differs by branch. Those
are real work, and none of them is needed to run two clinics independently on
one account.

**So the answer changes nothing about what to build now.** It changes when
`v2-01-multi-branch.md` is scheduled. Ask it, write the answer here, and move
on.

### TEN-Q-02 — what licence number format?

**Stored as free text, up to 60 characters, at both levels.** The clinic's
business registration number and TIN are on the tenant; the practice licence
is on the branch, because a group with three clinics has three licences.

No format is enforced, deliberately. Malaysian clinic licensing has changed
format more than once, a private practice under the Private Healthcare
Facilities and Services Act carries a different reference from a company's SSM
number, and a validation rule invented here would be wrong in a way that stops
the clinic printing an invoice. The field is printed exactly as typed.

**What to confirm in the room:** which number they expect to see on a receipt,
and whether they want it labelled. That is a `DOC` question about the template,
not a `TEN` question about the column.

### TEN-Q-03 — does the data leave Malaysia?

**Assume it must not, because that is the answer that is expensive to change
later.** PDPA does not flatly forbid transfer abroad, but it is the question a
clinic's own compliance person asks first, and being able to answer "it is in
Malaysia" ends the conversation.

Nothing in the build depends on the region, so this is a hosting decision
rather than a code one. The tenant carries the region so that a second region
is possible without a migration. Until a clinic asks for one, one region is
simpler and one region is what should be bought.

**What to confirm:** that the pilot is content with a Malaysian VPS, and that
the backup destination (`IAM-OPEN-09`) is in the same jurisdiction — an
encrypted dump sitting in a bucket in Virginia is the part people forget.

## 21. Definition of done

- [x] **All Must requirements implemented** — see the traceability table below.
- [x] **TEN-T-01 … T-10 green in CI** — T-01 to T-08 in `test/tenant-isolation.e2e-spec.ts`, T-09 and T-10 in `test/tenancy-branch.e2e-spec.ts`. Each test names its id.
- [x] **Generated RLS test covers every table and is wired into CI** — TEN-T-06 reads `pg_class` and `pg_policy` at run time rather than from a list, so a table added in a year's time fails it. A model that is neither tenant-scoped nor platform also fails, so the classification cannot be skipped.
- [x] **Startup role assertion in place** — `assertDatabaseGuards()`, with `DB_GUARD_MODE` of `auto`, `require` or `off`. CI sets `require`.
- [x] **Settings schema v1 documented with every key, type and default** — the schema documents itself: `GET /tenant` returns every field with its type, default and help text, and the settings screen is generated from that. §22 note 4 explains why there is no second list in prose.
- [x] **`../03-multi-tenancy.md` updated with any deviations** — no deviations. The two layers, the narrow bypass and the branch-level rule are as designed; what this module added is the settings document and the branch lifecycle, neither of which touches isolation.
- [x] **Open questions answered** — §20. All three are for the clinic; none of them blocks the build, and what the code does meanwhile is written down.

### Traceability

| Requirement | Where it lives | Proved by |
|---|---|---|
| TEN-F-01 tenant fields | `prisma/schema.prisma`, `TenantService.describe` | `GET /tenant` in the suite |
| TEN-F-02 tenants from the CLI | `scripts/tenant.ts` | Exercised by hand; create, suspend, resume and set-plan |
| TEN-F-03 suspension blocks everything | `SessionGuard`, `TenantSuspendedError` | "refuses every call with 403" |
| TEN-F-04 validated settings document | `settings/tenant-settings.ts`, `SettingsService` | 8 unit tests, 6 end-to-end |
| TEN-F-05 module feature flags | `settings/module-flags.ts` | 4 unit tests, 2 end-to-end |
| TEN-F-06 branch fields | `BranchService`, `branch.validation.ts` | create, update and validation tests |
| TEN-F-07 guarded deactivation | `BranchDeactivationRegistry` | TEN-T-09 |
| TEN-F-08 `branch_id` on physical entities | Schema convention | Enforced per module as each lands |
| TEN-F-09 three-layer resolution | `resolveSettings` | "resolves branch over tenant over default" |
| TEN-F-10 letterhead | `letterhead.ts`, four routes | 5 end-to-end tests |
| TEN-F-11 … F-16 isolation | Built with IAM | `test/tenant-isolation.e2e-spec.ts`, 17 tests |
| TEN-F-17 no slow work in a scope | `npm run lint:slow`, `assertOutsideScope` | The rule is itself tested against a planted violation |
| TEN-R-01 … R-08 | Guards, services, database | Isolation suite and the branch suite |
| TEN-N-01 … N-05 | §13 | Counted or measured, not asserted |

## 22. Notes worth keeping

1. **The patch schema must not carry defaults.** Zod's `.partial()` leaves each
   field a `ZodDefault`, which fills itself in when the key is absent. Built
   that way, changing one billing setting silently writes down today's value
   for every other billing setting — and the clinic is then frozen on them,
   because a later change to a default can no longer reach a key that is
   written down. `patchGroup` strips the defaults. A test states the trap so
   nobody reintroduces it, and the same trap was found and fixed a second time
   in the letterhead schema.

2. **`null` means "stop overriding", and it is not the same as writing down the
   current value.** Unticking a branch override has to *remove* the key. If the
   screen sent the clinic's present value instead, the branch would look
   identical today and stop following the clinic tomorrow. This is the whole
   reason only differences are stored.

3. **The settings cache is the transaction's, not the process's.** Caching per
   request needs no invalidation strategy, because the cache cannot outlive the
   request that made it. A process-wide cache would be faster and would
   eventually serve a stale discount limit to a clinic that had just changed it.

4. **The schema is the documentation.** Every setting carries its own type,
   default and help text, `GET /tenant` serves them, and the settings screen is
   generated from that. A new setting therefore appears on the screen, in the
   API and in this specification's meaning of "documented" in one edit. A
   second list in prose would be wrong within a month.

5. **A branch code can never change.** It ends up inside invoice and
   prescription numbers, and those are handed to patients and to LHDN. The
   screen says so at the point of typing rather than refusing afterwards.
   TEN-R-08 is written as "immutable once a document exists"; since nothing is
   numbered yet, the code enforces the stricter rule of "immutable after
   creation", which is easier to reason about and can only be loosened later.

6. **Deactivation asks other modules rather than looking in their tables.**
   `BranchDeactivationRegistry` is an empty list today, so deactivation is
   always allowed, which is correct while no clinical or stock module exists
   and wrong the moment one does. `ENC` and `INV` register a check when they
   are built. TEN-T-09 registers one itself, so the guard is proved rather than
   assumed.

7. **A suspended clinic gets 403, not 401.** 401 means "sign in again", which
   they will try, and fail, and try again. The screen tells them the account is
   suspended and that nothing has been deleted, which is both true and the only
   thing they want to know.

8. **The logo has its own columns and its own route.** Putting it in the
   `letterhead` jsonb would have made every branch read carry an image. It is
   in the database rather than on disk because it must be in the same backup as
   the rows that reference it — a clinic restoring from a dump should not come
   back with unbranded invoices.

9. **An uploaded file is judged by its bytes.** A browser will send
   `image/png` for anything. The magic number decides what it is, and what it
   is decides what it is served as. SVG is allowed because clinics have
   vector logos, and it is served with `sandbox` and no script, because an SVG
   is a document.

10. **The slow-work rule is two things, not one.** The lint script catches the
    shape people write and cannot see through a service call; the runtime
    assertion in the mailer cannot be fooled but only covers the clients that
    call it. Together they are worth having. Either alone would be a comfort
    rather than a control.
