# Membership & Benefits (MEM)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 15, 16 |
| **Depends on** | PAT, BIL, PAY, ENC, NTF, AUD |
| **Depended on by** | LOY, PKG, PPT, RPT/FIN |
| **Est. effort** | ~70 h |

---

## 1. Purpose & business value

The product differentiator. Most Malaysian clinic software treats membership as a discount flag; this module treats it as a first-class subscription with plans, entitlements, benefit usage tracking, renewals and a ledger — which is what lets a clinic run a chronic-care programme, a family plan or a corporate wellness scheme without a spreadsheet.

Deferred from V0 because a clinic operates without it. First in V1 because it is what sells to clinic number two.

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `membership.read` — see status, entitlements on patient header | ✓ | ✓ | ✓ | ✓ |
| `membership.sell` — enrol, renew, collect fee | ✓ | – | – | ✓ |
| `membership.manage` — freeze, suspend, cancel, adjust entitlements, transfer | ✓ | – | – | – |
| `membership.plans` — define plans and benefits | ✓ | – | – | – |
| Apply benefits at billing (automatic; manual override needs `invoice.discount`) | ✓ | – | – | ✓ |

## 3. Functional requirements

### Plans
| ID | Requirement | Priority |
|---|---|---|
| MEM-F-01 | Plan: code, name, type (`INDIVIDUAL`, `FAMILY`, `CORPORATE`, `SENIOR`, `CHRONIC_CARE`, `CUSTOM`), billing period (`MONTHLY`, `QUARTERLY`, `ANNUAL`, `LIFETIME`), fee (sen), joining fee, max members (family), eligibility rules (age band, residency, corporate account), grace days after expiry, auto-renew allowed, branch scope (all / list), status, effective dates. Plan versions: changes create a new version; existing memberships keep theirs until renewal. | Must |
| MEM-F-02 | Benefits per plan version — a typed list: `DISCOUNT` (scope: consultation / medicine / procedure / all / category / product list; pct or amount; cap per visit), `FREE_SERVICE` (procedure or billable item; count per period), `FREE_VISITS` (consultation fee waived; n per period), `PRIORITY_QUEUE`, `SPECIAL_PRICE` (product/procedure → price), `BIRTHDAY_REWARD` (voucher/discount in birthday month), `ANNUAL_SCREENING` (package link, V2), branch restrictions per benefit, usage limits per period and per membership term. | Must |
| MEM-F-03 | Stackability rules: a benefit declares whether it stacks with manual discounts; default no — the better of the two applies; recorded on the line. | Must |

### Memberships
| ID | Requirement | Priority |
|---|---|---|
| MEM-F-04 | Enrol a patient: plan, start date, term computed, fee collected via BIL/PAY (`MEMBERSHIP` line type, its own invoice or added to the encounter invoice), membership number (`<TENANT>-M-<seq>`), card (printable PDF/QR; physical card no. optional). | Must |
| MEM-F-05 | Family membership: primary member + dependants (patients linked as `family_member` with relationship); shared entitlements with per-member caps optional; add/remove dependants mid-term with pro-rata fee option. | Must |
| MEM-F-06 | Corporate membership: linked to a `corporate_account` (PNL); employees enrolled by list; billing to the corporate (invoice payer = CORPORATE). | Should (with PNL) |
| MEM-F-07 | Lifecycle: `PENDING_PAYMENT` → `ACTIVE` → `GRACE` → `EXPIRED`; `ACTIVE` → `FROZEN` (medical/travel; term extended by frozen days) → `ACTIVE`; `ACTIVE` → `SUSPENDED` (non-payment/abuse; benefits off) → `ACTIVE`/`CANCELLED`; `CANCELLED` (with optional pro-rata refund via FIN credit note). | Must |
| MEM-F-08 | Renewal: manual (sell renewal) or auto (if plan allows and a payment method on file — V1 gateway); reminders at 30/7/0 days via NTF; renewal creates a new term row, preserving history. | Must |
| MEM-F-09 | Entitlement ledger: every benefit consumption is a row (membership, benefit, encounter, invoice line, quantity/value, timestamp); balances are derived; reversals on void. | Must |
| MEM-F-10 | Patient header shows: plan name, status, expiry, key remaining entitlements (e.g. "2 free visits left"); priority-queue benefit sets encounter priority hint (ENC). | Must |
| MEM-F-11 | Billing integration: on draft assembly and on each line event, MEM evaluates applicable benefits and writes line discounts with `discount_source = MEMBERSHIP` and `membership_benefit_id`; FRONTDESK can remove an auto-applied benefit (reason) but not increase it. | Must |
| MEM-F-12 | Upgrade/downgrade plan mid-term with pro-rata calculation (configurable: pro-rata or at renewal). | Should |
| MEM-F-13 | Transfer membership between patients (rare; ADMIN; reason). | Could |
| MEM-F-14 | Membership history and statement per member (fees paid, benefits used with values). | Must |

