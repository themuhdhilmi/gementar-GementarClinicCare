# Identity & Access (IAM)

| | |
|---|---|
| **Version** | V0 |
| **Status** | In progress — API and web screens built, tested against PostgreSQL |
| **Delivery phase** | Phase 0 |
| **Spec sections** | 29, 41 |
| **Depends on** | — |
| **Depended on by** | Every module |
| **Est. effort** | ~20 h |
| **Built** | `apps/api/src/modules/identity`, `.../tenancy`, `.../audit`, `apps/api/prisma` |
| **Database** | PostgreSQL 16 — see [ADR-0002](../decisions/adr-0002-postgres.md) |

---

## 1. Purpose & business value

Every action in the system is taken by a known person with a known role at a known branch. IAM establishes that fact and makes it cheap for every other module to rely on. It is also the module that lets a clinic owner lock out a departed employee in seconds — which is the security feature they will actually ask for.

Without it nothing can be audited, nothing can be permissioned, and no clinical record can be attributed. It is the first module built and the last one anyone thinks about, which is exactly right.

## 2. Actors & permissions

| Actor | Uses IAM to |
|---|---|
| Any staff member | Log in, log out, reset their password, see and revoke their own sessions |
| ADMIN | Create, disable, re-enable users; assign roles per branch; force password reset; revoke any session; enable MFA |
| System | Authenticate every request, resolve `TenantContext`, enforce permissions |

