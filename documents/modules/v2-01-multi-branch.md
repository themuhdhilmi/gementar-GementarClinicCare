# Multi-Branch Operations (BRN)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 26 |
| **Depends on** | TEN, INV, PUR, FIN, RPT, RBC, HR |
| **Depended on by** | ANL |
| **Est. effort** | ~70 h |

---

## 1. Purpose & business value

The schema has been branch-aware since V0; this module adds the *features* a chain needs once a second branch exists: stock transfer, branch-specific pricing, central purchasing, HQ consolidated reporting, and cross-branch staff scheduling. Selling to chains is where the SaaS revenue is.

## 2. Actors & permissions

| Action | ORG_ADMIN / HQ | BRANCH_MANAGER | Others |
|---|:-:|:-:|:-:|
| `branch.transfer` — request/approve/ship/receive transfers | ✓ | ✓ (own branch) | NURSE/FRONTDESK ship/receive |
| `branch.pricing` — branch price overrides | ✓ | – | – |
| `purchasing.central` — HQ POs allocated to branches | ✓ | – | – |
| `report.consolidated` | ✓ | – | – |
| Cross-branch patient search (already tenant-wide) | ✓ | ✓ | ✓ |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| BRN-F-01 | **Stock transfer**: request (from branch, to branch, lines with product/qty; or HQ push), approve, pick (batch selection FEFO at source), ship (`TRANSFER_OUT` movements; goods in transit ledger), receive (`TRANSFER_IN` with per-line confirm/discrepancy), close; transfer note document; discrepancies create adjustments with reason at the receiving side and an alert. | Must |
| BRN-F-02 | In-transit stock is visible (neither branch's on-hand) and ages; overdue receipts alert. | Must |
| BRN-F-03 | **Branch pricing**: product/procedure/fee overrides per branch with effective dates; BIL/DSP/PRC resolve price as `branch override ⊕ tenant price`; audit of overrides. | Must |
| BRN-F-04 | **Central purchasing**: HQ PO with allocation lines per branch; GRN at HQ warehouse (a branch of type `WAREHOUSE`) then transfers, or direct-ship GRNs per branch against the central PO. | Must |
| BRN-F-05 | Branch types: `CLINIC`, `WAREHOUSE`, `HQ` (no patients); operating hours and doctor schedules per branch (APT/HR). | Must |
| BRN-F-06 | **HQ consolidated reporting**: every RPT/FIN report with branch as a dimension and "all branches" totals; branch comparison views; consolidated period close (FIN) after all branch sessions closed. | Must |
| BRN-F-07 | Cross-branch views: patient visit history across branches (already), stock availability across branches ("available at KL02") shown in DSP when out of stock locally. | Must |
| BRN-F-08 | Staff working across branches: assignment scope (RBC) + roster (HR); branch switcher UX (IAM) hardened for frequent switching. | Should |
| BRN-F-09 | SSE fan-out across multiple API processes via Postgres `LISTEN/NOTIFY` (or Redis pub/sub) — the client contract is unchanged. | Must (when a second process exists) |
| BRN-F-10 | Branch onboarding checklist (letterhead, printers, rooms, staff, opening stock) reusing ADM wizard steps. | Should |

## 4. Key workflows

KL02 low on amoxicillin → request 200 from KL01 → KL01 manager approves → picker ships batch B7 ×200 (in transit) → KL02 receives 198, 2 damaged → discrepancy adjustment + alert → closed · HQ buys 5 000 masks → allocated 2 000/2 000/1 000 → direct-ship GRNs per branch · Owner: consolidated dashboard → branch comparison → KL02 margin lower → drill to pricing.

## 5. Data model

```
branch (additions)     type enum(CLINIC, WAREHOUSE, HQ), region, manager_user_id
stock_transfer         id, tenant_id, from_branch_id, to_branch_id, transfer_no, status enum(REQUESTED, APPROVED, PICKING, SHIPPED, PARTIALLY_RECEIVED, RECEIVED, CLOSED, CANCELLED), requested_by, approved_by, shipped_at, received_at, notes
stock_transfer_line    id, transfer_id, product_id, qty_requested, qty_shipped, qty_received, qty_discrepancy, discrepancy_reason
stock_transfer_batch   id, transfer_line_id, batch_id (source), qty, out_movement_id, in_batch_id (destination batch created/extended), in_movement_id
in_transit             view: shipped − received per transfer/batch
branch_price_override  id, tenant_id, branch_id, target_type enum(PRODUCT, PROCEDURE, BILLABLE_ITEM, FEE_RULE), target_id, price bigint, effective_from, effective_to, set_by, reason
purchase_order (add)   is_central bool, allocation jsonb [{branch_id, qty}] per line
sse_bus                LISTEN/NOTIFY channel per tenant/branch (infrastructure, not a table)
```

## 6. State machines

Transfer as in BRN-F-01. Override: effective-dated rows; no status.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| BRN-R-01 | Transfer movements go through INV `move()`; `TRANSFER_OUT` at ship and `TRANSFER_IN` at receive are separate transactions linked by transfer id; in-transit is the difference. | Service |
| BRN-R-02 | Destination batch preserves source batch no, expiry and cost. | Service |
| BRN-R-03 | Discrepancies never silently adjust; they create explicit adjustments with reason and alert HQ. | Service |
| BRN-R-04 | Price resolution is deterministic: branch override in effect → else tenant price; the resolved source is recorded on the invoice line (`fee_rule`/`price_source`). | BIL/DSP/PRC |
| BRN-R-05 | Consolidated close requires all branches' cash sessions closed for the period. | FIN |
| BRN-R-06 | Multi-process SSE preserves "invalidation signal" semantics; no state in the bus. | Design |

## 8. API surface

`/stock-transfers` CRUD + `/approve|pick|ship|receive|close|cancel` · `GET /branches/:b/in-transit` · `/branch-price-overrides` CRUD · central PO flags on `/purchase-orders` · `GET /reports/consolidated/*` · `GET /products/:id/availability` (all branches) · branch type on `/branches`.

## 9. Domain events

**Emits:** `transfer.requested/approved/shipped/received/discrepancy/closed`, `branch_price.changed`, `central_po.allocated`
**Consumes:** `stock.low` (suggest transfer before purchase), `goods.received`

## 10. Audit events

All §9; price overrides with reason; discrepancy adjustments.

## 11. Screens & UX requirements

Transfer workbench (kanban by status; per-branch inbox/outbox) · Pick/ship screen with batch selection and printable transfer note · Receive screen with per-line confirm and discrepancy capture · Availability across branches (in DSP out-of-stock panel and product page) · Branch pricing editor with diff vs tenant price · HQ dashboard with branch comparison and drill-down.

## 12. Validation

From ≠ to; qty > 0; ship qty ≤ on-hand; receive qty ≤ shipped; discrepancy reason required; override price ≥ 0 with dates.

## 13. Non-functional requirements

Transfer receive of 50 lines ≤ 3 s · consolidated dashboard for 10 branches ≤ 1 s · SSE fan-out latency ≤ 1 s across processes.

## 14. Edge cases & failure modes

Transfer shipped but never received (ageing alert; HQ resolves: receive with discrepancy or cancel with write-off) · same batch no at destination with different cost (suffix rule as INV) · branch closed permanently (transfer all stock out; deactivate) · overrides overlapping dates (rejected) · warehouse-only tenant (no clinic features needed; module flags).

## 15. Compliance

Transfer notes support stock traceability across sites (controlled drugs: register entries at both ends via DSP `TRANSFER` entry types); consolidated financials for group reporting.

## 16. Reporting outputs

Transfers by status/age; discrepancy rate by branch; branch comparison (patients, revenue, margin, wait times); stock position across branches; central purchasing savings.

## 17. Acceptance tests (representative)

BRN-T-01 ship → source on-hand down, in-transit up; receive → destination up, in-transit zero · T-02 receive with discrepancy → adjustment + alert · T-03 branch override applies at that branch only and is recorded on the line · T-04 central PO allocation sums to PO qty · T-05 consolidated close blocked while a branch session is open · T-06 SSE event emitted on process A received by client on process B.

## 18. Migration & rollout

Second branch onboarded via checklist; opening stock count at the new branch; overrides defined; first month of transfers with weekly reconciliation.

## 19. Out of scope

Franchise/multi-entity legal structures → V3 · inter-company invoicing → V3 · demand forecasting → ANL.

## 20. Open questions

BRN-Q-01 will the pilot group open a second branch, when · Q-02 central warehouse or direct delivery · Q-03 pricing differences between branches today.

## 21. Definition of done

- [ ] Must requirements implemented; BRN-T-01 … T-06 green
- [ ] Second branch live with transfers and consolidated reporting for one month
- [ ] Open questions answered