## 4. Key workflows

**Sell at front desk**: search patient → Membership → choose plan → start today → invoice RM 120 (membership line) → pay → ACTIVE → card printed/emailed.

**Automatic benefit at billing**: member with 10% medicine discount and 1 free visit left → consultation line discount 100% (`FREE_VISITS`, entitlement −1) → medicine lines −10% → cashier sees badges per line → issue.

**Renewal reminder → renewal**: NTF sends at 7 days → patient visits → header shows "expires in 3 days" → renew → new term.

**Freeze**: member travelling 2 months → freeze with dates → expiry extended by 61 days → benefits unavailable while frozen.

## 5. Data model

```
membership_plan             id, tenant_id, code, name, type, status, created_at
membership_plan_version     id, plan_id, version, billing_period, fee, joining_fee, max_members, grace_days,
                            auto_renew_allowed, eligibility jsonb, branch_scope jsonb, effective_from, effective_to
membership_benefit          id, plan_version_id, kind, scope jsonb, value jsonb, limit_per_period int, period enum,
                            limit_per_term int, stackable bool, branch_scope jsonb, sort
membership                  id, tenant_id, membership_no, plan_id, plan_version_id, primary_patient_id,
                            corporate_account_id, status, start_date, end_date, grace_until, auto_renew,
                            frozen_from, frozen_to, frozen_days_total, cancelled_at, cancel_reason,
                            card_no, notes
                            UNIQUE (tenant_id, membership_no); INDEX (primary_patient_id, status)
membership_member           id, membership_id, patient_id, relationship, role enum(PRIMARY, DEPENDANT), joined_at, left_at
                            UNIQUE (membership_id, patient_id)
membership_term             id, membership_id, term_no, start_date, end_date, fee, invoice_id, paid_at, renewal_of_term_id
membership_entitlement_ledger
                            id, membership_id, member_patient_id, benefit_id, term_id, encounter_id, invoice_line_id,
                            quantity numeric, value_sen bigint, type enum(CONSUME, REVERSE, ADJUST, GRANT), reason, at, by
                            INDEX (membership_id, benefit_id, term_id)
membership_number_seq       tenant_id pk, next
```

BIL additions (already nullable in V0): `invoice.membership_id`; `invoice_line.discount_source = 'MEMBERSHIP'`, `invoice_line.membership_benefit_id`, `invoice_line.entitlement_ledger_id`.

## 6. State machines

```
PENDING_PAYMENT ──paid──► ACTIVE ──end_date──► GRACE ──grace_until──► EXPIRED ──renew──► ACTIVE
                            │ ▲                                                   
                 freeze ────┘ └──── unfreeze          ACTIVE ──suspend──► SUSPENDED ──reinstate──► ACTIVE
                            FROZEN                                              └──cancel──► CANCELLED
                 ACTIVE/GRACE ──cancel──► CANCELLED
```

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| MEM-R-01 | Benefits apply only while status ∈ {ACTIVE, GRACE} and the branch is in scope. | Benefit evaluator |
| MEM-R-02 | Entitlement balance = Σ ledger (GRANT + ADJUST − CONSUME + REVERSE) per benefit per term; never a stored counter. | Ledger |
| MEM-R-03 | Consumption is written in the same transaction as the invoice line discount; voiding the invoice reverses it. | BIL/MEM coupling via service call inside BIL's transaction (not via event) |
| MEM-R-04 | A plan version is immutable once any membership references it. | Service |
| MEM-R-05 | Family shared limits are enforced across all members atomically (lock on membership row). | Service |
| MEM-R-06 | Membership fees are invoiced through BIL; MEM never records money itself. | Boundary |
| MEM-R-07 | Frozen days extend `end_date` exactly; total frozen days per term ≤ plan cap. | Service |
| MEM-R-08 | Loyalty points (LOY) are a separate ledger; MEM benefits never mint points and points never grant MEM entitlements. | Boundary |