| Action | ADMIN | DOCTOR | NURSE | RECEPTION | DISPENSER | CASHIER |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Log in / out | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Change own password | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| View / revoke own sessions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage own MFA | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin.users` — create, disable, assign roles | ✓ | – | – | – | – | – |
| Revoke another user's sessions | ✓ | – | – | – | – | – |
| Force password reset for another user | ✓ | – | – | – | – | – |

## 3. Functional requirements

### Authentication
| ID | Requirement | Priority |
|---|---|---|
| IAM-F-01 | Email + password login. Passwords hashed with Argon2id (memory 64 MiB, iterations 3, parallelism 1, or tuned to ~250 ms on the production host). | Must |
| IAM-F-02 | On success, create a server-side session; return an opaque token in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. No JWTs. | Must |
| IAM-F-03 | Session idle timeout 1 h, absolute lifetime 12 h — shortened from 12 h / 7 d for shared workstations (IAM-Q-02). Both environment settings today, tenant-configurable in V1. | Must |
| IAM-F-04 | Logout destroys the session server-side immediately. | Must |
| IAM-F-05 | Login is rate limited: 5 failures per email per 15 min and 20 per IP per 15 min → 429 with `Retry-After`. Failures are audited. | Must |
| IAM-F-06 | After 10 consecutive failures the account is locked for 30 min; ADMIN can unlock. The lockout response is indistinguishable from a wrong password. | Must |
| IAM-F-07 | Password reset via single-use, 30-minute token sent by email. Consuming it revokes all existing sessions for that user. | Must |
| IAM-F-08 | Password policy: minimum 12 characters, checked against a breached-password list (k-anonymity API or bundled list). No composition rules. | Must |
| IAM-F-09 | TOTP MFA (RFC 6238), enrolment with QR + manual key, 10 single-use recovery codes. **Mandatory for ADMIN** in V0; optional for others; per-role enforcement configurable in V1. | Must |
| IAM-F-10 | "Remember this device" for MFA — 30 days, revocable, bound to a device cookie. | Should |
| IAM-F-11 | Re-authentication (password or MFA) required before: changing email, disabling MFA, voiding a payment, exporting patient data. Valid for 5 minutes. | Should |

### Users
| ID | Requirement | Priority |
|---|---|---|
| IAM-F-12 | ADMIN creates a user with name, email, phone, and one or more `(branch, role)` assignments. The user receives an invitation email with a set-password link (72 h). | Must |
| IAM-F-13 | ADMIN disables a user. Disabling revokes all sessions immediately and blocks login. Historical records keep the user's name. | Must |
| IAM-F-14 | ADMIN re-enables a disabled user. | Must |
| IAM-F-15 | ADMIN changes a user's `(branch, role)` assignments. Changes take effect on the user's next request (sessions carry a permission version, see IAM-R-04). | Must |
| IAM-F-16 | A user cannot disable themselves or remove their own ADMIN role if they are the tenant's last ADMIN. | Must |
| IAM-F-17 | Users are never hard-deleted. | Must |
| IAM-F-18 | Every user has an optional linked `employee` record (see DRM / HR). IAM owns the login; HR owns the employment. | Should |

### Authorisation
| ID | Requirement | Priority |
|---|---|---|
| IAM-F-19 | A `TenantContext { tenantId, branchId, userId, permissions[] }` is resolved from the session on every request and injected request-scoped. | Must |
| IAM-F-20 | Permission checks use `(user, branch, permission)`. The six V0 roles map to the permission catalogue in `README.md` — the front desk is RECEPTION, DISPENSER and CASHIER (IAM-Q-01). | Must |
| IAM-F-21 | The active branch is stored on the session; switching branch is a server-side action that validates the user has a role there. | Must |
| IAM-F-22 | A `@RequirePermission('x.y')` decorator guards every mutating endpoint. Endpoints without one fail CI (lint rule). | Must |
| IAM-F-23 | Break-glass: ADMIN reading clinical data is allowed but emits `audit.break_glass` and is surfaced on the audit dashboard. | Must |

### Sessions
| ID | Requirement | Priority |
|---|---|---|
| IAM-F-24 | Users can list their sessions (device, IP, last seen, current) and revoke any. | Must |
| IAM-F-25 | ADMIN can revoke all sessions for any user. | Must |
| IAM-F-26 | Sessions are stored in the primary database (PostgreSQL) in V0. Move to Redis only if session lookup becomes measurable. | Must |

## 4. Key workflows

**First login (invited user)**
1. ADMIN creates user → invitation email
2. User opens link → sets password (policy enforced) → if role requires MFA, enrols before continuing
3. Redirected to their default branch's workspace

**Daily login**
1. Email + password → (MFA if enrolled / required) → session cookie set
2. Land on the workspace for their role at their last-used branch
3. Branch switcher available if they hold roles at more than one

**Employee leaves**
1. ADMIN → Users → Disable
2. All sessions revoked within the same transaction; any in-flight request from that user fails on next permission check
3. User's name remains on every historical record

**Forgot password**
1. Enter email → generic "if that account exists, we sent a link" (no enumeration)
2. Link → new password → all sessions revoked → login

## 5. Data model

Built as written, on PostgreSQL 16. The schema is
`apps/api/prisma/schema.prisma`. Two things are worth knowing without opening
it: every child table references its parent by `(id, tenant_id)`, so a row
cannot point across tenants, and `audit_log` carries no foreign keys at all so
an append-only log can never block work on the rows it describes
([ADR-0002](../decisions/adr-0002-postgres.md)).

```
user
  id                uuid pk
  tenant_id         uuid not null → tenant
  email             citext not null
  password_hash     text not null
  name              text not null
  phone             text
  status            enum(ACTIVE, DISABLED, INVITED, LOCKED) not null
  locked_until      timestamptz
  failed_attempts   int not null default 0
  mfa_secret_enc    bytea            -- encrypted at rest with app KMS key
  mfa_enabled       bool not null default false
  mfa_recovery_enc  bytea            -- encrypted JSON array of hashed codes
  permission_version int not null default 1
  last_login_at     timestamptz
  default_branch_id uuid → branch
  UNIQUE (tenant_id, email)
  INDEX (tenant_id, status)

user_branch_role
  id          uuid pk
  tenant_id   uuid not null
  user_id     uuid not null → user
  branch_id   uuid not null → branch
  role        enum(ADMIN, DOCTOR, NURSE, RECEPTION, DISPENSER, CASHIER) not null
  UNIQUE (user_id, branch_id, role)
  INDEX (branch_id, role)

session
  id            uuid pk
  tenant_id     uuid not null
  user_id       uuid not null → user
  token_hash    bytea not null          -- SHA-256 of the opaque token
  active_branch_id uuid not null → branch
  permission_version int not null
  mfa_verified  bool not null default false
  reauth_at     timestamptz
  ip            inet
  user_agent    text
  created_at    timestamptz not null
  last_seen_at  timestamptz not null
  expires_at    timestamptz not null
  revoked_at    timestamptz
  revoked_reason text
  UNIQUE (token_hash)
  INDEX (user_id, revoked_at)
  INDEX (expires_at)   -- for the cleanup job

password_reset_token
  id          uuid pk
  tenant_id   uuid not null
  user_id     uuid not null
  token_hash  bytea not null unique
  purpose     enum(RESET, INVITE) not null
  expires_at  timestamptz not null
  used_at     timestamptz

