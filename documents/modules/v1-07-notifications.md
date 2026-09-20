# Notifications (NTF)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 34 |
| **Depends on** | PAT (consents), TEN, IAM, AUD; consumers: APT, MEM, PAY, LAB, IAM |
| **Depended on by** | APT, MEM, PNL, EIV, PPT, MOB |
| **Est. effort** | ~45 h |

> This is where **Redis + BullMQ** enter the stack (`../02-architecture.md`). Not before.

---

## 1. Purpose & business value

Reaching the patient outside the clinic — appointment reminders, membership renewals, outstanding balances, results ready — and reaching staff and you (alerts). Also the durable job queue that other modules (EIV submission, exports, reconciliation) start to rely on. Outbound messaging must never block a clinical or billing request, and must respect consent.

## 2. Actors & permissions

| Action | ADMIN | Others |
|---|:-:|:-:|
| Configure channels, providers, templates | ✓ | – |
| Send ad-hoc message to a patient (`notification.send`) | ✓ | FRONTDESK ✓ |
| Create campaigns (`campaign.manage`) | ✓ | – |
| View delivery log for a patient (`notification.read`) | ✓ | ✓ |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| NTF-F-01 | Job infrastructure: Redis + BullMQ with named queues (`notifications`, `einvoice`, `exports`, `maintenance`); retries with backoff; dead-letter queue with admin visibility; per-tenant concurrency fairness. | Must |
| NTF-F-02 | Channels: **WhatsApp** (Business API via a BSP), **SMS** (MY gateway), **Email** (transactional provider), **in-app** (staff). Provider adapters behind one interface; per-tenant provider credentials; sandbox/test mode. | Must |
| NTF-F-03 | Templates per event and channel, per tenant, bilingual (MS/EN; patient preferred language), with variables (patient first name, clinic name, date/time, doctor, amount, link); WhatsApp templates registered with the provider and referenced by name. | Must |
| NTF-F-04 | Event-driven sends: `appointment.reminder_due` (T-24 h/T-2 h), `appointment.booked/rescheduled/cancelled`, `membership.expiring/expired/renewed`, `invoice.issued` (e-receipt link), `payment.received` (receipt), `lab.result_ready` (V2), `encounter.follow_up_due`, `patient.birthday` (if MEM benefit), staff alerts (`stock.critical`, `stock.reconciliation_mismatch`, `cash_session.variance`, `einvoice.rejected`), platform alerts to you. | Must |
| NTF-F-05 | **Consent enforcement**: transactional messages (reminders, receipts) require `REMINDERS` consent for the channel; marketing requires `MARKETING` consent; no consent → not sent, logged as `SUPPRESSED`. Opt-out keywords handled inbound. | Must |
| NTF-F-06 | Inbound handling: WhatsApp/SMS replies routed by conversation context (e.g. "1" confirms appointment) to the owning module via `notification.reply`; unmatched replies land in a staff inbox. | Must |
| NTF-F-07 | Delivery tracking: queued → sent → delivered → read (where available) → failed (reason); per-patient log; per-tenant dashboard; cost tracking per message (for SaaS billing). | Must |
| NTF-F-08 | Quiet hours per tenant (e.g. 21:00–08:00) for non-urgent messages; scheduling to next window. | Must |
| NTF-F-09 | Ad-hoc message to a patient from their record (template-based to satisfy WhatsApp rules; free text within session windows). | Should |
| NTF-F-10 | Campaigns: audience by simple filters (age band, last visit, membership status, condition tag, branch), template, schedule, throttle; requires MARKETING consent; results (sent/delivered/replied/opt-out). | Should |
| NTF-F-11 | Dedupe: idempotency key per (event, entity, kind, channel); no double reminders. | Must |
| NTF-F-12 | Fallback chain per template (WhatsApp → SMS if not delivered within N minutes). | Should |

## 4. Key workflows

Appointment booked → job scheduled for T-24 h → quiet hours checked → WhatsApp template sent → delivered → patient replies "1" → APT marks CONFIRMED · Stock critical → in-app + WhatsApp to ADMIN · Campaign: flu vaccine to patients 60+ with MARKETING consent → 340 sent, 12 opt-outs processed.

## 5. Data model

```
notification_provider   id, tenant_id, channel, provider, credentials_enc, config jsonb, mode, status
notification_template   id, tenant_id, key, channel, language, provider_template_name, subject, body, variables jsonb, version, active
notification            id, tenant_id, branch_id, channel, template_key, recipient_type enum(PATIENT, USER, EXTERNAL), recipient_id, to_address,
                        language, payload jsonb, rendered jsonb, status enum(QUEUED, SUPPRESSED, SENT, DELIVERED, READ, FAILED, CANCELLED),
                        suppressed_reason, provider_msg_id, error, cost_sen, scheduled_for, sent_at, delivered_at, read_at,
                        dedupe_key unique, source_event, source_id
                        INDEX (recipient_type, recipient_id, created_at desc); INDEX (tenant_id, status, scheduled_for)
notification_inbound    id, tenant_id, channel, from_address, body, received_at, matched_notification_id, routed_to, handled_by, handled_at
campaign                id, tenant_id, name, template_key, audience jsonb, scheduled_at, throttle_per_min, status, stats jsonb, created_by
campaign_recipient      id, campaign_id, patient_id, notification_id, status
quiet_hours             tenant_id pk, start_time, end_time, timezone
```

