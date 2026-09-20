# Public API (API)

| | |
|---|---|
| **Version** | V3 |
| **Status** | Not started |
| **Spec sections** | 40 |
| **Depends on** | IAM, TEN, RBC, AUD, INT, SEC |
| **Depended on by** | External integrators, INT (FHIR auth) |
| **Est. effort** | — |

> Tenant isolation at an API-key boundary is a different threat model from session auth. Re-read `../03-multi-tenancy.md` before building.

---

## 1. Purpose & business value

Let others build on the platform: tenant-scoped API keys and OAuth clients, webhooks for events, rate limiting, versioning, sandbox tenants, and developer documentation — so clinic groups, insurers, labs and app builders can integrate without bespoke work.

## 2. Actors & permissions

ADMIN creates API clients and webhooks for their tenant (`api.manage`); platform manages global limits and the developer portal; external clients act with scoped permissions ⊆ the creating admin's permissions.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| API-F-01 | Auth: API keys (hashed, prefix-identifiable, scoped, expiring, IP allow-list) and OAuth 2.0 client credentials / authorization code (for patient-directed access via PPT identity, SMART-on-FHIR compatible); scopes map to the permission catalogue plus `patient/*.read` style FHIR scopes. | Must |
| API-F-02 | Versioned external API `/api/ext/v1/*` distinct from the internal `/api/v1` (which may change); OpenAPI spec generated and published; deprecation policy (12 months). | Must |
| API-F-03 | Webhooks: tenant subscriptions to catalogue events with filters, signed payloads (HMAC + timestamp), retries with backoff, delivery logs, replay, secret rotation; payloads reference ids (no PHI beyond what scope allows). | Must |
| API-F-04 | Rate limiting per client (token bucket), quotas per plan (ADM), 429 with headers; abuse detection. | Must |
| API-F-05 | Audit of every external call (client, scope, endpoint, entity ids) as `actor_type = API_CLIENT`; clinical reads audited like staff. | Must |
| API-F-06 | Sandbox tenants with synthetic data; developer portal (docs, keys, logs). | Should |
| API-F-07 | Idempotency-Key support on all external POSTs. | Must |

## 4. Key workflows

Insurer integrates eligibility checks → OAuth client with `panel.read` → calls → audited · Clinic group's BI tool subscribes to `invoice.issued` webhooks → signed deliveries → replay after outage.

## 5. Data model

`api_client` (tenant, name, kind, key_hash/prefix, oauth fields, scopes, ip_allowlist, status, expires), `api_token` (OAuth), `webhook_subscription` (tenant, url, events, filters, secret_enc, status), `webhook_delivery` (subscription, event_id, attempts, status, response_code, next_retry), `api_request_log` (client, endpoint, status, latency, entity refs), `rate_limit_state` (Redis).

## 6. State machines

Client `ACTIVE → SUSPENDED | REVOKED | EXPIRED`; delivery `PENDING → DELIVERED | FAILED → RETRY | DEAD`.

## 7. Business rules & invariants

API-R-01 a client's effective scopes ⊆ scopes grantable by the creating ADMIN and ⊆ plan allowances · R-02 tenant derived from the client, never from the request · R-03 webhook payloads exclude PHI unless scope includes it and the subscription is marked PHI-capable (extra approval) · R-04 all external POSTs idempotent · R-05 keys shown once; only hashes stored.

## 8. API surface

Admin: `/api-clients` CRUD + `/rotate|suspend`, `/webhooks` CRUD + `/deliveries` + `/replay`, `/api/usage`. External: `/api/ext/v1/patients`, `/encounters`, `/appointments`, `/invoices`, `/payments`, `/stock`, `/memberships`, `/claims`, `/fhir/r4/*` (via INT) — read-first, selected writes (appointments, patient demographics, payments notifications) with scopes.

## 9. Domain events

**Emits:** `api_client.created/revoked`, `webhook.delivered/failed_final` · **Consumes:** all catalogue events for webhook fan-out.

## 10. Audit events

Client lifecycle, scope changes, webhook config, every external call (log), replays.

## 11. Screens & UX requirements

API clients page (create with scope picker, key reveal once, logs) · Webhooks page (events, filters, deliveries with retry/replay, secret rotation) · Usage dashboard · Developer portal (docs from OpenAPI, sandbox signup).

## 12. Validation

URLs https only; scopes valid; IP CIDRs; expiry ≤ plan max; event names from catalogue.

## 13. Non-functional requirements

Auth overhead ≤ 5 ms · webhook first attempt ≤ 10 s after event · 99.9% API availability target · OpenAPI validated in CI.

## 14. Edge cases & failure modes

Webhook endpoint down for days (retries to a cap; DEAD; admin replay) · key leaked (revoke; audit review) · scope reduction after issue (immediate) · tenant suspended (clients 403) · clock skew on HMAC timestamps (±5 min window).

## 15. Compliance

External access to PHI requires PDPA-compliant agreements; scopes minimise; audit complete; webhook PHI approval; developer terms.

## 16. Reporting outputs

API usage by client/endpoint; error rates; webhook delivery health; quota consumption (ADM billing).

## 17. Acceptance tests (representative)

API-T-01 key with `patient.read` cannot write · T-02 tenant A key cannot read tenant B data by id (404) · T-03 webhook signature verifiable; tampered payload rejected by sample consumer · T-04 rate limit returns 429 with Retry-After · T-05 external POST replayed with same Idempotency-Key → single effect.

## 18. Migration & rollout

Read-only endpoints first with one partner; webhooks; then scoped writes; developer portal.

## 19. Out of scope

Marketplace/app store; GraphQL; write-side FHIR.

## 20. Open questions

API-Q-01 first integration partners · Q-02 pricing of API access (ADM plans) · Q-03 SMART-on-FHIR demand.

## 21. Definition of done

- [ ] Must requirements; API-T-01 … T-05 green; OpenAPI published; one partner live