trusted_device
  id          uuid pk
  tenant_id   uuid not null
  user_id     uuid not null
  token_hash  bytea not null unique
  label       text
  expires_at  timestamptz not null
  revoked_at  timestamptz
```

## 6. State machines

**User status**
```
INVITED ──(sets password)──► ACTIVE ◄──(admin re-enable)── DISABLED
                              │  ▲                              ▲
              (10 failures)   │  │ (30 min / admin unlock)      │ (admin disable, from any state)
                              ▼  │
                             LOCKED
```

**Session**: `ACTIVE` → `EXPIRED` (idle or absolute) | `REVOKED` (logout, admin, password reset, user disabled).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| IAM-R-01 | Tenant id is derived from the session, never from any request input. | Auth guard; `npm run lint:dto` rejects `tenantId` in any DTO |
| IAM-R-02 | A session is valid only if: not revoked, not expired, user ACTIVE, and (if role requires MFA) `mfa_verified`. | Auth guard |
| IAM-R-03 | Every mutating route carries `@RequirePermission`. | `npm run lint:routes` (TypeScript AST check) + the permission guard refusing undeclared routes at runtime |
| IAM-R-04 | Changing a user's roles increments `user.permission_version`; sessions with an older version reload permissions on next request. | Auth guard |
| IAM-R-05 | A tenant always has ≥ 1 ACTIVE ADMIN. | Service, holding a row lock on the tenant; DB trigger as backstop |
| IAM-R-06 | Password reset consumes the token and revokes all other sessions in one transaction. | Service |
| IAM-R-07 | Login failure responses do not distinguish unknown email / wrong password / locked. Timing is equalised by always running the hash. | Service |
| IAM-R-08 | MFA secrets and recovery codes are encrypted at rest with a key held outside the database. | Service / KMS |
| IAM-R-09 | Session tokens are 256-bit random, only their hash is stored. | Service |

## 8. API surface

All under `/api/v1`. `⟳` = idempotent by design.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | Rate limited. Returns `{ mfaRequired: bool }` |
| POST | `/auth/mfa/verify` | session (pre-MFA) | TOTP or recovery code |
| POST | `/auth/logout` | session | ⟳ |
| POST | `/auth/password/forgot` | public | Always 202 |
| POST | `/auth/password/reset` | public | Token in body |
| POST | `/auth/reauth` | session | Sets `reauth_at` |
| GET | `/auth/me` | session | Context, permissions, branches |
| PUT | `/auth/me/branch` | session | Switch active branch |
| GET | `/auth/me/sessions` | session | |
| DELETE | `/auth/me/sessions/:id` | session | ⟳ |
| POST | `/auth/me/mfa/enrol` | session + reauth | Returns secret + QR |
| POST | `/auth/me/mfa/confirm` | session | First TOTP confirms |
| DELETE | `/auth/me/mfa` | session + reauth | |
| PUT | `/auth/me/password` | session + reauth | |
| GET | `/users` | `admin.users` | Paginated, filter status/branch/role |
| POST | `/users` | `admin.users` | Sends invite |
| GET | `/users/:id` | `admin.users` | |
| PATCH | `/users/:id` | `admin.users` | Name, phone, default branch |
| PUT | `/users/:id/roles` | `admin.users` | Replace assignments |
| POST | `/users/:id/disable` | `admin.users` | ⟳ |
| POST | `/users/:id/enable` | `admin.users` | ⟳ |
| POST | `/users/:id/unlock` | `admin.users` | ⟳ |
| POST | `/users/:id/sessions/revoke-all` | `admin.users` | ⟳ |
| POST | `/users/:id/password/force-reset` | `admin.users` | Sends reset email |

## 9. Domain events

**Emits:** `user.created`, `user.disabled`, `user.enabled`, `user.role_changed`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.locked`, `session.revoked`, `mfa.enrolled`, `mfa.disabled`, `audit.break_glass`
**Consumes:** none

## 10. Audit events

Every event in §9 is audited with actor, target user, IP, user agent. `auth.login_failed` records the attempted email (not the password). Role changes record before/after assignments.

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Login | Single form, email autofocus, works entirely by keyboard, shows lockout/rate-limit messages generically. < 1 s to workspace after submit on clinic hardware. |
| MFA prompt | 6-digit input auto-submits on 6th digit; recovery-code link; "trust this device" checkbox |
| Set / reset password | Live strength feedback; breached-password warning explains *why* |
| My account | Sessions list with "this device" marker; MFA enrol/disable; change password |
| Admin → Users | List with status chips, search, filter by branch/role; create/edit drawer with per-branch role checkboxes, each with a line saying what the role is for; disable requires confirm |
| Branch switcher | In the app header; shows only branches the user has a role at; switching reloads the workspace |

