# Telemedicine (TEL)

| | |
|---|---|
| **Version** | V3 |
| **Status** | Not started |
| **Spec sections** | 38 |
| **Depends on** | APT, ENC, CON, RX, DSP, PAY, DOC, PPT, MOB, NTF, INT, SEC |
| **Depended on by** | — |
| **Est. effort** | — |

> Telemedicine and e-prescribing carry their own regulatory requirements in Malaysia (MMC guidelines, Telemedicine Act status, Poisons Act constraints on remote prescribing). **Research and record the current position before building.**

---

## 1. Purpose & business value

Remote consultations for follow-ups and minor ailments: online booking, video consultation, online payment, electronic prescription, and medication delivery or pickup — as an encounter type flowing through the same clinical, billing and dispensing modules.

## 2. Actors & permissions

Patient (PPT/MOB) books/joins; DOCTOR conducts (`tele.consult`); FRONTDESK/dispenser handles delivery/pickup; ADMIN configures services, fees, delivery partners.

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| TEL-F-01 | Appointment type `TELE` with eligibility rules (existing patient, seen in last N months, non-emergency screening questionnaire). | Must |
| TEL-F-02 | Pre-consult: identity confirmation (IC + selfie optional), consent to telemedicine (recorded), payment pre-authorisation or upfront fee via gateway. | Must |
| TEL-F-03 | Video: WebRTC via a provider (Twilio/Daily/100ms) with waiting room, doctor-controlled admit, screen share for documents, chat, recording **off by default** (if enabled, consent and retention policy). | Must |
| TEL-F-04 | Encounter type `TELE` → CON workspace (same), RX with remote-prescribing constraints (excluded classes/controlled drugs), MC issuance policy for tele visits, referral. | Must |
| TEL-F-05 | Fulfilment: e-prescription to clinic pharmacy → DSP queue `DELIVERY`/`PICKUP`; delivery partner integration (INT) with tracking; cold-chain exclusions; patient confirmation of receipt. | Must |
| TEL-F-06 | Post-consult: payment settlement, receipt, documents to PPT, follow-up booking. | Must |
| TEL-F-07 | Fallback: connection failure → phone consult option with recorded consent; reschedule. | Should |

## 4. Key workflows

Book tele slot → pay → join waiting room → doctor admits → consult → RX → dispense → delivery → receipt/MC in portal.

## 5. Data model

`tele_session` (encounter_id, provider_room_id, started/ended, participants, quality metrics, recording_key?, consent_id), `tele_consent`, `tele_eligibility_answer`, `delivery_order` (dispense_id, partner, address, status, tracking, proof), `pickup_slot`.

## 6. State machines

Session: `SCHEDULED → WAITING → IN_CALL → ENDED | FAILED`; delivery: `PENDING → PACKED → DISPATCHED → DELIVERED | FAILED | RETURNED`.

## 7. Business rules & invariants

TEL-R-01 tele encounters use the same immutable clinical records and audit · R-02 controlled/excluded drugs cannot be prescribed in TELE encounters (RX rule) · R-03 consent recorded before the call starts · R-04 video provider receives no PHI beyond room identifiers · R-05 delivery of medicines follows dispensing controls (batch, label) and proof of delivery.

## 8. API surface

PPT/MOB booking with type TELE; `/tele/sessions/:id/token|admit|end`; `/tele/consents`; `/deliveries` CRUD + partner webhooks; DSP fulfilment flags.

## 9. Domain events

**Emits:** `tele.session_started/ended/failed`, `delivery.dispatched/delivered/failed` · **Consumes:** APT, ENC, DSP, PAY events.

## 10. Audit events

Consents, session events, recording access (if any), delivery proofs.

## 11. Screens & UX requirements

Patient: pre-check (device test), waiting room, call UI, post-visit summary · Doctor: tele queue, call panel beside CON workspace, connection quality indicator · Pharmacy: delivery/pickup queue with packing checklist.

## 12. Validation

Eligibility answers; consent required; address for delivery; excluded items blocked.

## 13. Non-functional requirements

Join ≤ 5 s; call quality metrics logged; provider SLA; encryption in transit for media (DTLS-SRTP).

## 14. Edge cases & failure modes

Patient no-show to call (no-show rules; fee policy) · doctor drops mid-call (rejoin; note) · prescription needs physical exam (convert to in-person booking) · delivery failed (return to stock via quarantine rules) · recording requested by patient (policy).

## 15. Compliance

Malaysian telemedicine and prescribing regulations; consent; data flows to video/delivery providers under DPAs; MC via tele policy; cross-border consults not supported.

## 16. Reporting outputs

Tele volume, conversion to in-person, call quality, delivery performance, revenue.

## 17. Acceptance tests (representative)

TEL-T-01 consent missing → cannot start call · T-02 controlled drug in TELE RX → blocked · T-03 delivery dispatch requires completed dispense with labels · T-04 session events audited.

## 18. Migration & rollout

Pilot with follow-up visits for stable chronic patients; expand by service.

## 19. Out of scope

Remote monitoring devices; cross-border; AI triage.

## 20. Open questions

TEL-Q-01 current regulatory position · Q-02 video provider · Q-03 delivery partner(s) · Q-04 services suitable for tele at the pilot.

## 21. Definition of done

- [ ] Regulatory review recorded; Must requirements; TEL-T-01 … T-04 green; pilot cohort completed