## 6. State machines

Notification: `QUEUED → SENT → DELIVERED → READ`; `QUEUED → SUPPRESSED | CANCELLED`; `SENT → FAILED` (→ fallback creates a new notification).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| NTF-R-01 | No message leaves without a consent check against PAT at send time (not at queue time). | Sender |
| NTF-R-02 | Sends are asynchronous; the emitting request never awaits provider I/O. | Queue design |
| NTF-R-03 | `dedupe_key` unique; duplicate enqueues are no-ops. | DB |
| NTF-R-04 | Rendered content is stored (what was actually sent), templates versioned. | Service |
| NTF-R-05 | Clinical content is never sent over messaging channels (results → "ready, please log in/visit"; never values). | Template review + payload guard |
| NTF-R-06 | Provider credentials encrypted; per-tenant; never shared across tenants. | Service |
| NTF-R-07 | Marketing requires MARKETING consent; opt-out is honoured within 1 minute of receipt. | Sender + inbound handler |

## 8. API surface

`/notifications/providers` CRUD + test · `/notifications/templates` CRUD + preview · `POST /patients/:id/notifications` (ad-hoc) · `GET /patients/:id/notifications` · `GET /notifications?status&channel&from` · `POST /notifications/:id/cancel|resend` · `/notifications/inbox` (unmatched inbound) · `/campaigns` CRUD + `/schedule|pause|cancel` · provider webhooks `/webhooks/:provider` (signature-verified) · admin `/queues` health.

## 9. Domain events

**Emits:** `notification.queued`, `notification.sent`, `notification.delivered`, `notification.failed`, `notification.suppressed`, `notification.reply` `{ channel, from, body, context }`, `campaign.completed`
**Consumes:** all events listed in NTF-F-04

## 10. Audit events

Provider/template changes; ad-hoc sends (who, to whom, template); campaign creation/sends; opt-outs; exports of logs.

## 11. Screens & UX requirements

Patient → Messages tab (log with status, resend) · Templates editor with variable picker, bilingual side-by-side, preview with sample patient · Providers setup with test send · Inbox for unmatched replies · Campaigns builder (audience count preview) · Queue health (admin/platform).

## 12. Validation

Template variables must exist; WhatsApp templates must match registered names/params; phone E.164; quiet hours valid; campaign audience ≤ tenant cap; throttle ≥ 1/min.

## 13. Non-functional requirements

Reminder dispatch within 5 min of scheduled time · 10 k messages/hour per tenant throughput · provider webhook processing ≤ 1 s · queue durability across restarts (Redis persistence) · cost per message recorded for SaaS metering.

## 14. Edge cases & failure modes

Provider outage (retry; fallback channel; dashboard alert) · patient changes phone (send to current PAT phone at send time) · WhatsApp 24-h session rules (templates only outside sessions) · reply to an old reminder (context expiry; route to inbox) · patient without consent but clinically important (staff call; system does not bypass) · duplicate webhook deliveries (idempotent by provider_msg_id) · Redis down (API keeps working; enqueue fails soft with alert; jobs resume).

## 15. Compliance

PDPA consent and opt-out; no clinical content over messaging; provider data-processing terms reviewed; message logs retained per policy; WhatsApp Business policy compliance.

## 16. Reporting outputs

Sent/delivered/failed by channel and template; reminder effectiveness (no-show rate with vs without); cost per period; opt-out rate; campaign results.

## 17. Acceptance tests (representative)

NTF-T-01 patient without REMINDERS consent → notification SUPPRESSED, nothing sent · T-02 duplicate enqueue with same dedupe_key → one row · T-03 quiet hours → scheduled_for moved to window start · T-04 inbound "1" matched to reminder → `notification.reply` with context → APT confirms · T-05 provider failure → retries then FAILED → fallback SMS queued · T-06 opt-out keyword → MARKETING consent revoked within 1 min.

## 18. Migration & rollout

Provider accounts (WhatsApp BSP, SMS, email) set up; templates approved by WhatsApp; consent backfill campaign (ask at front desk for a month before enabling reminders); preview mode first two weeks.

## 19. Out of scope

Push notifications → V3 `MOB` · medication reminders → V3 · two-way chat/inbox as a product → V2/V3 · voice calls → not planned.

## 20. Open questions

NTF-Q-01 WhatsApp BSP choice and cost per message · Q-02 SMS gateway · Q-03 who monitors the reply inbox · Q-04 quiet hours preference · Q-05 whether they want e-receipts by default.

## 21. Definition of done

- [ ] Redis/BullMQ deployed with monitoring; DLQ visible
- [ ] Must requirements implemented; NTF-T-01 … T-06 green
- [ ] Providers configured; templates approved; consent capture live at front desk
- [ ] Open questions answered