## 12. Validation

- Email: RFC 5322 basic + lowercase + trim; unique per tenant
- Name: 1–120 chars
- Phone: E.164 after normalisation; Malaysian numbers accept `01x-xxxxxxx` input
- Password: ≥ 12 chars, ≤ 128, not in breach list, not equal to email
- Roles: ≥ 1 assignment on create; branch must belong to the tenant
- TOTP: 6 digits, ±1 step window, each code accepted once (replay cache)

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| IAM-N-01 | Auth guard adds ≤ 5 ms p95 per request (session lookup by token hash, indexed). |
| IAM-N-02 | Password hash cost tuned to 200–300 ms on production hardware; re-tune yearly. |
| IAM-N-03 | Expired sessions purged nightly; table never exceeds ~50 rows per active user. |
| IAM-N-04 | All auth endpoints served only over TLS; HSTS 1 year with preload. |
| IAM-N-05 | No credentials, tokens, or secrets in logs at any level. |
| IAM-N-06 | Login availability is the whole system's availability — no external dependency on the login path (breach-list check has a 500 ms timeout and fails open). |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| User holds ADMIN at branch A and RECEPTION at branch B | Permissions resolve per active branch. Switching to B drops admin permissions until switched back. |
| User disabled mid-consultation | Their next request fails with 401. Draft consultations are preserved and reassignable by ADMIN. |
| Last ADMIN tries to disable themselves | Rejected with a clear message (IAM-R-05). |
| MFA device lost, no recovery codes | ADMIN can reset MFA for the user after verifying identity out-of-band; the reset is audited and the user must re-enrol at next login. |
| Email provider down during invite | Invite is queued (V1 NTF) or retried; in V0, ADMIN can copy the invite link from the UI. |
| Clock skew on TOTP | ±1 step (30 s) tolerated; server time is NTP-synced. |
| Same email used at two tenants | Allowed — uniqueness is per tenant. Login form does not ask for tenant; the email resolves to exactly one user per tenant, and a user belongs to one tenant in V0. Multi-tenant users are V3. |
| Session cookie stolen | Mitigated by Secure/httpOnly/SameSite, short idle timeout, and the sessions list. V3 adds IP/UA binding option. |

## 15. Compliance

- **PDPA**: user records are personal data; disabled users are retained (not deleted) because they are referenced by clinical and financial records. Retention follows the clinical record period.
- Login and access logs support breach investigation (`../05-safety-and-compliance.md` §3).
- MFA for ADMIN is the minimum defensible control for an account that can read all clinical data.

## 16. Reporting outputs

- Active users by role and branch (admin dashboard)
- Failed logins last 24 h / 7 d (audit dashboard)
- Break-glass access count (audit dashboard)

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| IAM-T-01 | Given a valid user, when they log in with the correct password, then a session cookie is set and `/auth/me` returns their permissions for their default branch. |
| IAM-T-02 | Given 5 failed logins for an email within 15 min, when a 6th attempt is made, then the response is 429 and the failure is audited. |
| IAM-T-03 | Given 10 consecutive failures, when the correct password is then supplied, then login still fails until `locked_until` passes. |
| IAM-T-04 | Given an ADMIN without MFA enrolled, when they log in, then they are forced through MFA enrolment before any other route responds. |
| IAM-T-05 | Given a user with two active sessions, when ADMIN disables them, then both sessions return 401 on their next request. |
| IAM-T-06 | Given a password reset token, when it is used, then all pre-existing sessions are revoked and the token cannot be used again. |
| IAM-T-07 | Given a user with RECEPTION at branch B only, when they call an endpoint requiring `clinical.write` at branch B, then 403. Also covered for the split itself: a CASHIER cannot dispense and a DISPENSER cannot take payment. |
| IAM-T-08 | Given a mutating route with no `@RequirePermission`, when CI runs, then the build fails. |
| IAM-T-09 | Given a tenant's only ACTIVE ADMIN, when they attempt to remove their own ADMIN role, then the request is rejected. |
| IAM-T-10 | Given a TOTP code, when it is submitted twice within its window, then the second submission is rejected. |
| IAM-T-11 | Given ADMIN reads a consultation, then an `audit.break_glass` event is recorded with the patient id. |

