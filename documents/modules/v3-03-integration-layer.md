# Integration Layer (INT)

| | |
|---|---|
| **Version** | V3 (foundations used earlier by EIV, NTF, LAB) |
| **Status** | Not started |
| **Spec sections** | 39 |
| **Depends on** | NTF (queue), SEC, AUD, and each integrating module |
| **Depended on by** | EIV, NTF, LAB, FIN, HR, PNL, TEL, API |
| **Est. effort** | — |

---

## 1. Purpose & business value

One place for everything that talks to something outside: MyInvois, payment gateways, WhatsApp/SMS/email, labs, accounting, payroll, insurers/TPAs, FHIR, delivery partners. Adapters behind stable internal interfaces, with credentials, retries, idempotency, webhooks and observability handled once — so each new integration is an adapter, not a project.

## 2. Actors & permissions

ADMIN configures tenant-level connectors (`integration.manage`); platform manages adapter catalogue and secrets infrastructure; modules call connectors via typed clients.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| INT-F-01 | Connector framework: adapter interface per category (payments, messaging, e-invoice, lab, accounting, payroll, payer, delivery, video), per-tenant configuration and credentials (encrypted, rotated), health checks, sandbox/production modes, feature flags. | Must |
| INT-F-02 | Outbound reliability: queued calls (BullMQ), retries with backoff and jitter, idempotency keys, circuit breakers, dead-letter with admin UI, rate-limit awareness per provider. | Must |
| INT-F-03 | Inbound webhooks: signature verification per provider, replay protection, idempotent processing, routing to owning module events, raw payload retention (PHI-scrubbed where possible). | Must |
| INT-F-04 | **Payment gateway** adapters (e.g. iPay88/Razer/Billplz/Stripe MY): hosted checkout, DuitNow dynamic QR, card terminal integration where available; settlement reports import for FIN bank matching. | Must |
| INT-F-05 | **Accounting** exports/APIs (SQL Account, AutoCount, Xero, QuickBooks): journal push or file export per FIN mapping. | Should |
| INT-F-06 | **Payroll** export/API (per HR provider). | Should |
| INT-F-07 | **Payer/TPA** APIs for eligibility and claims where available (PNL). | Should |
| INT-F-08 | **FHIR R4** facade (read-first): Patient, Encounter, Condition, MedicationRequest, Observation (vitals/labs), DocumentReference — for external systems and MOH interoperability initiatives; SMART-on-FHIR auth via API module. | Should |
| INT-F-09 | Observability: per-connector dashboards (success/failure, latency, queue depth), alerts, per-tenant usage metering (ADM). | Must |

## 4. Key workflows

Add gateway for tenant → configure keys → test → enable in PAY methods · Provider outage → circuit opens → queued → alert → recovers → drains · FHIR client fetches a patient's MedicationRequests with OAuth scopes.

## 5. Data model

`connector` (tenant, category, provider, config, credentials_enc, mode, status, health), `outbound_call` (connector, idempotency_key, request_hash, status, attempts, last_error, response_ref), `inbound_event` (provider, signature_ok, dedupe_key, payload_key, routed_event, status), `settlement_import`, `fhir_resource_map` (internal id ↔ FHIR id), `connector_metric` (rollups).

## 6. State machines

Outbound call `QUEUED → SENT → SUCCEEDED | FAILED → RETRY | DEAD`; connector `CONFIGURED → HEALTHY | DEGRADED | DOWN | DISABLED`.

## 7. Business rules & invariants

INT-R-01 no module calls a provider SDK directly; only via the connector · R-02 all outbound calls idempotent and logged (secrets redacted) · R-03 webhooks verified before any side effect · R-04 PHI sent to providers minimised and documented per connector (data-flow register) · R-05 credentials never leave the secrets store unencrypted; rotation supported.

## 8. API surface

`/integrations/connectors` CRUD + `/test|enable|disable|rotate` · `/integrations/outbound?status` + `/retry` · `/integrations/inbound` · `/webhooks/:provider/:tenantSlug` · `/fhir/r4/*` (read; SMART auth via API module) · `/integrations/metrics`.

## 9. Domain events

**Emits:** `connector.health_changed`, `outbound.failed_final`, `inbound.received`, `settlement.imported` · **Consumes:** module requests via connector clients.

## 10. Audit events

Connector config/credential changes (redacted), manual retries, disable/enable, FHIR access (as clinical reads).

## 11. Screens & UX requirements

Connectors page per tenant (cards with health, configure, test) · Outbound/inbound logs with filters and retry · Metrics dashboard · Data-flow register page (what goes where).

## 12. Validation

Provider config schemas; webhook secrets; FHIR scopes.

## 13. Non-functional requirements

Outbound p95 overhead ≤ 20 ms (excluding provider) · webhook ack ≤ 500 ms · DLQ alert ≤ 5 min · secrets in KMS/Vault.

## 14. Edge cases & failure modes

Provider schema change (versioned adapters; contract tests) · duplicate webhooks (dedupe) · tenant switches gateway mid-day (both connectors active for settlement) · FHIR consumer requests restricted data (scopes + audit).

## 15. Compliance

Data-processing agreements per provider; PHI minimisation; audit of external access; MyInvois/gateway compliance; FHIR access consent where patient-directed.

## 16. Reporting outputs

Connector health/usage; failure rates; provider costs (SaaS metering).

## 17. Acceptance tests (representative)

INT-T-01 outbound retry with same idempotency key → single provider call · T-02 invalid webhook signature → rejected, no side effect · T-03 circuit breaker opens after N failures and recovers · T-04 FHIR Patient read requires scope and is audited.

## 18. Migration & rollout

Refactor EIV/NTF/LAB provider calls onto the framework; gateway first; FHIR read facade with one partner.

## 19. Out of scope

Write-side FHIR (external systems creating records) → later · HL7 v2 → per lab need.

## 20. Open questions

INT-Q-01 gateway provider · Q-02 accounting package · Q-03 FHIR demand (MOH programmes, insurers).

## 21. Definition of done

- [ ] Framework live with ≥ 3 connectors migrated; INT-T-01 … T-04 green; data-flow register published
