# Patient Portal (PPT)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 35 |
| **Depends on** | PAT, APT, BIL, PAY, MEM, LOY, WLT, PKG, DOC, LAB, NTF, DRM, SEC |
| **Depended on by** | MOB, TEL |
| **Est. effort** | ~90 h |

> A **new authentication surface for sensitive data**. Treat as a fresh security review, not an extension of staff auth. Separate identity tables; never share `user`.

---

## 1. Purpose & business value

Patient-facing web access: book appointments, see visit history and documents, pay invoices, manage membership/points/packages/wallet, view lab results (when released), manage family accounts. Reduces front-desk load and is the base for the mobile app (MOB) and telemedicine (TEL).

## 2. Actors & permissions

| Actor | Can |
|---|---|
| Patient (portal account) | Everything for self; for linked family members per consent/guardian rules |
| Guardian | Manage minors' records (until age of majority, then handover) |
| Clinic ADMIN | Configure portal (enabled features, branding, booking rules); invite/revoke patient access; view portal audit |

Portal permissions are patient-scoped (`portal.self`, `portal.family:<patientId>`), evaluated per request, never via staff RBAC.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| PPT-F-01 | Portal identity: phone-number-first login (OTP via NTF) with optional email/password; linking to the patient record via IC + OTP verification or front-desk-issued invite code; MFA optional; sessions short-lived; device list. | Must |
| PPT-F-02 | Profile: view demographics, update contact/address (changes flagged for staff review or auto-applied per setting), consents, communication preferences, language. | Must |
| PPT-F-03 | Appointments: search availability (APT), book (types allowed online), reschedule/cancel within policy, reminders, queue status on the day (ENC live position, no other patients' data). | Must |
| PPT-F-04 | Visit history: encounters with date, branch, doctor, diagnosis **only if tenant policy allows** (default: visit summary without diagnosis), documents issued (MC, referral, receipts), prescriptions (names/instructions). | Must |
| PPT-F-05 | Billing: invoices, receipts, outstanding balance, online payment (gateway via INT/FIN), e-Invoice request with TIN capture (EIV). | Must |
| PPT-F-06 | Membership, loyalty, packages, wallet: balances, statements, renew/top-up/purchase online. | Must |
| PPT-F-07 | Lab results: released results (LAB) with doctor's note; download; abnormal flags with "discuss with doctor" guidance. | Should |
| PPT-F-08 | Family: link dependants (guardian verification by front desk or IC match), switch context, per-member views; handover at 18. | Must |
| PPT-F-09 | Messages: view notifications sent; simple secure request form (appointment/query) routed to NTF inbox — not clinical chat. | Should |
| PPT-F-10 | Self check-in (QR at clinic) creating the encounter for a booked appointment or walk-in (kiosk mode). | Could |
| PPT-F-11 | Branding per tenant; feature toggles; terms and privacy acceptance recorded. | Must |
| PPT-F-12 | Accessibility (WCAG 2.1 AA), MS/EN, mobile-first responsive. | Must |

## 4. Key workflows

Sign up with phone → OTP → enter IC → match → linked → book next Tuesday 10:00 with Dr A → reminder → self check-in QR → queue position live → pay online after visit → receipt.

## 5. Data model

```
portal_account         id, tenant_id, phone unique per tenant, email, password_hash (nullable), status, mfa, last_login, terms_accepted_at, language
portal_link            id, portal_account_id, patient_id, relationship enum(SELF, GUARDIAN, DEPENDANT_ADULT_CONSENT), verified_by enum(OTP_IC, FRONTDESK, INVITE), verified_at, valid_until, revoked_at
portal_session         id, portal_account_id, token_hash, device, ip, expires_at, revoked_at
portal_invite          id, tenant_id, patient_id, code_hash, expires_at, used_at, issued_by
portal_config          tenant_id pk, enabled bool, features jsonb, branding jsonb, booking_rules jsonb, diagnosis_visible bool, terms_version
portal_request         id, portal_account_id, patient_id, type, body, status, handled_by, at
portal_audit           via AUD with actor_type = PORTAL_ACCOUNT
```

## 6. State machines

Account `PENDING → ACTIVE → SUSPENDED | CLOSED`; link `PENDING → VERIFIED → REVOKED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PPT-R-01 | Portal identity tables are separate from staff `user`; no shared sessions or tokens. | Schema + code |
| PPT-R-02 | Every portal read of clinical/financial data is authorised against `portal_link` for the target patient and audited with `actor_type = PORTAL_ACCOUNT`. | Guard |
| PPT-R-03 | Clinical detail exposure follows tenant policy; results only after clinician release (LAB). | Service |
| PPT-R-04 | Rate limits and abuse controls on OTP, booking, payment endpoints; CAPTCHA on signup. | Edge |
| PPT-R-05 | Guardian links expire at the dependant's 18th birthday; the dependant is invited to claim. | Job |
| PPT-R-06 | Payments via gateway only; no card data touches the platform (hosted fields/redirect). | INT |

## 8. API surface

Separate API prefix `/portal/v1/*` with its own auth: `/auth/otp`, `/auth/verify`, `/auth/link`, `/me`, `/me/family`, `/appointments` (availability/book/reschedule/cancel), `/queue/status`, `/visits`, `/documents`, `/invoices` + `/pay`, `/membership`, `/loyalty`, `/packages`, `/wallet`, `/results`, `/requests`, `/notifications`; admin `/portal/config`, `/portal/invites`, `/portal/accounts`.

## 9. Domain events

**Emits:** `portal.account_created`, `portal.linked`, `portal.booking_made`, `portal.payment_made`, `portal.request_submitted`, `portal.contact_updated`
**Consumes:** APT/BIL/PAY/MEM/LOY/PKG/WLT/LAB/NTF events for display and notifications

## 10. Audit events

All portal actions with account and patient; staff invites/revocations; config changes; suspicious activity (rate-limit hits).

## 11. Screens & UX requirements

Login/OTP · Home (next appointment, balances, outstanding, results ready) · Book flow (type → doctor/any → slot → confirm) · Visits and documents · Pay (gateway) · Membership/points/packages/wallet cards · Family switcher · Profile and consents · Requests · Accessibility and bilingual throughout.

## 12. Validation

Phone E.164; OTP attempts limited; IC match exact; booking within rules; contact updates validated as PAT.

## 13. Non-functional requirements

Portal pages ≤ 1 s on 3G-class mobile · OTP delivery ≤ 30 s · security testing (OWASP ASVS L2) before launch · isolated deployment (separate Next.js app or route group with separate auth middleware).

## 14. Edge cases & failure modes

Phone number reused by another person (re-verification by IC; old links revoked) · patient merged (links follow) · minor turns 18 (handover) · payment succeeded but callback lost (reconciliation job) · tenant disables portal (accounts suspended; data retained) · result released then amended (notification; version shown).

## 15. Compliance

PDPA: explicit consent, access to own data, contact update trail; clinical exposure policy; guardian/minor rules; security review; terms/privacy versioning; payment PCI scope via gateway.

## 16. Reporting outputs

Portal adoption; online bookings share; online payments; requests volume; family links.

## 17. Acceptance tests (representative)

PPT-T-01 OTP + IC → link VERIFIED; wrong IC → no link · T-02 account without link to patient P → 403 on P's data · T-03 booking respects APT rules and creates appointment with source ONLINE · T-04 diagnosis hidden when policy off · T-05 guardian link revoked at 18 · T-06 payment via gateway updates invoice via PAY with method GATEWAY.

## 18. Migration & rollout

Soft launch to members first; front-desk invites; monitor support requests; then general.

## 19. Out of scope

Native apps → V3 `MOB` · telemedicine → V3 `TEL` · clinical messaging → not planned in V2.

## 20. Open questions

PPT-Q-01 diagnosis visibility policy · Q-02 online booking rules (types, lead time) · Q-03 gateway choice · Q-04 branding.

## 21. Definition of done

- [ ] Security review (ASVS L2) passed
- [ ] Must requirements implemented; PPT-T-01 … T-06 green
- [ ] Soft launch completed with feedback incorporated
- [ ] Open questions answered