## 18. Migration & rollout

- Seed script creates the tenant, the pilot branch, and the first ADMIN with a one-time set-password link
- Pilot staff created by ADMIN during Phase 1 training; each staff member sets their own password on first login (no shared accounts — make this explicit to the clinic)
- Existing system credentials are not migrated

## 19. Out of scope

- Custom roles, granular permission editing → V1 `RBC`
- SSO / SAML / OIDC → V3 `SEC`
- Per-tenant session policy, IP allow-lists, device binding → V3 `SEC`
- Users belonging to multiple tenants → V3
- Patient logins → V2 `PPT` (a separate identity surface; do not share tables)

## 20. Open questions

| ID | Question | Who | Status |
|---|---|---|---|
| IAM-Q-01 | Does one person at the pilot cover reception, dispensing and cashier? If they are separate people, FRONTDESK should split into RECEPTION / DISPENSER / CASHIER now rather than in V1. | Pilot clinic | **Answered and built** — see below |
| IAM-Q-02 | Do staff share workstations? Affects idle timeout and whether a fast "switch user" is needed. | Pilot clinic | **Decided** — assume shared, see below |
| IAM-Q-03 | Which transactional email provider for invites/resets? | You | **Provider built, choice open** — needs a sending domain |
| IAM-Q-04 | If the same email address is ever used at two tenants, how should the login form resolve it — a clinic picker, a per-clinic subdomain, or a hard rule that addresses are globally unique? Only matters when clinic two arrives. | You | Open — current behaviour is to fail, see note 2 in §22 |
| IAM-Q-05 | Should the application connect as a non-owner role (`prisma/sql/app-role.sql`) rather than as the table owner? | You / hosting | **Decided and surfaced** — yes, before go-live; the boot log and `/health` now say when it is outstanding |

### IAM-Q-01 — split FRONTDESK now

**Answer: keep it as flexible as possible, which means splitting the role now
rather than later.**

`FRONTDESK` becomes three roles — `RECEPTION`, `DISPENSER`, `CASHIER` — and
flexibility comes from the assignment, not from one wide role. A user already
holds any number of `(branch, role)` pairs, so:

- a small clinic gives one person all three, and they see exactly what
  `FRONTDESK` shows today;
- a larger clinic gives each person one, and a cashier cannot dispense;
- a doctor who also dispenses simply gets `DISPENSER` as well.

Doing it now is the cheap moment. The permission catalogue is a published
contract that fourteen unbuilt modules will check against, and every one of
them built against `FRONTDESK` makes the split more expensive. Custom roles and
an editable permission map are still V1 (`RBC`); this is about having the right
fixed roles underneath that.

**Proposed permission split, for correction by the clinic.** Everything a
`FRONTDESK` user can do today stays available; it is only divided up.

| Permission | RECEPTION | DISPENSER | CASHIER |
|---|:-:|:-:|:-:|
| `patient.read`, `patient.write` | ✓ | ✓ | ✓ |
| `patient.unmask_id` | ✓ | – | ✓ |
| `encounter.create`, `encounter.transition`, `encounter.priority` | ✓ | ✓ | ✓ |
| `encounter.cancel` | ✓ | – | – |
| `dispense.perform`, `dispense.substitute` | – | ✓ | – |
| `stock.read` | ✓ | ✓ | ✓ |
| `stock.receive`, `stock.count` | – | ✓ | – |
| `invoice.read` | ✓ | – | ✓ |
| `invoice.issue`, `invoice.discount` | – | – | ✓ |
| `payment.take`, `eod.close` | – | – | ✓ |
| `document.issue` | ✓ | ✓ | ✓ |
| `document.reprint`, `report.operational` | ✓ | ✓ | ✓ |

**Built.** Migration `20260921020000_split_front_desk_role` replaces the enum
and expands every existing `FRONTDESK` assignment into all three, so nobody
lost access; the pilot's front-desk account now holds reception, dispenser and
cashier. A unit test asserts that the union of the three is exactly the old
single role, and an end-to-end test proves a cashier cannot dispense and a
dispenser cannot take payment. The staff drawer lists all six with a line
describing each.

Module specifications written before this still say `FRONTDESK`; the catalogue
in `../modules/README.md` is the contract, and each of those modules maps to
the right role when it is picked up.

### IAM-Q-02 — assume workstations are shared

**Decision: assume they are shared, and shorten the session.**

