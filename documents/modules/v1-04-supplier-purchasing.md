# Supplier & Purchasing (PUR)

| | |
|---|---|
| **Version** | V1 |
| **Status** | Not started |
| **Spec sections** | 10 |
| **Depends on** | INV, TEN, IAM, FIN, AUD |
| **Depended on by** | BRN (central purchasing), FIN (payables) |
| **Est. effort** | ~55 h |

---

## 1. Purpose & business value

How stock gets onto the shelf, properly: suppliers, purchase orders, goods receipt against orders, supplier invoices and payables. V0's manual stock-in works for one clinic; this module makes receiving faster, cost tracking accurate, and reordering data-driven — and it is the base for central purchasing across branches (BRN).

## 2. Actors & permissions

| Action | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `supplier.manage` | ✓ | – | – | – |
| `po.create` — draft POs | ✓ | – | ✓ | ✓ |
| `po.approve` — above threshold | ✓ | – | – | – |
| `grn.receive` — receive goods against PO | ✓ | – | ✓ | ✓ |
| `supplier_invoice.manage` — record, match, mark paid | ✓ | – | – | – |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| PUR-F-01 | Supplier: name, registration/TIN, contacts, address, payment terms, lead time days, currency (MYR), status, product–supplier links with supplier SKU, last price, pack size, min order qty. | Must |
| PUR-F-02 | Purchase order: branch (or HQ in BRN), supplier, lines (product, qty in supplier packs and units, unit cost, expected date), status flow with approval threshold (tenant setting, value in sen), PO number series, PDF/email to supplier (NTF), notes. | Must |
| PUR-F-03 | Reorder suggestions from INV (below reorder level; days of cover) → one-click draft PO per preferred supplier. | Must |
| PUR-F-04 | Goods receipt note (GRN) against a PO: per line received qty, batch no, expiry, unit cost (default from PO, editable with variance flag), damaged qty; partial receipts allowed (PO `PARTIALLY_RECEIVED`); over-receipt requires reason; GRN posts `RECEIVE` movements through INV `move()` in one transaction and creates/extends batches. | Must |
| PUR-F-05 | GRN without PO (ad-hoc delivery) allowed with `grn.receive` and a reason; creates an implicit PO for records. | Should |
| PUR-F-06 | Supplier invoice: supplier, invoice no, date, due date, lines matched to GRN lines (3-way match: PO–GRN–invoice; quantity and price variances flagged with tolerance), taxes, total; status (`RECEIVED`, `MATCHED`, `DISPUTED`, `APPROVED`, `PAID`, `PARTIALLY_PAID`); payment recording (FIN payables). | Must |
| PUR-F-07 | Return to supplier: from quarantine/damaged stock → return note → `RETURN_TO_SUPPLIER` movement → credit note tracking. | Should |
| PUR-F-08 | Price history per product per supplier; price comparison view across suppliers; price change alerts (> x%). | Should |
| PUR-F-09 | Purchase history per product/supplier; outstanding POs; overdue deliveries list. | Must |
| PUR-F-10 | Cost basis: batch `cost_price` from GRN (landed cost incl. proportional freight optional). | Must |

## 4. Key workflows

Reorder list → draft PO (Supplier A: 12 lines) → submit → ADMIN approves (RM 3 400) → emailed → delivery → GRN: scan/enter batches & expiries, 1 line short → PO partially received → supplier invoice entered → 3-way match: 1 price variance RM 2 → approve with note → paid by transfer (FIN) → PAID.

## 5. Data model

```
supplier                 id, tenant_id, code, name, reg_no, tin, contacts jsonb, address, payment_terms_days, lead_time_days, status
supplier_product         id, supplier_id, product_id, supplier_sku, pack_size, pack_unit, last_cost bigint, last_cost_at, moq, preferred bool
purchase_order           id, tenant_id, branch_id, supplier_id, po_no, status enum(DRAFT, PENDING_APPROVAL, APPROVED, SENT, PARTIALLY_RECEIVED, RECEIVED, CANCELLED, CLOSED),
                         expected_at, subtotal, tax, total, notes, created_by, approved_by, approved_at, sent_at, sent_via
purchase_order_line      id, po_id, product_id, qty_packs, pack_size, qty_units, unit_cost bigint, line_total, received_units, expected_at
goods_receipt            id, tenant_id, branch_id, po_id (nullable), supplier_id, grn_no, received_at, received_by, delivery_note_ref, status, notes, freight bigint
goods_receipt_line       id, grn_id, po_line_id, product_id, batch_id, batch_no, expiry, qty_units, damaged_units, unit_cost bigint, cost_variance bigint, stock_movement_id
supplier_invoice         id, tenant_id, supplier_id, invoice_no, invoice_date, due_date, subtotal, tax, total, status, matched_at, disputed_reason, storage_key
supplier_invoice_line    id, supplier_invoice_id, grn_line_id, product_id, qty, unit_cost, line_total, qty_variance, price_variance
supplier_payment         id, tenant_id, supplier_id, amount, paid_at, method, reference, recorded_by       -- FIN payables ledger link
supplier_payment_alloc   id, payment_id, supplier_invoice_id, amount
supplier_return          id, tenant_id, branch_id, supplier_id, return_no, status, lines jsonb, credit_note_ref, credit_amount
po_seq / grn_seq         (tenant_id, branch_id, year) pk, next
```