## 8. API surface

`/membership-plans` CRUD + `/versions`; `/patients/:id/memberships`; `POST /memberships` (enrol); `POST /memberships/:id/renew|freeze|unfreeze|suspend|reinstate|cancel|upgrade`; `POST /memberships/:id/members` / `DELETE …/:pid`; `GET /memberships/:id/entitlements`; `GET /memberships/:id/statement`; `GET /memberships/:id/card`; internal `BenefitEvaluator.apply(tx, invoiceDraft)` called by BIL.

## 9. Domain events

**Emits:** `membership.enrolled`, `membership.activated`, `membership.renewed`, `membership.expiring` (30/7/0), `membership.expired`, `membership.frozen`, `membership.suspended`, `membership.cancelled`, `benefit.consumed`, `benefit.reversed`
**Consumes:** `payment.received` (activate pending), `invoice.voided` (reverse consumption), `encounter.created` (priority hint), daily scheduler (expiry transitions)

## 10. Audit events

All lifecycle events; plan/version/benefit changes; manual entitlement adjustments (reason); benefit removal at billing (reason).

## 11. Screens & UX requirements

Patient header membership chip (status colour, expiry, remaining key entitlements) · Membership tab (terms, members, entitlements with balances, ledger, statement, card) · Sell/renew dialog (plan picker with fee, start date, members for family, invoice preview) · Plans admin (versions, benefits builder with scope/value/limits, preview of a sample invoice) · Billing badges per line (benefit name, remove with reason) · Expiring list (NTF-driven) on dashboard.

## 12. Validation

Plan fee ≥ 0; term dates computed not entered (except backdated enrolment with reason ≤ 30 d); family max members; benefit limits ≥ 0; freeze ≤ plan cap; cancel reason required.

## 13. Non-functional requirements

Benefit evaluation ≤ 30 ms per invoice draft refresh · entitlement query ≤ 20 ms · nightly status transitions for 50 k memberships ≤ 2 min · statement PDF ≤ 2 s.

## 14. Edge cases & failure modes

Member visits during GRACE (benefits apply; renewal prompt) · dependant is also a primary elsewhere (blocked) · free visit consumed then invoice voided (reversed, balance restored) · plan discontinued (existing terms honoured; no new enrolments) · benefit limit hit mid-invoice (partial application; message) · patient merged (membership follows survivor) · corporate stops paying (suspend all linked; PNL) · birthday benefit for Feb 29 (treated as Feb 28 in non-leap years).

## 15. Compliance

Membership fees may be subject to SST/consumer law considerations (advance payment) — confirm with accountant; refunds on cancellation policy must be written and shown at enrolment; PDPA consent for renewal reminders.

## 16. Reporting outputs

Active members by plan; new/renewed/lapsed per period; membership revenue; benefit usage and value given; renewal rate; expiring next 30 days.

## 17. Acceptance tests (representative)

MEM-T-01 enrol → invoice line → pay → ACTIVE · T-02 10% medicine benefit → correct line discounts to the sen · T-03 free visit consumed → ledger −1; invoice void → +1 · T-04 family shared limit 3 → 4th member visit gets no free visit · T-05 freeze 30 d → end_date +30 · T-06 nightly job → GRACE → EXPIRED transitions on the right days · T-07 non-stackable benefit vs manual 15% → the larger applies, both recorded · T-08 plan version change → existing membership unaffected.

## 18. Migration & rollout

Import existing members (plan, expiry, number) with dry-run; map their current benefit scheme to plan benefits; parallel-check first month's discounts; card template approved.

## 19. Out of scope

Loyalty points → V2 `LOY` · prepaid wallet → V2 `WLT` · packages → V2 `PKG` · online self-enrolment → V2 `PPT` · gateway auto-renew → with FIN/INT gateway.

## 20. Open questions

MEM-Q-01 plans the pilot wants to sell · Q-02 current member list format · Q-03 refund policy on cancellation · Q-04 family definition and max size · Q-05 branch-specific benefits needed at launch?

## 21. Definition of done

- [ ] Must requirements implemented; MEM-T-01 … T-08 green
- [ ] Benefit evaluation integrated into BIL with reversal on void
- [ ] Existing members imported and first month's discounts reconciled
- [ ] Open questions answered