A single reception computer that several people use during a shift is the norm
in a small Malaysian general practice, and it is also the less damaging
assumption to get wrong: a clinic with personal devices loses a little
convenience, while a clinic with a shared desk keeps an unattended session
open all night.

| | Was | Now |
|---|---|---|
| Idle timeout | 12 hours | **1 hour** |
| Absolute lifetime | 7 days | **12 hours** |

An hour of inactivity is long enough that nobody is signed out mid-task — the
consultation screen talks to the server constantly — and short enough that a
counter left at lunchtime is closed by the time it matters. A twelve-hour
absolute lifetime means a session cannot outlive the shift that started it.

Both remain environment settings today and become per-tenant settings in V1,
so a clinic with personal laptops can raise them without a deploy. This
supersedes the numbers in IAM-F-03; recorded as note 12 in §22.

Two follow-ons, both V1 and neither blocking:

- **Fast switch user.** Signing out and back in is four actions on a shared
  desk. A "switch user" that keeps the branch and pre-fills nothing but the
  email field is worth building once the queue screens exist.
- **"Trust this device" on a shared machine.** The MFA screen already warns
  against it. In V1 a tenant should be able to switch the option off entirely
  for a given branch.

### IAM-Q-03 — what the email provider decision actually is

**Still yours to make. Here is what it covers.**

**What the system sends.** Two things, both security-critical and both
time-limited: the invitation link that lets a new member of staff set their
first password (72 hours, single use), and the password reset link (30 minutes,
single use). Nothing else. No patient mail, no reminders, no marketing.

**Volume.** At the pilot, tens of messages a month. Every free tier on the
market covers it several times over, so cost is not the deciding factor.

**What actually matters.** Deliverability. A reset link that lands in spam is a
member of staff who cannot work, at the moment they have already lost access.
That means sending from your own domain with SPF, DKIM and DMARC set up, which
in turn means whoever controls the `gementar.com` DNS has to add three records.
A personal Gmail account as an SMTP relay will work on the first day and start
being filtered later; it is the option to avoid.

**What happens today.** `MAIL_TRANSPORT=console` writes the link to the
application log and returns it in the API response, so an administrator can
copy it and hand it over in person. Production configuration refuses this
transport outright, so this cannot ship by accident.

| Option | Setup | Notes |
|---|---|---|
| **Resend** | An API key and three DNS records | Simplest for a small transactional volume; good defaults |
| **Postmark** | API key and DNS | Strongest reputation for transactional mail; paid from the start |
| **Amazon SES** | IAM user, DNS, and a sandbox-removal request | Cheapest at scale, most setup, worth it only if you are already on AWS |
| **Brevo / Mailgun** | API key and DNS | Fine; marketing features you will not use |
| **Google Workspace SMTP** | Existing mailbox | Works immediately, sending limits and poorer reputation for automated mail |

Check current pricing before committing; free tiers move.

**Recommendation, and what is now built.** Resend, on a subdomain such as
`mail.gementar.com`, so a later move to SES never touches the main domain's
reputation. The transport is implemented: set `MAIL_TRANSPORT=resend` and
`RESEND_API_KEY`, and configuration refuses the combination if the key is
missing. It is a plain HTTP call with no SDK, so swapping provider is one
adapter method. Sending never throws — it runs after the transaction has
committed, so a provider outage cannot undo the change that triggered it, and
a failure is logged with the address masked.

**What I need from you:** the sending domain, and confirmation that whoever
holds its DNS can add SPF, DKIM and DMARC records.

**Not this decision.** Patient-facing messaging is WhatsApp and SMS, it belongs
to V1's `NTF` module, and it is a separate choice with different providers.

### IAM-Q-05 — use the unprivileged role, from go-live

**Decision: yes, but it is not urgent, and it is not a pilot blocker.**

Row-level security is already `FORCE`d, so policies apply to the owner as well;
isolation does not depend on this. What a separate role adds is that the
account facing the internet loses the ability to drop a policy, disable
row-level security, or change the schema at all — protection against an
application compromise rather than against a missing `where` clause.

So: keep connecting as the owner during the pilot build, and make
`prisma/sql/app-role.sql` part of the go-live checklist, whichever comes first
of production deployment or a second tenant. It needs a database account with
`CREATEROLE`, which the current one does not have, so it is a request to
whoever administers the server rather than something the application can do to
itself.

