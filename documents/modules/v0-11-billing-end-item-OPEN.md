# Billing — open end items

Everything about `BIL` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The arithmetic is done and proved. What is missing is the clinic's own
numbers — what they charge, and whether their accountant says any of it
is taxable — and a way to print what the patient is handed.

| | |
|---|---|
| **Module** | [v0-11-billing.md](v0-11-billing.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides whether the totals mean anything

| # | Item | Done when |
|---|---|---|
| **BIL-OPEN-01** | **The fee schedule is one invented rule (BIL-Q-01, BIL-Q-04).** A flat RM 40 consultation, seeded so the tests have something to bill. The clinic charges differently for a follow-up, probably differently after hours, possibly differently per doctor — all of which the schedule supports and none of which anybody has told it. **Until this is real, every invoice is arithmetic on a made-up number.** The same conversation settles the discount cap (10%) and the reason threshold (5%), both guesses. | An hour with the owner over their current price list. The schedule is rows, so it can be typed in as the conversation happens — which is why `BIL-OPEN-04` should come first. |

## B. Before the first real invoice

| # | Item | Done when |
|---|---|---|
| **BIL-OPEN-02** | **Numbering starts at 000001 (BIL-Q-03).** Per branch, per year, gapless. If the clinic wants to continue an existing series — and most do, because their accountant expects continuity — that is one `UPDATE` to `invoice_series.next_seq` before the first issue, and it has to be deliberate: the series is gapless by design, so there is no tidy way to insert numbers afterwards. | The owner says which, and if it is "continue", the counter is set and the first invoice number is checked by eye before the second one is issued. |
| **BIL-OPEN-05** | **Tax is off everywhere (BIL-Q-02).** Every line defaults to `NONE`, which is right for most GP work and is nobody's professional opinion. `SST_6` and `SST_8` are implemented and tested in both directions, and the tenant has no SST registration number to print (`BIL-F-12`). | Their accountant says what, if anything, is taxable. Changing it is data, not code — except the registration number, which is a column on the tenant that does not exist yet. |
| **BIL-OPEN-03** | **Nothing has been reconciled against the old system (§18).** The specification asks for three days of parallel running agreeing to the sen, and that is the test that actually matters. | Three days at R4, with the daily totals compared and any difference explained rather than averaged away. |

## C. No screen, or not enough screen

| # | Item | Done when |
|---|---|---|
| **BIL-OPEN-04** | **No administration screen for fees or billable items.** Both have working APIs and no UI, so setting up the clinic's prices means `curl`. This blocks `BIL-OPEN-01` in practice: the session with the owner *is* typing the schedule in while they talk. | A screen under `/admin` with the fee-schedule table showing specificity, and the billable-item list. Do it before the pricing conversation, not after. |
| **BIL-OPEN-06** | **The cashier screen does not refresh itself (BIL-F-06, BIL-N-04).** It reloads when the cashier does something. If a dispense happens while the bill is open the new line is not shown until the screen is reopened — which in practice it is, because the cashier opens the bill after the pharmacy is done. | Subscribe the billing screen to the existing SSE stream, the way the queue board does. Small; deferred because the ordering of a real visit hides it. |
| **BIL-OPEN-08** | **The elevation dialogue is not built (§11).** Above the cap, the server refuses with a message naming what an administrator would need to approve, and the screen relays it. There is no inline "administrator signs in here" flow; the API accepts the approving administrator's id, which is enough for a test and not enough for a counter. | A dialogue that takes administrator credentials, verifies them, and returns a short-lived token. The `POST /elevate` endpoint in §8 is not built either. |

## D. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **BIL-OPEN-09** | ~~**Nothing can be printed (BIL-F-19).**~~ **Closed.** `POST /invoices/:id/print` renders a stored, letterheaded invoice and refuses a draft; a reprint carries the COPY stamp. `v0-12-payment.md` added the receipt. | Done, except that no invoice has come out of a printer — `DOC-OPEN-01`. |
| **BIL-OPEN-10** | ~~**Nothing collects money.**~~ **Closed by `v0-12-payment.md`.** Payments post against an invoice, `amount_paid` and `balance` follow, and the status walks ISSUED → PARTIAL → PAID and back on a void. Cash rounding to five sen is applied by the payment leg that settles, not by the invoice — which is what `rounding_adjustment` was reserved for. | Done. |
| **BIL-OPEN-16** | ~~**The outstanding-balance completion guard is deliberately not registered.**~~ **Closed by `v0-12-payment.md`,** which registers it — because payment is the module that can clear it, which was the whole reason billing left it alone. A visit with an unpaid bill cannot be completed; an administrator forcing it through goes via `encounter.force`, which is audited as a forced transition. That is a general override rather than BIL-F-17's specific one — `PAY-OPEN-13`. | Done. |
| **BIL-OPEN-11** | ~~**Void checks a column, not a ledger.**~~ **Closed.** `void` now sums the posted payments themselves and refuses if either the rows or the column says anything was paid. Reading both costs one indexed query and means that if the two ever disagree, the answer comes from the money rather than the summary of it. | Done. |
| **BIL-OPEN-12** | ~~**A document fee never appears (BIL-F-02).**~~ **Closed by `v0-13-documents.md`,** which calls the same `ChargeRegistry` inside its own transaction rather than from an event, so a document and its fee commit together or not at all. A billable item coded `DOC_MC`, `DOC_REFERRAL`, `DOC_LETTER` or `DOC_LAB_REQUEST` makes that document fee-bearing; no such item and it is free. Proved end to end. | Done. The one wrinkle left is that the naming convention is undiscoverable without a screen — `DOC-OPEN-17`, which `BIL-OPEN-04` absorbs. |

## E. Smaller things, honestly listed

| # | Item | Done when |
|---|---|---|
| **BIL-OPEN-07** | **There is no lint rule banning float arithmetic on money (BIL-N-03).** The specification asks for one. Instead every amount is a `bigint`, and TypeScript refuses to mix `bigint` and `number` without an explicit conversion — which catches the same mistake at the same moment, with a better message. | Decide whether the lint rule adds anything on top of the type. My view is that it does not, and this should be closed as "done differently" rather than left open. Worth one look by somebody who is not me. |
| **BIL-OPEN-13** | **BIL-N-01 has never been timed.** The issue transaction is meant to be inside 150 ms including the series allocation. It does one locked update and a handful of writes, and has only ever run against a laptop's database. | Measured on the production host, with `BIL-OPEN-03`'s parallel running. |
| **BIL-OPEN-14** | **A follow-up is not detected, only configurable (§14).** The schedule supports an encounter type with a lower fee; nothing works out that this patient was here four days ago and sets it. The doctor or the cashier changes the encounter type by hand. | The clinic says what their follow-up window is, and `ENC` sets the type at registration. Worth doing only once `BIL-OPEN-01` shows they actually charge differently. |
| **BIL-OPEN-15** | **`payer_type`, `membership_id` and the e-invoice columns are present and unused.** Deliberate: adding a column to a table of immutable rows later is far more awkward than carrying nulls now. | V1 `PNL`, `MEM` and `EIV`. Nothing to do until then. |

---

## Closed on 2026-09-21

- `ENC-OPEN-15`, finally and completely. The last of the three
  completion guards is registered: a visit cannot be finished while its
  invoice is unissued or its balance unpaid. The medicine half closed
  with `DSP` this morning and the procedure half with `PRC`.
- `PRC-OPEN-07` and `DSP-OPEN-08`, in part: performed procedures and
  dispensed medicines now become invoice lines at the price they were
  recorded at. What is still missing is collecting the money, which is
  `PAY`.
