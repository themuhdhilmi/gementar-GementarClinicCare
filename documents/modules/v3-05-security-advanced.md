# Advanced Security (SEC)

| | |
|---|---|
| **Version** | V3 (baseline is V0 — `../05-safety-and-compliance.md` §7) |
| **Status** | Not started |
| **Spec sections** | 41 |
| **Depends on** | IAM, TEN, AUD, ADM, INT |
| **Depended on by** | PPT, MOB, API, TEL |
| **Est. effort** | — |

---

## 1. Purpose & business value

Beyond the V0 baseline: SSO, MFA everywhere, session/device policies, secrets management, tamper-evident audit, data-retention automation, backup/restore drills as a product feature, security monitoring, and the evidence pack that lets a clinic group or insurer sign off on the platform.

## 2. Actors & permissions

ORG_ADMIN sets tenant security policy (`security.policy`); platform security operator manages platform controls, incident response, key rotation; AUDITOR reads evidence.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| SEC-F-01 | **SSO**: OIDC/SAML for staff (Google Workspace, Microsoft Entra), group → role mapping (RBC), JIT provisioning, SCIM deprovisioning; break-glass local admin. | Must |
| SEC-F-02 | **MFA policy** per role (mandatory for clinical/finance/admin), WebAuthn/passkeys, remembered devices policy, step-up for sensitive actions (generalised reauth). | Must |
| SEC-F-03 | **Session/device policy**: idle/absolute timeouts per role, concurrent session limits, device binding (IP/UA/fingerprint) optional, IP allow-lists for admin, remote revoke, session history per user. | Must |
| SEC-F-04 | **Secrets management**: KMS/Vault-backed envelope encryption for all `*_enc` fields, key rotation with re-encryption jobs, per-tenant data keys (crypto-shredding on offboarding). | Must |
| SEC-F-05 | **Tamper-evident audit**: hash-chained audit partitions with periodic external anchoring (e.g. signed digests stored off-platform); verification tool; SIEM export (INT). | Must |
| SEC-F-06 | **Retention automation**: policies per record class (clinical, financial, audit, messaging, employee); legal holds; scheduled purge with approval and evidence; PDPA deletion requests workflow with clinical exemptions. | Must |
| SEC-F-07 | **Backup & restore as a feature**: verified nightly backups, PITR, quarterly restore drills recorded, per-tenant export, RPO/RTO published. | Must |
| SEC-F-08 | **Monitoring & response**: anomaly alerts (mass record views, off-hours admin, failed logins spikes, impossible travel), incident runbooks, breach notification workflow with timelines and templates (PDPA obligations), status page. | Must |
| SEC-F-09 | **Vulnerability management**: dependency scanning, SAST, container scanning, periodic external penetration test, findings tracker. | Must |
| SEC-F-10 | **Evidence pack**: policies, control mappings (e.g. ISO 27001-aligned), test results, DPA templates — downloadable per tenant. | Should |
| SEC-F-11 | Data residency controls per tenant region; encryption in transit internal (mTLS between services when split). | Should |

## 4. Key workflows

Chain HQ enables Microsoft SSO → groups mapped → staff sign in via Entra; leaver removed in Entra → SCIM deprovisions within minutes · Anomaly: user viewed 300 records in an hour → alert → investigation via AUD → action · Quarterly restore drill → report attached to evidence pack.

## 5. Data model

`sso_config` (tenant, provider, metadata, group_mappings, jit, scim_token_hash), `security_policy` (tenant, mfa_by_role, session_rules, ip_allowlists, device_binding), `passkey_credential`, `encryption_key` (tenant, version, wrapped_key, rotated_at), `audit_anchor` (partition, root_hash, anchored_at, external_ref), `retention_policy`, `legal_hold`, `purge_run`, `deletion_request`, `backup_run`, `restore_drill`, `security_alert`, `incident`, `vuln_finding`.

## 6. State machines

Deletion request `RECEIVED → REVIEWED → APPROVED | REJECTED → EXECUTED`; incident `OPEN → CONTAINED → RESOLVED → POST_MORTEM`; key `ACTIVE → ROTATING → RETIRED`.

## 7. Business rules & invariants

SEC-R-01 no plaintext secrets anywhere but the KMS boundary · R-02 audit chain verification runs daily; a break is a P1 · R-03 purges never touch records under legal hold or within clinical retention · R-04 SSO never bypasses MFA policy unless the IdP asserts MFA · R-05 restore drills are real restores to an isolated environment, verified by checksum and sample queries.

## 8. API surface

`/security/sso` config/test · `/security/policy` · `/me/passkeys` · `/security/keys/rotate` (platform) · `/security/audit/verify` · `/security/retention` + `/holds` + `/deletion-requests` · `/security/backups` + `/drills` · `/security/alerts` + `/incidents` · `/security/evidence-pack` · SCIM `/scim/v2/*`.

## 9. Domain events

**Emits:** `sso.login`, `scim.deprovisioned`, `key.rotated`, `audit.chain_verified/broken`, `retention.purged`, `deletion_request.*`, `backup.completed/failed`, `restore_drill.completed`, `security.alert`, `incident.*`.

## 10. Audit events

Everything above, plus policy changes and evidence-pack downloads.

## 11. Screens & UX requirements

Security centre (policy, SSO, MFA status, sessions/devices, alerts, backups, retention, evidence) · Passkey enrolment · Incident workspace (platform).

## 12. Validation

IdP metadata; group mappings to existing roles; retention periods ≥ legal minimums; IP CIDRs.

## 13. Non-functional requirements

SSO login ≤ 2 s; SCIM deprovision ≤ 5 min; audit verification daily ≤ 10 min; RPO ≤ 15 min (PITR), RTO ≤ 4 h documented and drilled.

## 14. Edge cases & failure modes

IdP outage (break-glass local admin with MFA; audited) · key rotation failure mid-way (resumable job; old key retained until complete) · legal hold conflicts with deletion request (hold wins; recorded) · restore drill finds corruption (incident; backup chain review).

## 15. Compliance

PDPA (security principle, breach notification, retention, data subject rights); ISO 27001-aligned controls; DPAs; penetration test evidence; audit immutability.

## 16. Reporting outputs

Security posture dashboard; alerts and incidents; backup/drill history; retention actions; MFA/SSO coverage.

## 17. Acceptance tests (representative)

SEC-T-01 SSO user in mapped group gets the role; removed → deprovisioned · T-02 audit chain verification detects a modified historical row · T-03 purge skips held/clinical-retained records · T-04 key rotation re-encrypts all `*_enc` fields with zero plaintext exposure in logs · T-05 restore drill reproduces a checksum-matching database.

## 18. Migration & rollout

Passkeys/MFA policy first; SSO for the first chain; audit anchoring; retention automation after policies are approved; first external pen test before enterprise sales.

## 19. Out of scope

HSM-backed keys per tenant (unless required) · formal certification (organisational, not product) · DLP on endpoints.

## 20. Open questions

SEC-Q-01 IdPs used by target chains · Q-02 required certifications for enterprise/insurer deals · Q-03 retention periods confirmed by counsel.

## 21. Definition of done

- [ ] Must requirements; SEC-T-01 … T-05 green; pen test findings closed; evidence pack v1 published