**Made visible in the meantime.** The boot log says so every start, and
`/api/v1/health` reports the role as `table owner — policies apply, but this
account could drop them`. It is a warning, not a refusal, because isolation
genuinely does hold without it.

## 21. Definition of done

- [x] All Must requirements implemented (API); Should items IAM-F-10, F-11, F-18 — F-10 and F-11 done, F-18 deferred with HR
- [x] IAM-T-01 … T-11 green against a real PostgreSQL database with row-level security in force (`npm run test:e2e`, 42 end-to-end tests; 64 unit tests). Each one exists as a test named after its requirement id.
- [x] `@RequirePermission` rule enforced — `npm run lint:routes`, plus a runtime refusal for undeclared mutating routes
- [x] Argon2id cost measured and recorded (below); **re-measure on the production VPS before go-live**
- [x] Break-glass audit recorded and exposed — `GET /api/v1/audit/summary` and `/audit/events`
- [x] Threat-model pass written up — [`documents/security/iam-threat-model.md`](../security/iam-threat-model.md)
- [x] Web screens (§11) built — sign-in, MFA, forced enrolment, set and reset password, my account, staff administration, audit dashboard
- [x] Tenant isolation installed by migrations, and asserted at boot (`DB_GUARD_MODE=require` in staging and production)
- [x] Open questions answered and recorded — Q-01, Q-02 and Q-05 answered in §20 and built; Q-03's transport is built and needs a sending domain from you; Q-04 waits for a second tenant
- [ ] **IAM-N-01 measured.** The auth guard's p95 has never been timed, and neither has the "under 1 s to workspace" target in §11.
- [ ] **§16 reporting: active users by role and branch.** The other two outputs, failed logins and break-glass count, are on the audit dashboard.
- [ ] **Argon2id re-measured on the production host.** The recorded numbers are from a development machine.
- [ ] **MFA enrolment sharp edges.** Reopening the enrolment screen rotates the secret, which invalidates a QR code already scanned; a rejected code during enrolment is not audited, unlike one at sign-in.

### Traceability, checked mechanically on 2026-09-21

Not a claim that the module is finished, only that nothing in the specification
is silently absent:

| | Count | Verified by |
|---|---|---|
| Functional requirements cited in code | 26 of 26 | grep for each `IAM-F-nn` |
| Invariants cited | 9 of 9 | grep for each `IAM-R-nn` |
| Non-functional requirements cited | 6 of 6 | grep for each `IAM-N-nn` |
| Acceptance tests with a matching named test | 11 of 11 | test-name match on `IAM-T-nn` |
| Routes in §8 implemented | 24 of 24 | controller decorators compared to the table |
| Domain events in §9 published | 12 of 12 | event names found at `publish()` sites |
| Those events audited | 12 of 12 | each maps to an `AuditAction` that is recorded |
| Validation rules in §12 enforced | 13 of 13 | each rule located in code |
| Permission catalogue matches the code | exact | 6 roles compared cell by cell |

### Argon2id cost measurement (IAM-N-02)

Measured with `npm run measure:argon2` on the development host (AMD Ryzen 5
5600X, 32 GB). Median of three runs:

| memory | iterations | parallelism | median |
|---|---|---|---|
| 64 MiB | 3 | 1 | 44 ms |
| 64 MiB | 10 | 1 | 138 ms |
| 128 MiB | 6 | 1 | 182 ms |
| 128 MiB | 8 | 1 | **242 ms** |

Shipped defaults stay at the spec's 64 MiB / 3 / 1, which is the right floor for
an unknown host. The production VPS will be slower than this machine, so run the
script there and set `ARGON2_MEMORY_KIB` / `ARGON2_ITERATIONS` from its output.
Re-measure yearly.

---

## 22. Implementation notes and deviations

Decisions taken while building, that the specification did not settle. Each one
is a place where the spec and reality disagreed slightly.

