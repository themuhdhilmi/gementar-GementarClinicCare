# Reporting & Dashboard (RPT)

| | |
|---|---|
| **Version** | V0 |
| **Status** | Not started |
| **Delivery phase** | Phase 4 |
| **Spec sections** | 32, 33 |
| **Depends on** | Every V0 module (read-only) |
| **Depended on by** | ANL (V2 extends), FIN (V1 extends) |
| **Est. effort** | ~20 h |

---

## 1. Purpose & business value

The numbers the clinic owner checks before going home, and the operational view each station needs during the day. V0 reporting is deliberately narrow — daily patients, daily sales, cash reconciliation, stock alerts — and deliberately exact: a report that disagrees with the receipts by one sen is worse than no report, because it teaches the owner not to trust any of it.

Reporting reads; it never writes.

## 2. Actors & permissions

| Report | ADMIN | DOCTOR | NURSE | FRONTDESK |
|---|:-:|:-:|:-:|:-:|
| `report.operational` — patients, queue, waits, stock alerts | ✓ | ✓ | ✓ | ✓ |
| `report.financial` — sales, collections, discounts, voids, outstanding | ✓ | – | – | – |
| Own-doctor stats (own consultations, own diagnoses) | – | ✓ | – | – |
| Export (CSV/PDF) | ✓ | own | – | – |

## 3. Functional requirements

### Dashboard (today, per branch)
| ID | Requirement | Priority |
|---|---|---|
| RPT-F-01 | Tiles: patients today (registered / completed / in progress), current queue by station, average wait to doctor today, revenue today (issued invoices; ADMIN only), collections today by method (ADMIN), outstanding balances (ADMIN), low/critical stock count, expiring ≤ 30 d count, unsigned drafts > 24 h, open cash session status. Each tile links to its detail. | Must |
| RPT-F-02 | Refreshes on SSE events (ENC, PAY, INV) with a 5-second coalescing window; never more than one refresh per 5 s. | Must |
| RPT-F-03 | Branch selector for users with multiple branches; ADMIN "all branches" summary row (V2 BRN deepens). | Should |

### Operational reports
| ID | Requirement | Priority |
|---|---|---|
| RPT-F-04 | **Daily patient register**: date range; per encounter: time, queue no, patient (name, MRN), type, doctor, status, consultation duration, total billed; totals; CSV. | Must |
| RPT-F-05 | **Patients by hour / day / doctor**; new vs returning (first encounter ever = new). | Must |
| RPT-F-06 | **Queue performance**: per day and station — count, mean/median/p90 wait, longest; from `encounter_event`. | Should |
| RPT-F-07 | **No-show / cancellation** counts and rates. | Should |
| RPT-F-08 | **Diagnoses**: top N by ICD code / description for a period (clinical.read for detail; counts for ADMIN). | Should |
| RPT-F-09 | **Prescribing**: top generics, antibiotics rate, per doctor (DOCTOR sees own; ADMIN all). | Should |
| RPT-F-10 | **Stock**: on-hand valuation at cost, low/critical list, expiring/expired list, movement summary by type (units and cost), shrinkage. | Must |
| RPT-F-11 | **MCs issued** per doctor per period, days certified. | Should |

### Financial reports (ADMIN)
| ID | Requirement | Priority |
|---|---|---|
| RPT-F-12 | **Daily sales**: issued invoices by day — count, subtotal, discounts, tax, rounding, grand total; by line type (consultation / medicine / procedure / document / item); by doctor; CSV/PDF. | Must |
| RPT-F-13 | **Collections**: payments by day, method, cashier, session; voids and refunds; matches Z-reports exactly. | Must |
| RPT-F-14 | **End-of-day pack**: one PDF per branch per day — Z-report(s), daily sales, discounts list, voids list, outstanding added today, stock alerts; generated at close or on demand; emailable in V1. | Must |
| RPT-F-15 | **Discounts**: every discount with invoice, line, source, reason, actor, value; totals by source and actor. | Must |
| RPT-F-16 | **Voids & refunds**: with reasons and actors. | Must |
| RPT-F-17 | **Outstanding balances**: ageing buckets (0–7, 8–30, 31–60, 60+); by patient. | Must |
| RPT-F-18 | **Sales vs collections reconciliation**: for a period, issued totals vs collected vs outstanding delta vs voided — must sum exactly. | Must |

### General
| ID | Requirement | Priority |
|---|---|---|
| RPT-F-19 | All reports filter by branch and date range (branch timezone); ranges ≤ 366 days; results paginated for detail rows; aggregates exact. | Must |
| RPT-F-20 | Export CSV (UTF-8 BOM for Excel) and PDF (A4 landscape) for every report; exports audited. | Must |
| RPT-F-21 | Report definitions live in code as typed SQL (not an ad-hoc query builder); each has a test asserting it reconciles with the source tables on a seeded dataset. | Must |
| RPT-F-22 | Saved filters per user (branch, range presets: today, yesterday, this week, this month, last month). | Could |

