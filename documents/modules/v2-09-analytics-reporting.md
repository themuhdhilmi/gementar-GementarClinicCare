# Advanced Analytics (ANL)

| | |
|---|---|
| **Version** | V2 |
| **Status** | Not started |
| **Spec sections** | 32 |
| **Depends on** | RPT, FIN, every module's read models |
| **Depended on by** | — |
| **Est. effort** | ~50 h |

---

## 1. Purpose & business value

The reporting that sells to chains and keeps owners engaged: trends, cohorts, comparisons, forecasts — on a read replica or warehouse so analytics never competes with the live queue board. RPT stays exact and operational; ANL is exploratory and explanatory.

## 2. Actors & permissions

| Action | ORG_ADMIN | BRANCH_MANAGER | FINANCE | DOCTOR |
|---|:-:|:-:|:-:|:-:|
| `analytics.view` (all) | ✓ | branch scope | financial + ops | own clinical |
| `analytics.build` — custom reports | ✓ | – | ✓ | – |
| Scheduled reports (NTF) | ✓ | ✓ | ✓ | own |

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| ANL-F-01 | Read replica (Postgres streaming) or nightly warehouse (star schema: dim_date, dim_branch, dim_doctor, dim_patient (pseudonymised), dim_product, fact_encounter, fact_invoice_line, fact_payment, fact_stock_movement, fact_appointment, fact_membership); refresh cadence per fact; "as of" shown. | Must |
| ANL-F-02 | Dashboards: executive (multi-branch KPIs, trends 13 months), operations (wait times by hour/day, capacity utilisation, no-shows), clinical (diagnosis mix, prescribing indicators, MC patterns, follow-up compliance), financial (revenue/margin trends, payer mix, discounts, AR), inventory (turnover, days of cover, expiry losses, forecast reorder), membership/loyalty (acquisition, renewal, churn, benefit value), staff (productivity, commission). | Must |
| ANL-F-03 | Cohorts: new patients by month → retention curves; membership cohorts; chronic-condition cohorts (visits, control indicators where data exists). | Should |
| ANL-F-04 | Comparisons: branch vs branch; doctor vs peer average (anonymised per policy); period vs period. | Must |
| ANL-F-05 | Custom report builder: pick fact, dimensions, measures, filters; save; share by role; export; scheduled email (NTF). | Should |
| ANL-F-06 | Simple forecasting: patient volume by weekday/hour (for rostering), stock demand (for reorder), revenue run-rate. | Could |
| ANL-F-07 | Data quality dashboard: allergies not recorded %, unsigned drafts, unmatched results, reconciliation mismatches, missing generic names. | Must |
| ANL-F-08 | Benchmarks across tenants (opt-in, anonymised, aggregated with k-anonymity ≥ 10) — platform feature. | Could |

## 4. Key workflows

Owner: executive dashboard → KL02 wait times up 20% → operations drill → Tuesdays 10–12 → roster adjustment (HR) · Finance: margin trend → medicine margin falling → product-level → pricing review (INV/BRN).

## 5. Data model

Warehouse schema as in ANL-F-01 (separate database or schema `analytics`), ETL jobs (NTF queue), `saved_report`, `report_schedule`, `benchmark_optin`. Patient dimension pseudonymised (hash + salt per tenant); no free-text clinical notes in the warehouse.

## 6. State machines

ETL run: `SCHEDULED → RUNNING → SUCCEEDED | FAILED`.

## 7. Business rules & invariants

| ID | Rule | Enforced in |
|---|---|---|
| ANL-R-01 | Analytics queries never run against the primary write database. | Connection config |
| ANL-R-02 | Money measures reconcile to RPT/FIN for closed periods (nightly assertion). | ETL test |
| ANL-R-03 | Warehouse rows carry `tenant_id`; RLS enforced there too. | Schema |
| ANL-R-04 | Doctor comparisons anonymised unless tenant policy allows named comparisons. | Service |
| ANL-R-05 | Benchmarks aggregated with minimum group sizes; no tenant identifiable. | Platform job |

## 8. API surface

`/analytics/dashboards/:key?filters` · `/analytics/query` (builder, validated against a metadata model) · `/analytics/saved-reports` CRUD + `/schedule` · `/analytics/data-quality` · `/analytics/etl/status` (admin).

## 9. Domain events

**Emits:** `etl.completed`, `etl.failed`, `report.scheduled_sent`
**Consumes:** none directly (ETL reads tables)

## 10. Audit events

Saved report sharing; exports; benchmark opt-in changes.

## 11. Screens & UX requirements

Dashboard shells with filters (branch, period, compare) · Chart library per `dataviz` skill · Drill-down to RPT operational lists · Builder with preview · Data-quality page with links to fix screens.

## 12. Validation

Builder queries limited to metadata model; row/time limits; exports capped.

## 13. Non-functional requirements

Dashboard ≤ 2 s on 3 years of data for a 10-branch tenant · ETL nightly ≤ 30 min · replica lag alert > 5 min.

## 14. Edge cases & failure modes

ETL failure (dashboards show stale "as of"; alert) · reopened FIN period (re-ETL) · tenant timezone in date dim · pseudonymisation salt rotation (re-ETL).

## 15. Compliance

No PHI free text in warehouse; pseudonymised patient dimension; access by role; benchmark anonymity.

## 16. Reporting outputs

This module is outputs; see ANL-F-02.

## 17. Acceptance tests (representative)

ANL-T-01 revenue by month in warehouse = FIN closed-period totals · T-02 query against primary DB from ANL code path fails lint/test · T-03 doctor comparison anonymised when policy off · T-04 data-quality counts match source queries.

## 18. Migration & rollout

Replica/warehouse provisioned; initial backfill; dashboards reviewed with the owner; builder to power users.

## 19. Out of scope

AI narrative insights → V3 · external BI connectors (Power BI) → V3 `INT`.

## 20. Open questions

ANL-Q-01 KPIs the owner cares about most · Q-02 replica vs warehouse (cost) · Q-03 appetite for benchmarks.

## 21. Definition of done

- [ ] Warehouse/replica live; reconciliation assertion green
- [ ] Must dashboards delivered; ANL-T-01 … T-04 green
- [ ] Open questions answered
