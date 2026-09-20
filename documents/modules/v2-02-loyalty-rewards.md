# Loyalty & Rewards (LOY)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 17 |
| **Depends on** | PAT, BIL, PAY, MEM, NTF, AUD |
| **Depended on by** | PPT, MOB |
| **Est. effort** | ~50 h |

> Points are **earned**; the wallet (WLT) is **prepaid money**; membership (MEM) is **entitlements**. Three ledgers, never mixed.

---

## 1. Purpose & business value

Earn-and-redeem points, referral and birthday rewards, vouchers and campaigns — retention mechanics for clinics competing on patient relationships. Modelled as a strict ledger so points can never be double-spent and their liability can be reported.

## 2. Actors & permissions

| Action | ADMIN | FRONTDESK | Others |
|---|:-:|:-:|:-:|
| `loyalty.read` — balance on header | ✓ | ✓ | ✓ |
| `loyalty.redeem` — redeem at billing | ✓ | ✓ | – |
| `loyalty.adjust` — manual grant/deduct with reason | ✓ | – | – |
| `loyalty.config` — rules, tiers, vouchers, campaigns | ✓ | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| LOY-F-01 | Programme config: earn rate (points per RM on eligible spend by line type), rounding, eligibility (exclude panel-paid portions, memberships fees optional), tiers (thresholds by lifetime/12-month points; tier benefits as multipliers or MEM-like perks), point expiry (months since earn, or fixed annual), minimum redemption, redemption value (points → sen), max % of invoice redeemable. | Must |
| LOY-F-02 | Earn on `payment.received` (patient-paid portion, net of discounts and redemptions), posted after invoice PAID; reversed on void/refund. | Must |
| LOY-F-03 | Redeem at billing as an invoice-level discount `discount_source = LOYALTY` with the ledger entry in the same transaction; reversal on void. | Must |
| LOY-F-04 | Vouchers: generated codes (single/multi-use, value or %, scope, expiry, per-patient), issued by campaigns, referrals, birthdays or manually; redeemed at billing as `PROMO` discount with voucher reference. | Must |
| LOY-F-05 | Referral: referrer code on patient; new patient enters code at registration; both rewarded (points/voucher) after the referee's first paid visit. | Should |
| LOY-F-06 | Birthday reward: voucher or bonus points in birthday month (NTF message). | Should |
| LOY-F-07 | Campaigns: bonus points (2× on vaccinations in May), bounded by dates/branches; stacking rules. | Should |
| LOY-F-08 | Point expiry job with pre-expiry reminders (NTF) and FIFO consumption. | Must |
| LOY-F-09 | Ledger and statement per patient; lifetime points; tier history. | Must |
| LOY-F-10 | Liability report: outstanding points × redemption value; expiry forecast. | Must |

## 4. Key workflows

Pay RM 86 → 86 points earned (1 pt/RM) → next visit balance 412 → redeem 400 = RM 20 off → ledger −400 · Referral code at registration → referee pays first visit → both +200 · Points expiring in 30 days → WhatsApp reminder.

## 5. Data model

```
loyalty_program        tenant_id pk, earn_rules jsonb, redeem_value_sen_per_point int, min_redeem int, max_redeem_pct, expiry_months, tiers jsonb, active
loyalty_account        id, tenant_id, patient_id unique, tier, lifetime_points bigint, referral_code unique, referred_by_patient_id, enrolled_at
loyalty_ledger         id, account_id, type enum(EARN, REDEEM, EXPIRE, ADJUST, BONUS, REVERSAL, REFERRAL, BIRTHDAY), points int (signed),
                       balance_after int, invoice_id, payment_id, campaign_id, voucher_id, expires_at, consumed_points int (for FIFO on EARN), reason, by, at
                       INDEX (account_id, at); INDEX (account_id, expires_at) WHERE type = 'EARN'
voucher                id, tenant_id, code unique, kind enum(AMOUNT, PERCENT), value, scope jsonb, max_uses, uses, per_patient_limit, patient_id (if personal), valid_from, valid_to, campaign_id, status
voucher_redemption     id, voucher_id, invoice_id, patient_id, amount_sen, at
loyalty_campaign       id, tenant_id, name, kind enum(BONUS_POINTS, VOUCHER_ISSUE), rules jsonb, branches jsonb, starts_at, ends_at, status
```

