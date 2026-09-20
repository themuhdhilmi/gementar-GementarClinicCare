# Patient Wallet (WLT)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 18 |
| **Depends on** | PAT, BIL, PAY, FIN, NTF, AUD |
| **Depended on by** | PPT, MOB, PKG |
| **Est. effort** | ~35 h |

> Prepaid customer money. Separate from loyalty points (LOY) and from membership entitlements (MEM). **Check the regulatory position on holding prepaid balances before launch** (WLT-Q-01).

---

## 1. Purpose & business value

Prepaid credit: top up, spend at billing, refund, family wallet later. Useful for chronic patients, parents, and corporate-sponsored allowances. Modelled as a money ledger with the same discipline as stock and payments.

## 2. Actors & permissions

| Action | ADMIN | FRONTDESK | Others |
|---|:-:|:-:|:-:|
| `wallet.read` | ✓ | ✓ | ✓ |
| `wallet.topup` — accept top-up (via PAY) | ✓ | ✓ | – |
| `wallet.spend` — pay invoice from wallet | ✓ | ✓ | – |
| `wallet.refund` / adjust | ✓ | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| WLT-F-01 | Wallet per patient (created on first top-up); balance in sen; status. | Must |
| WLT-F-02 | Top-up: any PAY method; recorded as a wallet `TOPUP` credit and a PAY payment against a `WALLET_TOPUP` standalone invoice (so the till, receipts and e-Invoice stay consistent). Optional top-up bonuses (e.g. RM 500 → +RM 25 credit as `BONUS`, liability-tracked). | Must |
| WLT-F-03 | Spend: `WALLET` becomes a PAY method; paying an invoice debits the wallet in PAY's transaction; partial wallet + other methods allowed. | Must |
| WLT-F-04 | Refund of wallet balance (ADMIN; policy: cash/transfer; bonus credits non-refundable); refund document (FIN). | Must |
| WLT-F-05 | Family wallet: a wallet owned by one patient with authorised users (linked patients) and optional per-user limits. | Could |
| WLT-F-06 | Statement and ledger per wallet; low-balance notification (NTF) optional. | Must |
| WLT-F-07 | Liability report (total balances; bonus vs paid split). | Must |
| WLT-F-08 | Expiry of bonus credits (policy) with notice; paid credits do not expire unless law/policy permits. | Should |

## 4. Key workflows

Top-up RM 500 by card → invoice `WALLET_TOPUP` → PAY card → wallet +50 000 (+2 500 bonus) · Visit RM 86 → pay from wallet → wallet −8 600; receipt shows method WALLET and remaining balance · Refund remaining RM 120 paid credit by transfer → refund document.

## 5. Data model

```
wallet            id, tenant_id, owner_patient_id unique, status enum(ACTIVE, FROZEN, CLOSED), balance_paid bigint, balance_bonus bigint, created_at
wallet_ledger     id, wallet_id, type enum(TOPUP, BONUS, SPEND, REFUND, ADJUST, EXPIRE, REVERSAL), amount bigint (signed), bucket enum(PAID, BONUS),
                  balance_paid_after, balance_bonus_after, invoice_id, payment_id, refund_document_id, reason, by, at
                  INDEX (wallet_id, at)
wallet_authorised_user   id, wallet_id, patient_id, limit_per_visit bigint, active
```

PAY: method `WALLET` added; `payment.wallet_ledger_id`.

## 6. State machines

Wallet: `ACTIVE ⇄ FROZEN → CLOSED` (balance zero).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| WLT-R-01 | Balances = Σ ledger per bucket; `*_after` on every row; never negative. | Service + trigger |
| WLT-R-02 | Spend consumes BONUS first, then PAID (configurable), recorded per row. | Service |
| WLT-R-03 | Wallet debit occurs inside PAY's payment transaction; voiding the payment reverses it. | Service |
| WLT-R-04 | Top-ups always produce a PAY payment and a receipt (money entered the till). | Service |
| WLT-R-05 | Refunds only from PAID bucket; require ADMIN + reauth; produce a FIN refund document. | Service |
| WLT-R-06 | No conversion between wallet, loyalty points and membership entitlements. | Boundary |

## 8. API surface

`/patients/:id/wallet` (balance, ledger, statement) · `POST /patients/:id/wallet/topup` (creates invoice + returns payment step) · PAY method `WALLET` on `/invoices/:id/payments` · `POST /wallets/:id/refund` · `POST /wallets/:id/adjust` · `/wallets/:id/authorised-users` · `/reports/wallet/liability`.

## 9. Domain events

**Emits:** `wallet.topped_up`, `wallet.spent`, `wallet.refunded`, `wallet.low_balance`, `wallet.bonus_expiring`
**Consumes:** `payment.received` (WALLET_TOPUP invoices), `payment.voided`

## 10. Audit events

Top-ups, spends (light), refunds and adjustments with reason, authorised-user changes.

## 11. Screens & UX requirements

Header chip (balance) · Wallet tab (ledger, statement, top-up button, refund for ADMIN) · Top-up dialog with bonus preview · PAY method button "Wallet (RM 412.00)" with partial amount · Liability report.

## 12. Validation

Top-up ≥ tenant minimum; spend ≤ balance; refund ≤ paid balance; reason for adjustments.

## 13. Non-functional requirements

Spend ≤ 20 ms in transaction · statements ≤ 1 s · nightly balance assertion.

## 14. Edge cases & failure modes

Top-up payment voided same day (wallet reversal; if already spent → negative prevented → ADMIN resolves) · patient deceased with balance (refund to estate per policy) · family user exceeds limit (blocked) · bonus expiry with partial spend (FIFO within bucket).

## 15. Compliance

Prepaid balances may fall under payment-instrument or consumer-protection rules — **obtain advice**; balances are a liability (FIN); refund policy published; e-Invoice treatment of top-ups (advance payment) confirmed with accountant.

## 16. Reporting outputs

Liability (paid/bonus); top-ups and spends per period; breakage (expired bonus); active wallets.

## 17. Acceptance tests (representative)

WLT-T-01 top-up creates invoice+payment+ledger consistently · T-02 spend debits in PAY tx; void reverses · T-03 bonus consumed before paid · T-04 refund limited to paid bucket · T-05 liability = Σ balances.

## 18. Migration & rollout

Import existing prepaid balances (if any) as opening TOPUP with source note; policy and terms published.

## 19. Out of scope

Corporate-funded allowances → PNL/WLT extension V3 · gateway auto top-up → INT.

## 20. Open questions

WLT-Q-01 regulatory position on prepaid balances for a clinic · Q-02 bonus scheme appetite · Q-03 refund policy.

## 21. Definition of done

- [ ] Regulatory question answered and recorded
- [ ] Must requirements implemented; WLT-T-01 … T-05 green
- [ ] Open questions answered
