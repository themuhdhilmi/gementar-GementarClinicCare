# Doctor Management (DRM)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 25 |
| **Depends on** | HR, IAM, CON, APT, FIN, RPT, AUD |
| **Depended on by** | ANL, PPT (doctor profiles) |
| **Est. effort** | ~35 h |

---

## 1. Purpose & business value

The doctor-specific slice of staff management: registration and credential currency (MMC/APC), specialty, clinic assignment, consultation schedule, leave, locum rates, commission structure, and performance statistics. Regulatory currency (a doctor practising on a lapsed APC) is the clinic's risk; this module makes it visible.

## 2. Actors & permissions

| Action | ORG_ADMIN | HR | BRANCH_MANAGER | DOCTOR |
|---|:-:|:-:|:-:|:-:|
| `doctor.manage` — profile, credentials, assignments | ✓ | ✓ | – | own view/update contact |
| `doctor.stats` — view statistics | ✓ | ✓ | ✓ (branch) | own |
| Configure public profile (PPT) | ✓ | – | – | own (approval) |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| DRM-F-01 | Doctor profile: employee link, MMC full registration no., APC no. and expiry (document upload), specialty/qualifications, languages, bio/photo (for PPT), signature (DOC), default room, consultation types. | Must |
| DRM-F-02 | Credential monitoring: APC expiry alerts 90/60/30/7 days; expired → blocks new consultations (`clinical.write` denied with clear message) and rostering (HR); ADMIN override with reason for edge cases (renewal in progress, evidence uploaded). | Must |
| DRM-F-03 | Clinic assignment across branches with effective dates (feeds RBC assignments and APT schedules). | Must |
| DRM-F-04 | Consultation schedule view (from APT/HR roster) and leave (HR) in one doctor calendar. | Must |
| DRM-F-05 | Locum rate and commission structure (HR) surfaced on the profile. | Must |
| DRM-F-06 | Statistics: patients per day/period, consultation time distribution, revenue generated (FIN attribution), top diagnoses, prescribing profile (antibiotic rate), MC issuance, amendment rate, follow-up compliance; comparisons anonymised unless policy allows (RPT-Q-03). | Must |
| DRM-F-07 | Clinical governance notes: peer review records, CME log (manual entries with certificates), incidents linked (free text/attachments). | Could |

## 4. Key workflows

APC expiring in 30 days → alerts to doctor and admin → renewal uploaded → expiry updated · New doctor joins → HR employee → DRM profile → RBC assignment → APT schedule → live · Owner reviews doctor dashboard monthly.

## 5. Data model

```
doctor_profile        id, tenant_id, employee_id unique, user_id, mmc_no, apc_no, apc_expiry, apc_document_id, specialty, qualifications jsonb, languages text[], bio, photo_key, default_room_id, consultation_types jsonb, public_profile bool, status
doctor_assignment     id, doctor_profile_id, branch_id, effective_from, effective_to, primary bool
credential_override   id, doctor_profile_id, reason, until, approved_by, at
cme_entry             id, doctor_profile_id, title, points, date, certificate_key
governance_note       id, doctor_profile_id, type, note, attachments jsonb, by, at
```

## 6. State machines

Profile: `ACTIVE → SUSPENDED (credential) → ACTIVE`; `→ INACTIVE` (left).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| DRM-R-01 | `clinical.write`/`clinical.sign` require an ACTIVE doctor profile with valid APC (or an active override). | Clinical guard consults DRM |
| DRM-R-02 | MMC/APC numbers printed on documents come from DRM (single source). | DOC payload |
| DRM-R-03 | Statistics use RPT/FIN read models; DRM stores none. | Boundary |
| DRM-R-04 | Overrides are time-bounded and audited loudly. | Service |

## 8. API surface

`/doctors` CRUD + credentials/documents · `/doctors/:id/assignments` · `/doctors/:id/calendar` · `/doctors/:id/stats?from&to` · `/doctors/:id/overrides` · `/doctors/:id/cme` · `/doctors/:id/governance` · `/me/doctor` self-service.

## 9. Domain events

**Emits:** `doctor.credential_expiring`, `doctor.credential_expired`, `doctor.override_granted`, `doctor.assigned`
**Consumes:** HR employee events; APT/HR schedule events (calendar)

## 10. Audit events

Credential changes and document uploads; overrides; assignment changes; stats views of other doctors (governance).

## 11. Screens & UX requirements

Doctor directory (credential status badges) · Profile (tabs: credentials, assignments, calendar, commission, stats, governance) · Credential alert banner on doctor home · Stats dashboard with period selector.

## 12. Validation

MMC/APC formats; expiry ≥ today on save unless override; assignment dates coherent.

## 13. Non-functional requirements

Guard check ≤ 1 ms (cached per session) · stats ≤ 1 s for 12 months.

## 14. Edge cases & failure modes

Doctor with APC expired mid-day (existing drafts can be signed until midnight per override policy; new consultations blocked) · locum without employee record (HR creates minimal record) · doctor at two tenants (separate profiles).

## 15. Compliance

APC/MMC currency is a regulatory requirement for private clinics; documents retained; stats used for governance, not published externally without consent.

## 16. Reporting outputs

Credential status list; doctor performance (RPT/ANL); CME summary.

## 17. Acceptance tests (representative)

DRM-T-01 APC expired → consultation create 403 with message; override → allowed until date · T-02 alerts at thresholds once each · T-03 documents print MMC no. from profile · T-04 stats for a period match RPT figures.

## 18. Migration & rollout

Profiles created from existing doctor users; APC documents collected; alerts enabled.

## 19. Out of scope

Credential verification with MMC APIs → V3 `INT` · peer-review workflows → not planned.

## 20. Open questions

DRM-Q-01 current APC tracking method · Q-02 whether doctors may see each other's stats · Q-03 public profile content for PPT.

## 21. Definition of done

- [ ] Must requirements implemented; DRM-T-01 … T-04 green
- [ ] All doctors' credentials loaded with expiries
- [ ] Open questions answered