## 6. State machines

PO as above; supplier invoice `RECEIVED → MATCHED | DISPUTED → APPROVED → PARTIALLY_PAID → PAID`; GRN `POSTED` (immutable) with reversal via INV adjustment + GRN void (ADMIN, same day).

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| PUR-R-01 | Stock enters only via INV `move()` from a GRN line, inside the GRN transaction. | Boundary |
| PUR-R-02 | PO above `purchasing.approval_threshold_sen` cannot be SENT without approval; approver ≠ creator when `purchasing.segregation = true`. | Service |
| PUR-R-03 | GRN unit cost variance > `purchasing.cost_tolerance_pct` requires a reason. | Service |
| PUR-R-04 | 3-way match tolerances (qty ±0, price ±tolerance) computed server-side; out-of-tolerance invoices are `DISPUTED` until resolved. | Service |
| PUR-R-05 | A supplier invoice cannot be PAID beyond its total; allocations ≤ amount. | Service |
| PUR-R-06 | Batch cost = GRN unit cost (+ allocated freight); the batch's cost is immutable after first movement. | INV |

## 8. API surface

`/suppliers` CRUD + `/products` links · `/reorder-suggestions` · `/purchase-orders` CRUD · `POST /purchase-orders/:id/submit|approve|send|cancel|close` · `POST /purchase-orders/:id/receipts` (GRN) · `/goods-receipts` · `/supplier-invoices` CRUD + `/match|approve|dispute` · `/supplier-payments` + `/allocate` · `/supplier-returns` · `/reports/purchasing/*`.

## 9. Domain events

**Emits:** `po.created`, `po.approved`, `po.sent`, `goods.received`, `po.closed`, `supplier_invoice.recorded`, `supplier_invoice.matched`, `supplier_invoice.disputed`, `supplier_invoice.paid`, `supplier.price_changed`
**Consumes:** `stock.low` (suggestions), `stock.moved` (RETURN_TO_SUPPLIER tracking)

## 10. Audit events

PO approvals (with amounts), GRN posts and voids, cost variances with reasons, invoice disputes/approvals, payments.

## 11. Screens & UX requirements

Reorder workbench (grouped by supplier; edit qty; create POs) · PO editor and approval inbox · GRN entry (PO lines prefilled; barcode focus; batch/expiry/qty per line; variance highlights) · Supplier invoice matching grid (three columns PO/GRN/INV; variances coloured) · Payables list with due dates (FIN) · Supplier price comparison.

## 12. Validation

PO qty > 0; costs ≥ 0; GRN expiry ≥ today unless reason; batch no required for batched products; invoice no unique per supplier; due date ≥ invoice date.

## 13. Non-functional requirements

GRN of 40 lines posts ≤ 2 s; reorder suggestions ≤ 500 ms; PO PDF ≤ 1.5 s.

## 14. Edge cases & failure modes

Supplier delivers substitute product → GRN line with different product flagged, PO line unfulfilled · free-of-charge bonus units → cost 0 line, flagged · GRN posted against wrong PO → void same day, re-post · supplier invoice before goods → RECEIVED, unmatched until GRN · partial deliveries across months → PO stays open; ageing shown · price in packs vs units → both stored; unit cost derived.

## 15. Compliance

Supplier TINs needed for e-Invoice self-billing scenarios (rare) and for the accountant; payables audit trail; controlled-drug receipts feed the DSP register (`RECEIVE` entries).

## 16. Reporting outputs

Purchases by supplier/period; outstanding POs; overdue deliveries; payables ageing; price trends; GRN variances; supplier performance (lead time, fill rate).

## 17. Acceptance tests (representative)

PUR-T-01 GRN posts RECEIVE movements and batches in one transaction (failure after first line → nothing posted) · T-02 PO over threshold cannot be sent unapproved · T-03 partial GRN → PO PARTIALLY_RECEIVED; second GRN completes it · T-04 3-way match with price variance beyond tolerance → DISPUTED · T-05 payment allocation cannot exceed invoice total · T-06 reorder suggestion appears when on-hand ≤ reorder level.

## 18. Migration & rollout

Supplier list and product links imported; open POs from the old process entered; first month parallel with the paper delivery book.

## 19. Out of scope

Central purchasing / inter-branch allocation → V2 `BRN` · supplier portal / EDI → V3 `INT` · landed-cost with customs → V2.

## 20. Open questions

PUR-Q-01 supplier list and typical order frequency · Q-02 who approves purchases today · Q-03 do suppliers provide delivery notes with batch/expiry · Q-04 payment terms and how payables are tracked now.

## 21. Definition of done

- [ ] Must requirements implemented; PUR-T-01 … T-06 green
- [ ] Suppliers and product links loaded; one full PO→GRN→invoice→payment cycle run live
- [ ] Open questions answered
