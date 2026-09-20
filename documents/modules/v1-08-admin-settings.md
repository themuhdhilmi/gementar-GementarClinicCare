# Admin & Settings (ADM)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 27 (self-serve), 28 |
| **Depends on** | TEN, IAM, RBC, all modules' settings |
| **Depended on by** | Every module (reads settings) |
| **Est. effort** | ~40 h |

---

## 1. Purpose & business value

Let the clinic configure itself instead of asking you — and let a second clinic onboard without your hands on the keyboard. Every setting exposed here is one less support message on a weeknight. Also the SaaS surface: tenant plan, module toggles, usage, billing to you.

## 2. Actors & permissions

| Action | ADMIN | Platform operator | Others |
|---|:-:|:-:|:-:|
| `admin.settings` — all tenant/branch settings | ✓ | ✓ | – |
| Module enable/disable within plan | ✓ | ✓ | – |
| Plan change, tenant suspension, cross-tenant views | – | ✓ | – |
| Self-serve signup / onboarding wizard | new tenant | ✓ | – |

## 3. Functional requirements

### Tenant & branch configuration
| ID | Requirement | Priority |
|---|---|---|
| ADM-F-01 | Settings UI generated from the typed settings schema (TEN-F-04): grouped (Clinic, Branches, Queue, Clinical, Billing, Payment, Inventory, Documents, Notifications, Security), with inline help, defaults shown, per-branch override toggle, change history (audit) per key. | Must |
| ADM-F-02 | Services & pricing: fee schedule (BIL), billable items, procedure catalogue & prices (PRC), membership plans (MEM), appointment types (APT) — surfaced from their modules in one "Pricing" area. | Must |
| ADM-F-03 | Medicine catalogue management (INV) incl. bulk price update (%, category) with preview and effective date. | Must |
| ADM-F-04 | Queue configuration (ENC): triage policy, payment-before-dispense, number formats, display privacy, thresholds, rooms. | Must |
| ADM-F-05 | Document settings (DOC): letterhead, templates' editable blocks, numbering series prefixes, MC wording, signatures. | Must |
| ADM-F-06 | Notification templates and quiet hours (NTF). | Must |
| ADM-F-07 | Tax settings (BIL): SST registration, tax codes, inclusive/exclusive. | Must |
| ADM-F-08 | Custom fields: per entity (patient, encounter) — key, label, type (text/number/date/select/bool), required, shown-on; stored in `custom_fields jsonb` on the entity with schema validation; searchable for select/bool. | Should |
| ADM-F-09 | Staff & permissions: users (IAM), roles (RBC), branch assignments — one "People" area. | Must |
| ADM-F-10 | Data tools: patient import/merge (PAT), catalogue import (INV), exports (PDPA), backup status visibility (read-only), retention settings. | Must |

### SaaS / platform
| ID | Requirement | Priority |
|---|---|---|
| ADM-F-11 | **Self-serve onboarding**: signup (business name, admin email, phone) → email verify → tenant created on a trial plan → wizard: branch details, letterhead, hours, first users, catalogue import or starter catalogue, fee schedule, payment methods, printers check, go-live checklist. | Must |
| ADM-F-12 | Plans and module flags: Starter/Professional/Enterprise (section 49) as plan definitions with included modules, limits (branches, users, storage, messages), add-ons; tenant's `modules` flags derived from plan + add-ons; UI hides disabled modules; API returns 403 `MODULE_DISABLED`. | Must |
| ADM-F-13 | Usage metering: active users, branches, storage, messages sent, e-Invoices, API calls → usage records per tenant per month for platform billing. | Must |
| ADM-F-14 | Platform console (you): tenants list, status, plan, usage, health (last activity, error rate), impersonate-as-support with tenant admin consent and full audit, suspend/resume, feature flags, announcements banner. | Must |
| ADM-F-15 | Subscription billing to tenants: invoice generation for platform fees (monthly), payment tracking (manual/transfer in V1; gateway later), dunning, suspension on non-payment after grace. | Should |
| ADM-F-16 | Tenant data export (full, for offboarding) and deletion request workflow with retention holds for clinical records. | Should |

## 4. Key workflows

New clinic signs up → wizard 45 min → live with starter catalogue · Owner raises front-desk discount cap from 10% to 15% → settings → history shows who/when · You: tenant X's error rate spiked → console → impersonate (with consent) → reproduce → fix.

## 5. Data model