| # | Decision | Why |
|---|---|---|
| 1 | **PostgreSQL 16, with row-level security enabled and forced on every tenant-owned table**, alongside the Prisma extension and composite `(id, tenant_id)` foreign keys. The authentication path has a named, narrow bypass; `branch`, `user_branch_role` and `audit_log` have none. | Two independent layers, as `03-multi-tenancy.md` requires. The route here went via MySQL for a day; [ADR-0002](../decisions/adr-0002-postgres.md) records both the move and what PostgreSQL semantics changed in the code. |
| 2 | **An email that exists at two tenants fails login** with the standard generic message, and the attempt is recorded. An optional `tenantSlug` in the request resolves it. | §14 says login does not ask for a tenant, and V0 users belong to one tenant. Guessing which clinic someone meant would be worse than failing. See IAM-Q-04. |
| 3 | **Signing in with a password counts as a re-authentication** for the following 5 minutes. | Otherwise a new administrator, forced into MFA enrolment at first login, is asked for the password they just typed. |
| 4 | **`POST /users/:id/mfa/reset` added** to the API surface. | §14 requires an administrator to be able to reset a lost second factor; §8 had no route for it. Revokes all sessions and devices, and is audited. |
| 5 | **Forcing a password reset revokes the user's sessions** immediately. | A forced reset is what an administrator does when something is wrong. Leaving the existing sessions alive would defeat it. |
| 6 | **The invite and reset links are returned in the API response** while `MAIL_TRANSPORT=console`. | §14 allows an administrator to copy the invite link in V0, and the email provider is still IAM-Q-03. Production configuration refuses the console transport. |
| 7 | **The rate limit reaches 5 before the lockout reaches 10.** With the specified numbers, 5 failures per email per 15 minutes means 10 *consecutive* failures can only accumulate across windows. | Both controls are in the spec and both are implemented as written. The interaction is worth knowing: in practice the rate limiter is what a live attacker meets, and the lockout catches the patient one. Worth revisiting the pair of numbers together, not separately. |
| 8 | **Disabling a user is refused for your own account outright**, not only when you are the last administrator. | IAM-F-16 reads either way. Nobody has a good reason to disable themselves, and the failure mode of allowing it is an administrator locking the clinic out at 6pm. |
| 9 | **Services take their transaction from the request scope** rather than receiving `tx` as a parameter, except `AuditService.record`, which still requires it explicitly. | Keeps AUD-R-02 honest where it matters (an audit entry shares its change's transaction) without threading a parameter through forty signatures. |
| 10 | **A minimal slice of the audit module was built** (append-only table, `record`, redaction, two read endpoints) rather than stubbed. | IAM's definition of done requires audited actions and a visible break-glass count. The rest of `AUD` is unaffected. |
| 13 | **Six roles, not four**: `FRONTDESK` is now `RECEPTION`, `DISPENSER` and `CASHIER`. | Answering IAM-Q-01 in favour of flexibility. One person can hold all three, so a small clinic is unaffected, while a clinic that separates the counter can now express that. Done early because the permission catalogue is a contract fourteen unbuilt modules will check against. |
| 12 | **Session idle timeout is 1 hour and the absolute lifetime 12 hours**, not the 12 h / 7 d in IAM-F-03. | Answering IAM-Q-02 in favour of shared workstations. A reception desk used by several people during a shift should not hold an open session overnight. Both are environment settings, so a clinic with personal devices can raise them without a deploy. |
| 11 | **`audit_log` has no foreign keys**, and the test harness needs an owner connection to clean up after itself. | An append-only log must not be able to block operations on the rows it describes, and its entries have to outlive them. Deleting audit rows is deliberately an administrative act. |

### How note 1 stands today

Verified against the live database on 2026-09-21, not asserted:

| Claim | State |
|---|---|
| PostgreSQL 16 | 16.15 |
| RLS enabled **and forced** | 9 of 9 tenant-owned tables |
| Tables without RLS | `login_attempt` and `_prisma_migrations`, both on the written exemption list |
| Narrow authentication bypass | `tenant`, `user`, `session`, `password_reset_token`, `trusted_device`, `mfa_replay` |
| No bypass at all | `branch`, `user_branch_role`, `audit_log` |
| Composite `(id, tenant_id)` foreign keys | 8 of the 15 foreign keys; the rest are single-column references to `tenant` |
| Application role | not a superuser, no `BYPASSRLS` |

Covered by 17 tests in `test/tenant-isolation.e2e-spec.ts`, including the two
that only PostgreSQL can satisfy: raw SQL with no tenant filter sees one
tenant, and with `app.tenant_id` unset every tenant table returns nothing and
refuses inserts. The process also checks all of the above at boot and, with
`DB_GUARD_MODE=require`, refuses to serve if any of it is untrue.

**Still open, deliberately:** the application connects as the owner of its
tables. Row-level security is forced, so policies apply to the owner too, but
an unprivileged role (`prisma/sql/app-role.sql`) would additionally remove the
ability to drop a policy from the account that faces the internet. The current
database account cannot create roles, so this needs someone with more
privileges. Tracked as IAM-Q-05.
