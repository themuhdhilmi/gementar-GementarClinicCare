# Reporting & dashboard — open end items

Everything about `RPT` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The operational half is done: the dashboard, the patient register, queue
performance, attendance, diagnoses, prescribing, certificates and the
stock reports all run, in the branch's own day, with CSV exports that are
recorded when they are taken.

The financial half is done too, now that `v0-12-payment.md` exists:
sales, discounts, voids, outstanding, **collections**, the **end-of-day
pack** and a **reconciliation with all four terms real**. What is left
is the shape of the thing rather than the substance — no PDF, no
materialised views, and nobody has looked at any of it for a week.

| | |
|---|---|
| **Module** | [v0-15-reporting-dashboard.md](v0-15-reporting-dashboard.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. Closed by payment

| # | Item | Lands with |
|---|---|---|
| **RPT-OPEN-01** | ~~**No collections report (RPT-F-13).**~~ **Closed by `v0-12-payment.md`.** Payments by day, method, cashier or drawer session, summed from the `payment` table rather than from `invoice.amount_paid` — the two agree, and summing the payments is the one that can be cut by cashier. Voided payments are excluded and listed separately; a refund stays in, because a day the clinic gave RM 50 back took RM 50 less. | Done. |
| **RPT-OPEN-02** | ~~**No end-of-day pack (RPT-F-14).**~~ **Closed.** `GET /branches/:b/reports/eod-pack` assembles the sessions, sales, collections, discounts, invoice voids, payment voids, outstanding, reconciliation and stock alerts into one response — built from the same report functions the screens call, so the pack and the screens cannot disagree. It also counts sessions still open at close, which is the thing the owner needs told. | Done as data. It is not a PDF — `RPT-OPEN-08`, `DOC-OPEN-01`. |
| **RPT-OPEN-03** | ~~**The reconciliation is two terms of four.**~~ **Closed.** `issued = collected + outstanding`, with voids reported beside it. `collected` is summed from the payments and `outstanding` from the invoices — two tables reached two different ways, so a disagreement is real. It also reports whether `invoice.amount_paid` agrees with the payments, which is the per-period version of what the nightly job checks per invoice. | Done. |
| **RPT-OPEN-04** | ~~**`RPT-T-02` cannot be written.**~~ **Closed by `v0-12-payment.md`'s own tests**, which assert the Z-report's method totals against the payments taken in that session. The cross-module version — the collections report for a period equalling the Z-reports in it — is asserted by `reconciliation`'s `paymentsAgreeWithInvoices`. | Done. |

## B. Measured, or not measured

| # | Item | Done when |
|---|---|---|
| **RPT-OPEN-05** | **`RPT-N-01` and `RPT-N-02` have not been measured, and `RPT-T-06` is therefore not green.** The dashboard is eight indexed aggregate queries and should be well inside 300 ms; the patient register over 31 days is one join over an indexed range. Both are almost certainly fine and neither has a number against it, at any data volume, let alone twelve months of it. | A load spec in the shape of `patient-search-load.e2e-spec.ts` — seed a year, run the dashboard twenty times, print the p95 — run on the production host and written into §13. It is an hour. |
| **RPT-OPEN-06** | **`RPT-N-05`: exports are built in memory, not streamed.** The whole CSV is assembled as a string and sent. At the specified cap of 100,000 rows that is tens of megabytes in one Node buffer. The actual cap here is lower — the patient register stops at 5,000 rows — so nothing can currently reach it, and the cap is a silent truncation rather than a page. | Either stream the rows with a cursor, or make the truncation loud: return the count and say it was cut. The second is ten minutes and should happen first. |

## C. Built differently from the specification

| # | Item | Why |
|---|---|---|
| **RPT-OPEN-07** | **No views and no materialised views (§5).** The specification names ten `v_` views and two `mv_` materialised ones. What exists is typed SQL in `operational.service.ts`, `financial.service.ts` and `stock-report.service.ts`, computed live. The reason is `RPT-R-06`, which says money must come from live views anyway, and the fact that a materialised view refreshed nightly reports yesterday — which for a clinic looking at today's diagnoses is worse than being slightly slower. At pilot volume "slightly slower" is single-digit milliseconds. **This will not hold at fifty clinics**, and the seam is clean: each query becomes a view definition without the callers changing. |
| **RPT-OPEN-08** | **No PDF, for any report (RPT-F-20).** CSV only. A PDF needs a renderer and there is none — the same `DOC-OPEN-01` printing spike that leaves certificates unprinted. The browser's own print of a report page is the stopgap and nobody has tried it on paper. |
| **RPT-OPEN-09** | **No `report_export` table (§5).** The specification stores every export as a row with its parameters and a storage key. What exists is an audit entry per export, with the report key, the parameters, the dates and whether the report names patients — which answers the question the table was for ("who took a copy of what") without keeping a copy of every export on disk forever. If somebody wants to *re-download* a past export, the table becomes necessary. |
| **RPT-OPEN-10** | **Sparklines and deltas are not built (§11).** Each tile shows a value and a hint and links to its report. "Compared to yesterday" and a seven-day sparkline are both a second query per tile and were left until somebody has looked at the plain version for a week and said which numbers they actually compare. |

## D. Smaller things, honestly listed

| # | Item | Why it is here |
|---|---|---|
| **RPT-OPEN-11** | **`RPT-F-03`, the all-branches summary, is not built.** Every report takes one branch. There is one branch. The API would take a branch list; the screen would need a column. It is `V2 BRN`'s problem in any case and is listed so nobody assumes it works. |
| **RPT-OPEN-12** | **`RPT-F-22`, saved filters, is not built.** The range presets exist (today, yesterday, 7 days, 30 days); nothing remembers which one you used last. |
| **RPT-OPEN-13** | **The antibiotic rate depends on a column that is mostly empty.** `RPT-F-09` computes it from `drug_class`, which for the pilot's twenty-five-product catalogue is largely unset — `RX-OPEN-01`. The report shows the count of unclassified items beside the rate, and the screen warns when there are any, so the number is read next to its own uncertainty instead of being believed. It is still a number somebody could quote. |
| **RPT-OPEN-14** | **Diagnoses group on lowercased free text (§14).** "URTI", "urti" and " URTI " become one; "Upper respiratory tract infection" stays separate. ICD-10 coding is optional in V0 and mostly absent, so this is the best available grouping and it will overstate the number of distinct diagnoses. |
| **RPT-OPEN-15** | **A timezone change would rewrite history.** Buckets use the branch's timezone *at query time* (§14 already documents this). Malaysia has not changed offset since 1982, so the pilot will never see it. |
| **RPT-OPEN-16** | **`RPT-R-01` is a module boundary, not a database grant.** Nothing in `src/modules/reports` writes — there is no `INSERT` in the module and the only `POST` produces a file — but the application connects as one role, so the guarantee is "this code does not write", not "this code cannot write". The separate read-only reporting role is V2 in the specification, and is the same shape of gap as `IAM-OPEN-05`. |
| **RPT-OPEN-17** | **The patient register stops at 5,000 rows with no pagination.** §12 asks for paginated detail rows. At 300 encounters a day that is sixteen days, which is longer than anybody looks at in one go — but a 366-day range would silently return the first 5,000. Same family as `RPT-OPEN-06`: make the truncation loud first. |
| **RPT-OPEN-18** | **`RPT-Q-03` is answered by default rather than by asking.** A doctor sees their own prescribing and their own certificates; only somebody with `report.financial` — the owner — sees everybody's. That is the specification's stated default and nobody has confirmed it is what this clinic wants. |

---

## What is actually finished

- The dashboard, live, with the financial tiles **absent** rather than
  blank for anybody without the permission, and a nudge over SSE at most
  once every five seconds.
- Patient register, patients by hour/day/doctor with new-versus-returning
  that does not creep, queue performance from the event log with median
  and p90, no-shows and cancellations, diagnoses, prescribing, medical
  certificates.
- Stock valuation at cost, the alert list, and movements with shrinkage.
- Daily sales, sales by line type or doctor, discounts with reasons and
  actors, voids, outstanding balances in ageing buckets.
- Every range is the branch's own day, bounded at 366 days, and a bad
  one is refused rather than returning something misleading.
- One audited CSV export route for every report, producing the same rows
  the screen showed — so the file and the screen cannot disagree.
- Every money figure is a sum of stored `bigint` sen and crosses the
  wire as a string, so nothing is ever a float.