## 4. Key workflows

**Owner's evening**
1. Dashboard → collections RM 4 320.55 (cash 2 100.00, card 1 420.55, QR 800.00) → matches Z-report → EOD pack PDF → done

**Stock morning check**
1. Dashboard → 6 low, 2 critical, 3 expiring → stock report → export → order (V1 PUR)

**Doctor's weekly**
1. My stats → 214 patients, median consult 6 m 40 s, top diagnoses, antibiotic rate 31%

## 5. Data model

No owned transactional tables. Read models:

```
-- Views (or materialised nightly where noted), all tenant/branch-scoped via RLS on base tables
v_daily_encounters          per branch/day: registered, completed, cancelled, no_show, new_patients, returning
v_queue_waits               per encounter: t_register, t_triage, t_doctor_called, t_consult_start/end, t_dispensed, t_paid, t_completed (from encounter_event)
v_daily_sales               per branch/day: invoices, subtotal, discount, tax, rounding, grand_total, by line_type (jsonb)
v_daily_collections         per branch/day/method/session/cashier: amount, voids, refunds
v_outstanding               per invoice with balance > 0: patient, issued_at, age_days, bucket
v_stock_valuation           per branch/product: on_hand, cost_value (Σ batch qty × cost)
v_stock_alerts              from stock_alert_state
mv_diagnosis_counts         materialised nightly: branch, period, code/description, count
mv_prescribing_counts       materialised nightly: branch, period, doctor, generic, count, is_antibiotic

report_export
  id uuid pk, tenant_id, branch_id, report_key text, params jsonb, format text, storage_key text, run_by uuid, run_at timestamptz, row_count int
```

Dashboard tiles are computed by lightweight queries against indexed base tables (all indexes already specified in the owning modules); no denormalised counters that can drift.

## 6. State machines

None.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| RPT-R-01 | Reporting has no write path to any transactional table; the reporting DB role (or module) has SELECT only on base tables. | Module boundary + (V2) separate DB role |
| RPT-R-02 | Every financial figure is a sum of stored `bigint` sen values; no recomputation from percentages or prices. | SQL review + reconciliation tests |
| RPT-R-03 | Daily sales for a day = Σ `grand_total` of invoices with `issued_at` in that branch-local day and status ≠ VOID; voided invoices reported separately. | View definition |
| RPT-R-04 | Collections for a session = Σ posted payments − voids − refunds in that session = Z-report totals. | Test against PAY |
| RPT-R-05 | Dates are bucketed in the branch timezone. | View definition |
| RPT-R-06 | Materialised views refresh nightly and show "as of" timestamp; live views are used for anything money-related. | Job |
| RPT-R-07 | Detail reports containing clinical data require `clinical.read`; financial require `report.financial`. | Controller |

## 8. API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/branches/:b/dashboard` | `report.operational` (financial tiles gated) | |
| GET | `/branches/:b/dashboard/stream` | same | SSE coalesced |
| GET | `/branches/:b/reports/patient-register?from&to` | `report.operational` | |
| GET | `/branches/:b/reports/patients-summary?from&to&groupBy=hour|day|doctor` | `report.operational` | |
| GET | `/branches/:b/reports/queue-performance?from&to` | `report.operational` | |
| GET | `/branches/:b/reports/diagnoses?from&to&top=` | `clinical.read` / ADMIN counts | |
| GET | `/branches/:b/reports/prescribing?from&to&doctorId=` | DOCTOR own / ADMIN | |
| GET | `/branches/:b/reports/stock/valuation` · `/alerts` · `/movements?from&to` | `stock.read` | |
| GET | `/branches/:b/reports/mc?from&to` | ADMIN / own | |
| GET | `/branches/:b/reports/daily-sales?from&to&by=lineType|doctor` | `report.financial` | |
| GET | `/branches/:b/reports/collections?from&to&by=method|cashier|session` | `report.financial` | |
| GET | `/branches/:b/reports/discounts?from&to` · `/voids?from&to` · `/outstanding` · `/reconciliation?from&to` | `report.financial` | |
| POST | `/branches/:b/reports/eod-pack?date=` | `report.financial` | Generates PDF |
| POST | `/reports/:key/export` | per report | CSV/PDF; audited |
| GET | `/me/stats?from&to` | DOCTOR | Own |

## 9. Domain events

**Emits:** `report.exported`, `eod_pack.generated`
**Consumes:** `encounter.*`, `payment.*`, `invoice.*`, `stock.low/expiring` (dashboard invalidation only)

## 10. Audit events

`report.exported` (report key, params, actor), `eod_pack.generated`, financial report views by non-ADMIN (should never happen; would indicate a permission bug).