```
setting_change          id, tenant_id, branch_id, key, old jsonb, new jsonb, changed_by, changed_at, reason   -- projection of audit for UI
custom_field_def        id, tenant_id, entity, key, label, type, options jsonb, required, show_on jsonb, sort, active
plan                    id, code, name, modules jsonb, limits jsonb, price_sen, period, active
tenant_subscription     id, tenant_id, plan_id, addons jsonb, status, trial_ends, current_period_start/end, cancel_at
usage_record            id, tenant_id, period, metric, quantity, computed_at
platform_invoice        id, tenant_id, period, lines jsonb, total, status, due_date, paid_at, reference
support_session         id, tenant_id, operator_id, consented_by, started_at, ended_at, reason
announcement            id, audience jsonb, message, starts_at, ends_at, severity
onboarding_progress     tenant_id pk, steps jsonb, completed_at
```

## 6. State machines

Subscription: `TRIAL → ACTIVE → PAST_DUE → SUSPENDED → ACTIVE | CANCELLED`. Onboarding: step list with completion.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| ADM-R-01 | Settings writes validate against the schema and record history; unknown keys rejected. | TEN SettingsService |
| ADM-R-02 | Module flags gate both UI and API; a disabled module's data is retained. | Guard + UI |
| ADM-R-03 | Impersonation requires tenant admin consent (in-app approval) and is fully audited; clinical reads during impersonation are break-glass. | Service |
| ADM-R-04 | Plan limits are enforced softly (warnings) then hard (block creation) per limit definition. | Service |
| ADM-R-05 | Bulk price updates are previewed and applied with an effective date; each product change is a price-history row. | INV |

## 8. API surface

`/admin/settings` (schema + values + history) · `/admin/custom-fields` · `/admin/plans` (platform) · `/admin/subscription` · `/admin/usage` · `/platform/tenants` (+ suspend/resume/plan) · `/platform/support-sessions` · `/platform/announcements` · `/onboarding` (signup, verify, wizard steps) · module-owned endpoints for pricing/catalogue/templates are linked, not duplicated.

## 9. Domain events

**Emits:** `tenant.signed_up`, `onboarding.completed`, `settings.changed`, `module.toggled`, `subscription.changed`, `usage.computed`, `support_session.started/ended`
**Consumes:** module events for usage metering

## 10. Audit events

Every settings change (key, before/after, reason), module toggles, plan changes, impersonation start/end with reason, custom field changes, bulk price updates.

## 11. Screens & UX requirements

Settings hub with search across keys · Per-group forms with per-branch override switch and "changed by" hints · Pricing hub · People hub · Onboarding wizard with progress and "skip for now" · Platform console (tenants table, health sparklines, actions) · Announcement banner component.

## 12. Validation

Per schema; custom field keys `^[a-z_][a-z0-9_]{1,40}$`; plan limits numeric ≥ 0; signup email verified before tenant activation.

## 13. Non-functional requirements

Settings read cached per request; write visible next request · onboarding wizard completes in ≤ 60 min for a typical clinic · platform console loads 500 tenants ≤ 1 s · usage computed nightly ≤ 10 min for 1 000 tenants.

## 14. Edge cases & failure modes

Disabling a module with in-flight data (e.g. MEM with active members) → warning, data retained, benefits stop · plan downgrade over limits → grace period then block new creation · trial expiry mid-day → banner, read-only after grace · impersonation consent not granted → no access · settings schema migration → keys mapped with logged warnings.

## 15. Compliance

Tenant offboarding export/deletion with clinical retention holds; impersonation audit; platform billing records; announcements for incident communication.

## 16. Reporting outputs

Platform: tenants by plan, MRR, usage, churn, health · Tenant: settings change history, usage vs limits.

## 17. Acceptance tests (representative)

ADM-T-01 settings change records history and is visible next request · T-02 disabled module → 403 `MODULE_DISABLED` and hidden nav · T-03 signup → wizard → tenant ACTIVE with first ADMIN and branch · T-04 impersonation without consent → 403; with consent → audited session · T-05 bulk price +5% preview equals applied changes · T-06 plan limit (2 branches) blocks third branch creation.

## 18. Migration & rollout

Pilot tenant migrated onto a plan; settings audit backfilled from AUD; onboarding wizard tested by creating a fresh demo tenant end-to-end.

## 19. Out of scope

Rich template editor → V2 · gateway billing for platform fees → with INT · white-labelling → V3 · marketplace/add-on store → not planned.

## 20. Open questions

ADM-Q-01 plan tiers and pricing (section 49) · Q-02 trial length · Q-03 which settings the pilot changed most in V0 (prioritise) · Q-04 support hours/SLA to publish.

## 21. Definition of done

- [ ] Must requirements implemented; ADM-T-01 … T-06 green
- [ ] Fresh tenant onboarded end-to-end without operator intervention
- [ ] Open questions answered