## 6. State machines

Voucher: `ACTIVE → EXHAUSTED | EXPIRED | CANCELLED`. Campaign: `DRAFT → SCHEDULED → RUNNING → ENDED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| LOY-R-01 | Balance = Σ ledger; `balance_after` on every row; never negative. | Service + CHECK via trigger |
| LOY-R-02 | Earn only on patient-paid, fully paid invoices; reversal on void/refund proportional. | Service on PAY/BIL events |
| LOY-R-03 | Redemption written in BIL's transaction; voiding the invoice reverses it. | Service call inside BIL |
| LOY-R-04 | FIFO expiry: redemptions consume oldest EARN rows first; expiry job expires unconsumed remainder. | Service |
| LOY-R-05 | Vouchers single-use enforced with row lock; personal vouchers only for their patient. | Service |
| LOY-R-06 | No cash-out of points; no conversion to wallet (WLT) or membership (MEM). | Boundary |

## 8. API surface

`/loyalty/program` get/put · `/patients/:id/loyalty` (account, balance, ledger, statement) · `POST /invoices/:id/loyalty/redeem` · `POST /invoices/:id/vouchers/apply` · `/vouchers` CRUD + `/generate` · `/loyalty/campaigns` CRUD · `POST /patients/:id/loyalty/adjust` · `/reports/loyalty/liability`.

## 9. Domain events

**Emits:** `loyalty.earned`, `loyalty.redeemed`, `loyalty.expired`, `loyalty.expiring`, `loyalty.tier_changed`, `voucher.issued`, `voucher.redeemed`, `referral.rewarded`
**Consumes:** `payment.received`, `invoice.voided`, `payment.refunded`, `patient.registered` (referral code), `patient.birthday` (scheduler)

## 10. Audit events

Manual adjustments (reason), programme rule changes, voucher generation/cancellation, campaign changes.

## 11. Screens & UX requirements

Header chip (points, tier) · Loyalty tab (ledger, expiring soon, vouchers, referral code with share) · Redeem control on billing (slider/points input with RM equivalent; max enforced) · Voucher code field on billing · Programme settings with earn simulator · Campaign builder · Liability report.

## 12. Validation

Redeem ≥ min, ≤ balance, ≤ max % of invoice; voucher within validity and scope; adjustment reason ≥ 10 chars.

## 13. Non-functional requirements

Redeem/earn ≤ 30 ms in transaction · expiry job for 100 k accounts ≤ 5 min · liability report ≤ 1 s.

## 14. Edge cases & failure modes

Partial refund after earn (proportional reversal may exceed balance → negative prevented; residual recorded as ADJUST with note) · patient merge (accounts merged; ledger appended) · voucher applied then invoice voided (use restored) · tier downgrade on expiry (policy: annual review only) · referral fraud (same phone/IC checks; limits per referrer).

## 15. Compliance

Points liability is a financial liability for the accountant (FIN report); marketing messages need consent (NTF); programme terms shown at enrolment.

## 16. Reporting outputs

Points earned/redeemed/expired per period; liability; tier distribution; voucher performance; referral conversions; campaign ROI (revenue uplift vs points cost).

## 17. Acceptance tests (representative)

LOY-T-01 pay RM 86 → +86 points, balance_after correct · T-02 redeem 400 → invoice discount RM 20, ledger −400 in same tx; void → reversal · T-03 FIFO expiry consumes oldest first · T-04 single-use voucher second use → 409 · T-05 referral rewards both after referee's first paid visit only · T-06 liability = Σ unexpired balance × value.

## 18. Migration & rollout

Import existing points balances (if any) as opening ADJUST; programme terms published; front desk trained on redemption.

## 19. Out of scope

Coalition/partner points → not planned · gamification → V3 `MOB`.

## 20. Open questions

LOY-Q-01 earn/redeem rates the owner wants · Q-02 existing scheme to migrate · Q-03 referral rewards appetite.

## 21. Definition of done

- [ ] Must requirements implemented; LOY-T-01 … T-06 green
- [ ] Programme configured; first month liability reconciled
- [ ] Open questions answered