## 11. Screens & UX requirements

| Screen | Requirements |
|---|---|
| Dashboard | Tile grid; financial tiles hidden (not just disabled) without permission; each tile shows value, delta vs yesterday, sparkline (7 d); click → report with today preset |
| Report page (shared shell) | Filters bar (branch, range presets, group-by); summary strip; table with sticky header, sortable, paginated; export buttons; "as of" for materialised data |
| EOD pack | Preview then download/print; list of past packs |
| My stats (doctor) | Cards + simple charts (patients/day, consult time, top diagnoses) |

Charts follow the `dataviz` skill palette when built; keep to bar/line, no pie.

## 12. Validation

- Date range required, ≤ 366 days; `to ≥ from`
- `top` 1–100
- Export row cap 100 000 (paginate beyond)

## 13. Non-functional requirements

| ID | Requirement |
|---|---|
| RPT-N-01 | Dashboard ≤ 300 ms p95 at 300 encounters/day, 12 months of data. |
| RPT-N-02 | Daily sales for 31 days ≤ 500 ms; patient register 31 days ≤ 800 ms. |
| RPT-N-03 | Reconciliation test suite: seeded dataset with known totals; every financial report asserts exact equality. |
| RPT-N-04 | Materialised views refresh ≤ 5 min nightly. |
| RPT-N-05 | Exports of 100 k rows stream without loading into memory. |

## 14. Edge cases & failure modes

| Case | Decision |
|---|---|
| Invoice issued 23:59, paid 00:01 | Sales on day 1, collection on day 2; reconciliation shows the outstanding delta — correct by definition. |
| Session spans midnight | Collections attributed to the session's open date; Z-report is per session; daily view groups by session open date with a note. |
| Voided invoice previously counted | Sales view excludes VOID; voids report lists it; reconciliation adds it back so periods tie. |
| Reissued invoice | Only the new invoice counts in sales; the voided original appears in voids. |
| Timezone change (branch moved) | Historical buckets use the timezone at query time; documented limitation. |
| Diagnosis free-text variants | Grouped by lowercased trimmed description; ICD mapping in V1 improves it. |
| Deleted/merged patients | Counts unaffected; register shows survivor name. |

## 15. Compliance

- Financial reports are the accountant's inputs; exactness and audit of exports matter.
- Clinical aggregates (diagnoses, prescribing) avoid patient-level detail for non-clinical roles.
- Exports containing patient data are audited (PDPA).

## 16. Reporting outputs

This module *is* the outputs. Cross-module figures come from the owning module's §16.

## 17. Acceptance tests

| ID | Given / When / Then |
|---|---|
| RPT-T-01 | Given the seeded day (12 invoices, 2 voided, payments in 3 methods, 1 void), then daily sales, collections, voids and reconciliation each equal the hand-computed totals to the sen. |
| RPT-T-02 | Given a session's payments, then the collections report for that session equals its Z-report `totals_by_method`. |
| RPT-T-03 | Given FRONTDESK, when requesting `/reports/daily-sales`, then 403 and the dashboard omits financial tiles. |
| RPT-T-04 | Given encounters with events, then queue-performance median wait equals the hand-computed value. |
| RPT-T-05 | Given a patient's first-ever encounter today, then they count as "new" today and "returning" tomorrow. |
| RPT-T-06 | Given 12 months of seeded data, then the dashboard responds ≤ 300 ms p95. |
| RPT-T-07 | Given an export, then an audit entry records the report and parameters. |

## 18. Migration & rollout

- R4 with BIL/PAY; dashboard operational tiles ship earlier (R1 for patients/queue, R3 for stock)
- EOD pack format reviewed with the owner and their accountant
- No historical data; reports start from go-live (legacy summaries stay in the old system)

## 19. Out of scope

- Profitability, COGS, P&L, receivables/payables → V1 `FIN`
- Doctor/branch performance benchmarking, cohort analysis, trends → V2 `ANL`
- Membership, loyalty, panel reports → V1/V2 with those modules
- Scheduled emailed reports → V1 `NTF`
- Custom report builder → V2 `ANL`
- Read replica → V2 when load justifies

## 20. Open questions

| ID | Question | Who |
|---|---|---|
| RPT-Q-01 | What does the owner look at daily today (their current end-of-day routine)? | Pilot clinic owner |
| RPT-Q-02 | Accountant's preferred export format / columns. | Pilot clinic owner |
| RPT-Q-03 | Should doctors see each other's volumes? (Default: no.) | Pilot clinic owner |

## 21. Definition of done

- [ ] All Must requirements implemented
- [ ] RPT-T-01 … T-07 green; reconciliation suite in CI
- [ ] EOD pack reviewed by the owner
- [ ] Dashboard p95 measured and recorded
- [ ] Open questions answered
