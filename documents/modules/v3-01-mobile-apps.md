# Mobile Apps (MOB)

| | |
|---|---|
| **Version** | V3 |
| **Status** | Not started |
| **Spec sections** | 36 |
| **Depends on** | PPT (API), NTF (push), APT, ENC, MEM, LOY, WLT, PAY, DOC, LAB, SEC |
| **Depended on by** | TEL |
| **Est. effort** | — (to be estimated when V3 is next) |

---

## 1. Purpose & business value

Native/hybrid apps for patients (appointments, queue status, membership card, rewards, payment, documents, results, push) and for doctors (schedule, queue, draft review, results inbox, secure notifications). The patient app is a retention and brand surface; the doctor app is a convenience layer, not a replacement for the desktop workspace.

## 2. Actors & permissions

Patient app uses PPT identity and scopes; doctor app uses staff IAM with device binding and MFA; clinic ADMIN configures features/branding; platform manages app store releases (white-label per tenant is V3+).

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| MOB-F-01 | Patient app (React Native/Expo or Flutter — decide at V3 start): login (OTP/biometric), home, appointments, live queue position with push "you're next", digital membership card (QR), loyalty/wallet/packages, pay outstanding, documents/receipts, released results, family switch, notifications centre, language MS/EN. | Must |
| MOB-F-02 | Push notifications via FCM/APNs through NTF as a channel; deep links; quiet hours respected. | Must |
| MOB-F-03 | Doctor app: today's schedule/queue, patient summary (read-only clinical with policy), unsigned drafts list (sign after review on desktop or with full-screen review), results inbox with acknowledge, secure alerts (critical results, APC expiry), no prescribing/dispensing. | Should |
| MOB-F-04 | Offline-tolerant read caches (never clinical writes offline); secure storage; certificate pinning; jailbreak/root detection (warn). | Must |
| MOB-F-05 | App configuration per tenant (branding, enabled features) fetched at launch; kill-switch for old versions. | Must |
| MOB-F-06 | Analytics (privacy-preserving) for adoption; crash reporting without PHI. | Should |

## 4. Key workflows

Push "your appointment is tomorrow" → open → confirm · At clinic: queue position 3 → push "next" → proceed · Doctor: critical result push → open → acknowledge → call patient.

## 5. Data model

`device_registration` (account/user, platform, push token, app version, last seen), `app_config` per tenant, `app_release` (version, min supported), PPT/IAM sessions with device binding.

## 6. State machines

Device: `REGISTERED → ACTIVE → REVOKED`.

## 7. Business rules & invariants

MOB-R-01 apps consume the PPT and staff APIs; no mobile-only data paths · R-02 push payloads contain no PHI (title/body generic; content fetched after auth) · R-03 doctor app clinical reads audited like web · R-04 min-version enforcement server-side.

## 8. API surface

`/portal/v1/*` and `/api/v1/*` reused; `/devices` register/revoke; `/app-config`; `/releases/min-version`.

## 9. Domain events

**Emits:** `device.registered`, `push.sent/failed` (via NTF) · **Consumes:** PPT/NTF events.

## 10. Audit events

Device registrations/revocations; doctor app clinical views; config changes.

## 11. Screens & UX requirements

Mobile-first flows per MOB-F-01/03; accessibility; biometric unlock; offline banners.

## 12. Validation

Push tokens valid; app version semver; feature flags known.

## 13. Non-functional requirements

Cold start ≤ 2 s; push delivery ≤ 30 s; store compliance (Apple/Google health data policies); PHI never in logs/crash reports.

## 14. Edge cases & failure modes

Token rotation; multiple devices; phone number change (PPT re-verify); store review delays; forced logout on tenant suspension.

## 15. Compliance

Store privacy labels; PDPA; secure storage; push content minimisation; doctor device policy (MDM optional).

## 16. Reporting outputs

Adoption, active devices, push delivery, feature usage.

## 17. Acceptance tests (representative)

MOB-T-01 push contains no PHI · T-02 old version blocked by min-version · T-03 queue position updates within 5 s of ENC event · T-04 doctor app clinical view audited.

## 18. Migration & rollout

Beta via TestFlight/Play internal; members first; staged rollout.

## 19. Out of scope

Telemedicine video → `TEL` · wearables → not planned · white-label store listings per tenant → later.

## 20. Open questions

MOB-Q-01 framework choice · Q-02 white-label vs single branded app · Q-03 doctor app appetite.

## 21. Definition of done

- [ ] Store approvals; Must requirements; MOB-T-01 … T-04 green; beta feedback incorporated
