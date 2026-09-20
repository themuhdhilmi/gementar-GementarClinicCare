# Packages (PKG)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 19 |
| **Depends on** | BIL, PAY, PRC, INV, MEM, PAT, AUD |
| **Depended on by** | PPT |
| **Est. effort** | ~40 h |

---

## 1. Purpose & business value

Prepaid bundles: health screening, vaccination courses, chronic-care programmes, treatment series (e.g. 6 dressings). Sold once, consumed over visits, tracked to the session, with clear expiry and refund rules. Distinct from membership (entitlements over a term) — a package is a fixed set of items.

## 2. Actors & permissions

| Action | ADMIN | FRONTDESK | DOCTOR/NURSE |
|---|:-:|:-:|:-:|
| `package.sell` | ✓ | ✓ | – |
| `package.consume` — apply a session at billing/perform | ✓ | ✓ | ✓ (perform) |
| `package.manage` — define, adjust, refund | ✓ | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| PKG-F-01 | Package definition: code, name, category, price, components (procedure / consultation / product / billable item × quantity), validity (months from purchase or fixed dates), transferable flag, refund policy (pro-rata by unused list value / none), branch scope, status, versions. | Must |
| PKG-F-02 | Sell: to a patient (or family group); invoice line `PACKAGE`; paid via PAY; package instance created with component balances. | Must |
| PKG-F-03 | Consume: at billing, eligible lines matched to package components → line priced 0 with `discount_source = PACKAGE` and a consumption row; at PRC perform, the procedure can be marked "from package". Partial packages show remaining. | Must |
| PKG-F-04 | Expiry with reminders (NTF); extension by ADMIN with reason. | Must |
| PKG-F-05 | Refund/cancel per policy (FIN credit note/refund); transfer to another patient if allowed. | Should |
| PKG-F-06 | Revenue recognition helper: deferred revenue (unconsumed value) report for the accountant. | Should |
| PKG-F-07 | Screening packages: checklist of components with results attachments (LAB later); completion status. | Could |

## 4. Key workflows

Sell "Basic Screening" RM 180 (consult + 3 tests + ECG) → paid → next visit: consult and ECG consumed from package → remaining tests shown · Vaccination course 3 doses → each dose PRC perform "from package" → last dose completes package.

## 5. Data model

```
package_def            id, tenant_id, code, name, category, price bigint, validity_months, valid_from, valid_to, transferable, refund_policy jsonb, branch_scope jsonb, status
package_def_version    id, package_def_id, version, components jsonb [{type, ref_id, qty, list_price}], effective_from
package_instance       id, tenant_id, patient_id, def_version_id, invoice_id, purchased_at, expires_at, status enum(PENDING_PAYMENT, ACTIVE, COMPLETED, EXPIRED, CANCELLED, REFUNDED), extended_by, extension_reason
package_component_balance   id, instance_id, component_key, qty_total, qty_used
package_consumption    id, instance_id, component_key, encounter_id, invoice_line_id, encounter_procedure_id, qty, at, by, reversed_at
```

## 6. State machines

Instance: `PENDING_PAYMENT → ACTIVE → COMPLETED | EXPIRED | CANCELLED | REFUNDED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PKG-R-01 | `qty_used ≤ qty_total` per component; consumption rows are the truth. | Service + trigger |
| PKG-R-02 | Consumption written in BIL's/PRC's transaction; invoice void or procedure void reverses it. | Service |
| PKG-R-03 | Expired instances cannot be consumed; extension is explicit and audited. | Service |
| PKG-R-04 | Refund value computed from policy and unused list value, never from proportion of sessions alone unless policy says so. | Service |
| PKG-R-05 | Package revenue is recognised on consumption for management reporting (FIN deferred revenue). | FIN view |

## 8. API surface

`/packages` CRUD + versions · `POST /patients/:id/packages` (sell → invoice) · `GET /patients/:id/packages` · `POST /package-instances/:id/consume` (internal from BIL/PRC) · `POST /package-instances/:id/extend|cancel|refund|transfer` · `/reports/packages/deferred-revenue`.

## 9. Domain events

**Emits:** `package.sold`, `package.activated`, `package.consumed`, `package.completed`, `package.expiring`, `package.expired`, `package.refunded`
**Consumes:** `payment.received`, `invoice.voided`, `procedure.voided`, scheduler

## 10. Audit events

Definition changes; sales; extensions/refunds/transfers with reason; consumption reversals.

## 11. Screens & UX requirements

Header chip (active packages, remaining) · Packages tab per patient (components with progress bars, expiry) · Sell dialog · Billing: auto-matched lines show "from package" with toggle off · PRC perform: "use package" option · Definitions admin with component builder · Deferred revenue report.

## 12. Validation

Components qty > 0; validity > 0; refund policy well-formed; consumption qty ≤ remaining.

## 13. Non-functional requirements

Matching at billing ≤ 30 ms · expiry job nightly.

## 14. Edge cases & failure modes

Component product substituted at dispense (match by generic per policy) · price change of definition (versioned; instances keep theirs) · patient transfers mid-way (remaining balances move; audited) · package spanning branches (scope) · combined with membership discount (package lines are already 0; no stacking).

## 15. Compliance

Advance payments (deferred revenue, e-Invoice treatment) — confirm with accountant; refund policy disclosure at sale.

## 16. Reporting outputs

Packages sold/active/completed/expired; utilisation; deferred revenue; breakage (expired unused value).

## 17. Acceptance tests (representative)

PKG-T-01 sell → invoice → pay → ACTIVE with balances · T-02 consume at billing → line 0 with source PACKAGE; void → reversal · T-03 expired → cannot consume; extend → can · T-04 last component consumed → COMPLETED · T-05 deferred revenue = Σ unused list value.

## 18. Migration & rollout

Import outstanding packages (remaining sessions) as opening instances; definitions built with the owner.

## 19. Out of scope

Subscription-style rolling packages → MEM · online purchase → PPT.

## 20. Open questions

PKG-Q-01 packages sold today and their terms · Q-02 refund policy · Q-03 outstanding packages to migrate.

## 21. Definition of done

- [ ] Must requirements implemented; PKG-T-01 … T-05 green
- [ ] Definitions loaded; outstanding packages migrated
- [ ] Open questions answered
