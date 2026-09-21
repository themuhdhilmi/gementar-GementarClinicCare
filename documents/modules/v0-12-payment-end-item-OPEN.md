# Payment — open end items

Everything about `PAY` that is **not finished, not provable here, or
waiting on something outside this repository**.

The money works. Rounding is exact and exhaustively tested, receipt
numbers are gapless under concurrency, the drawer reconciles as a sum
rather than a counter, a payment cannot be edited, and `amount_paid` is
checked nightly against the payments it claims to summarise.

What is missing is almost entirely **contact with the real world**: no
receipt has come out of a printer, no drawer has been counted by a
cashier, and nobody has told us which methods this clinic actually
takes.

| | |
|---|---|
| **Module** | [v0-12-payment.md](v0-12-payment.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. Before a single ringgit goes through it

| # | Item | Done when |
|---|---|---|
| **PAY-OPEN-01** | **No receipt has been printed (PAY-Q-02, §18, `DOC-OPEN-01`).** The 80 mm template exists, renders deterministically, and has met nothing but a browser. Thermal paper width is assumed, the font size is a guess, and whether their printer wants HTML or ESC/POS is the question the Phase 0 spike was supposed to answer and did not. **A pharmacy counter that cannot hand over a receipt is not open.** | The printer is known, twenty receipts have come out of it, and the owner has read one. Same afternoon as the labels and the certificates — `DSP-OPEN-01`, `DOC-OPEN-01`. |
| **PAY-OPEN-02** | **Nobody knows which methods they take (PAY-Q-01).** Six are implemented; every branch defaults to accepting all of them, and a branch nobody has configured takes cash. The card terminal provider is unknown, so "record the last four and an approval code" is a guess at what the cashier will have in front of them. | Ten minutes with the owner and the `payment_methods` screen — which does not exist either (`PAY-OPEN-08`). |
| **PAY-OPEN-03** | **No static DuitNow QR (§18).** The column is there, the screen would show it, and the clinic's bank has not been asked for the image. Today a QR payment is recorded as a reference typed by hand, which works and is not what the patient expects to see. | The clinic sends the QR their bank gave them; it goes in `payment_method_config.qr_payload`. |
| **PAY-OPEN-04** | **The variance threshold is RM 10, invented (PAY-Q-04).** Over it, an administrator must approve the close with a note. Too low and the owner approves every evening until it means nothing; too high and a real shortfall closes quietly. | The owner says a number. It is one setting. |
| **PAY-OPEN-05** | **Part payment is allowed by default (PAY-Q-05).** `billing.allowPartialPayment` is on, so a patient can owe money and the visit is blocked until an administrator forces it closed. Whether this clinic extends credit at all, and to whom, is a policy nobody has stated. | The owner answers; if they do not give credit, the setting goes off and the outstanding report stays empty, which is the best outcome. |
| **PAY-OPEN-06** | **Three days of parallel running have not happened (§18, `BIL-OPEN-03`).** The Z-report has never been compared to a real till at the end of a real day. That comparison is the only test that matters and it cannot be written here. | Three consecutive evenings at R4 with both systems, reconciled to the sen, and every difference explained rather than averaged away. |

## B. Measured, or not measured

| # | Item | Done when |
|---|---|---|
| **PAY-OPEN-07** | **`PAY-N-01` has not been measured.** A payment is an idempotency check, a lock on the receipt series, an insert, a movement, a recompute and an audit row — six statements in one transaction, which should be well inside 150 ms and has no number against it on any machine, let alone the clinic's. | Re-run with the other latency figures on the production host (`IAM-OPEN-01` and the rest of §2.2 of the readiness page). |

## C. No screen, or not enough screen

| # | Item | Done when |
|---|---|---|
| **PAY-OPEN-08** | **No screen for payment methods.** `GET` and `PUT /branches/:b/payment-methods` work and have no UI, so enabling DuitNow or marking card as needing a reference means `curl`. This blocks `PAY-OPEN-02` in practice, the same way the fee-schedule screen blocks the pricing conversation. | A block on the branch screen: a row per method with a switch, a display name and the QR payload. |
| **PAY-OPEN-09** | **No refund screen.** `POST /invoices/:id/refunds` works, needs a fresh password, and is reachable only from a terminal. Voiding a same-day payment has no button either. Both are administrator actions on a bad day, which is exactly when nobody wants to be told to use `curl`. | Two buttons on the invoice panel, behind the permissions the API already checks. |
| **PAY-OPEN-10** | **No denomination helper (§11).** The close screen takes one counted figure. The specification offers a note-by-note breakdown, the column is there and the API accepts it, and nothing fills it in. It is the difference between "RM 1,845" and "I have three fifties and I am four ringgit short in coins". |
| **PAY-OPEN-11** | **Reopening a session has no screen.** `POST /cash-sessions/:id/reopen` exists, is same-day only, needs a fresh password, and is recorded on the session so the Z-report can say it happened. No button. |

## D. Smaller things, honestly listed

| # | Item | Why it is here |
|---|---|---|
| **PAY-OPEN-12** | **A "reprint" is counted, not confirmed.** The same limit as every other document (`DOC-OPEN-09`): the browser cannot know whether paper came out. §14 asks for a receipt to be marked COPY only if an earlier print was *confirmed*; what is implemented is "marked COPY if a print was attempted", which will occasionally stamp COPY on the first real copy the patient sees. |
| **PAY-OPEN-13** | **The override BIL-F-17 asks for is ENC's, not PAY's.** The outstanding-balance guard is registered and refuses to complete a visit that owes money. Forcing it through is `encounter.force`, which exists, is administrator-only and is audited as a forced transition — but it is a general override rather than the specific "complete with outstanding, recording the amount" that BIL-F-17 describes. The amount is in the audit entry either way. |
| **PAY-OPEN-14** | **A refund is not a document.** `PAY-F-18` produces a negative payment with its own receipt number and no printed credit note; V1 `FIN` is where that belongs and the specification says so. A patient given cash back today gets a verbal explanation. |
| **PAY-OPEN-15** | **Cross-day corrections are refunds, and refunds need an open drawer.** Correct — the cash has to come out of a drawer somebody will count — and it means the first thing a cashier must do on a morning when they owe somebody money is open the drawer. Obvious once said, and not said anywhere on the screen. |
| **PAY-OPEN-16** | **`totals_by_method` is frozen at close and the Z-report says which it is showing.** If a session is reopened, an earlier printed Z-report and a later one will differ. The screen warns; the paper already printed does not. That is inherent, and it is why reopening is same-day, audited and recorded on the session itself. |
| **PAY-OPEN-17** | **The idempotency key is the browser's to choose.** A key per attempt, generated client-side. A caller that reuses one across two genuinely different payments gets the first one back, silently. That is the contract PAY-F-11 asks for and it trusts the caller; there is no window after which a key expires. |
| **PAY-OPEN-19** | **Thirty concurrent payments serialise on one row.** `receipt_series` is locked for the whole of each payment transaction, so the thirtieth waits for twenty-nine commits. That is what makes the numbers gapless and it is the right trade at a clinic where two cashiers are a lot — but it is a queue, and the wait grows linearly. `BIL` has the same shape on invoice numbers and `DOC` on certificates. Worth knowing before anybody imagines a branch with ten tills. |
| **PAY-OPEN-18** | **Nothing enforces one drawer per cashier.** `drawer_code` separates them and any cashier may use any open drawer. Two people sharing one drawer is a real way to run a small clinic and also the reason a variance cannot be attributed to a person. `PAY-Q-03` asks; nobody has answered. |

---

## What is actually finished

- Bank Negara 5-sen rounding, as a pure function with **30 unit tests**
  covering all ten last-digit cases at five magnitudes, symmetry about
  zero, and every way of splitting a bill — proving it rounds once, on
  the leg that settles, and never twice.
- Cash, card, DuitNow QR, transfer, e-wallet and cheque; split and part
  payment; tendered and change; overpayment refused after rounding.
- Receipt numbers gapless per branch per year under a row lock —
  thirty concurrent payments get thirty consecutive numbers.
- Idempotency: the same key returns the original payment and takes the
  money once.
- A drawer that opens with a float, records every movement as a signed
  amount, and computes what is expected as one sum — never a counter.
  Variance is recorded, never corrected, and one over the threshold
  needs an administrator and a note.
- Void same-day with the session open, reversing the invoice, the
  rounding and the drawer; refund otherwise, as a negative payment
  linked to the original.
- A payment cannot be edited or deleted, and neither can a drawer
  movement — both proved by direct SQL.
- `invoice.amount_paid` equals the sum of posted payments, recomputed on
  every write and checked nightly by a job that reports and never
  repairs.
- The receipt is a `DOC` document: rendered once, stored, hashed,
  reprintable, and the same one every time it is asked for.
