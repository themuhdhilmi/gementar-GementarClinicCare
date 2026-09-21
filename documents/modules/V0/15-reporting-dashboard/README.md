# 15 · Reporting & Dashboard (RPT)

The numbers the owner checks before going home, and the reports behind
them.

**Register:** [`../v0-15-reporting-dashboard-end-item-OPEN.md`](../../v0-15-reporting-dashboard-end-item-OPEN.md)

## Setup

Run a day's worth of the other walkthroughs first — patients seen, bills
issued, money taken. An empty clinic makes a dull dashboard.

## Walk through

1. **Dashboard.** Nine tiles, each a link to the report behind it.
2. **Compare two roles.** Sign in as Dr Farid in one window and Dr
   Aisyah in another. The doctor sees patients, waiting, wait times,
   stock and unsigned notes. The administrator sees those **plus**
   billed, collected, voided, the drawer and unbilled visits.
   *The money tiles are not greyed out for the doctor — the API never
   sends them. A number the browser was told and chose not to draw has
   been disclosed.*
3. **Check somebody in on another tab.** The dashboard moves, at most
   once every five seconds however busy the morning gets.
4. **Reports.** Everything this role may run.
5. **Sales versus collections.** Billed, collected, still owed, voided.
   **Billed must equal collected plus outstanding, to the sen**, and the
   screen says so in green. It also checks the two ways of knowing what
   was collected against each other — the invoices' figure and the
   payments themselves — which would catch a payment an invoice never
   heard of.
6. **Collections**, grouped by method, cashier, drawer session or day.
7. **Daily sales, then export it.** The CSV has every amount **twice**:
   once in sen, which adds up, and once as ringgit, which reads. Open it
   in Excel — the byte order mark is there so Malay names are not
   mojibake.
8. **Audit → filter for `report.exported`.** Which report, which dates,
   and whether it names patients.
9. **Queue performance.** Median and ninetieth-percentile waits, taken
   from the event log rather than a column — so a patient only counts
   once somebody actually called them.
10. **Prescribing.** The antibiotic rate is shown **next to the number
    of items with no drug class recorded**, and the screen warns when
    there are any. With the pilot's catalogue there will be a lot: the
    rate is a floor, not a figure.
11. **Discounts.** Every one, with the reason somebody typed and the
    name of whoever allowed it.
12. **Stock valuation** at cost, and **movements** with shrinkage.

## Try to break it

- **Ask for a range longer than a year.** Refused.
- **Ask for dates the wrong way round.** Refused, by name.
- **Check the branch day.** A patient seen at 11 p.m. is on *that* day's
  report, not the next. Malaysia is UTC+8, so a report bucketed in UTC
  would put the last four hours of every evening on the following day —
  the kind of error nobody notices until the owner is short by one
  patient on a Monday.
- **As Puan Zana, ask for daily sales.** 403. The report is not in her
  catalogue either.
- **Export a report and compare it to the screen.** They cannot
  disagree, because the CSV is the same rows the screen rendered.

## What is deliberately not here

- **No performance figures at all** (`RPT-OPEN-05`). The dashboard
  should be well inside 300 ms and has never been measured, at any data
  volume. An hour's work: seed a year, run it twenty times, print the
  p95.
- **No PDF, for any report** (`RPT-OPEN-08`). CSV only, and the
  browser's own print as a stopgap nobody has tried on paper.
- **No views or materialised views** (`RPT-OPEN-07`). Everything is
  computed live from typed SQL, which is right at pilot volume and will
  not hold at fifty clinics. The seam is clean.
- **No sparklines or "compared to yesterday"** (`RPT-OPEN-10`) — left
  until somebody has looked at the plain version for a week and said
  which numbers they actually compare.
- **The end-of-day pack is data, not a document** (`RPT-OPEN-02`). It
  assembles from the same reports the screens use, so the two cannot
  disagree; it is not a PDF because nothing renders PDFs.

## Notes

<!-- yours -->
