# V0 — manual testing

One folder per module, for **using** the system rather than reading
about it.

**Start at [`00-START-HERE/`](00-START-HERE/README.md).** It sets the
database up and walks one patient end to end in about four minutes.

## What is in each folder

| | |
|---|---|
| `README.md` | The walkthrough. Setup, what to click, what to try to break, and what is deliberately unfinished. **Mine — I may rewrite it.** |
| `notes.md` | **Yours.** Bugs, friction, questions. |
| anything else | Yours too. Screenshots, CSVs, scratch files. |

The walkthroughs describe what is **actually built**, not what the
specification hoped for. Where the two differ they say so and name the
open item. If something does not match what you see, that is a bug in
the walkthrough and worth fixing first — a test guide you cannot trust
is worse than none.

## The modules

| | Folder | Code | What it is for |
|---|---|---|---|
| 00 | [start here](00-START-HERE/README.md) | — | Setup, and one patient end to end |
| 01 | [identity-access](01-identity-access/README.md) | IAM | Signing in, MFA, roles, lockout, sessions |
| 02 | [tenancy-branch](02-tenancy-branch/README.md) | TEN | Clinic and branch settings, letterhead, isolation |
| 03 | [patient](03-patient/README.md) | PAT | Registering, MyKad, duplicates, allergies, merge |
| 04 | [encounter-queue](04-encounter-queue/README.md) | ENC | The queue, calling, the waiting-room screen |
| 05 | [triage](05-triage/README.md) | TRI | Vitals and the flags |
| 06 | [consultation](06-consultation/README.md) | CON | The note, signing, amending, templates |
| 07 | [prescription](07-prescription/README.md) | RX | Prescribing, allergy and interaction warnings |
| 08 | [dispensing](08-dispensing/README.md) | DSP | The pharmacy counter, batches, labels |
| 09 | [inventory](09-inventory/README.md) | INV | Stock, batches, counts, alerts |
| 10 | [procedures](10-procedures/README.md) | PRC | Ordering, performing, consumables |
| 11 | [billing](11-billing/README.md) | BIL | The bill, discounts, issuing, voiding |
| 12 | [payment](12-payment/README.md) | PAY | The drawer, rounding, receipts, voids, refunds |
| 13 | [documents](13-documents/README.md) | DOC | Certificates, referrals, letters, reprints |
| 14 | [audit-trail](14-audit-trail/README.md) | AUD | Who did what, and proving it cannot be rewritten |
| 15 | [reporting-dashboard](15-reporting-dashboard/README.md) | RPT | The tiles, the reports, the exports |

## The three things most likely to bite

Not bugs — known gaps, and the ones you will hit first:

1. **Nothing has ever been printed** (`DOC-OPEN-01`, `DSP-OPEN-01`,
   `PAY-OPEN-01`). Certificates, labels and receipts all render in a
   browser and have never met a printer.
2. **The medicine catalogue is twenty-five guesses** (`RX-OPEN-01`).
   Allergy checking is exactly as good as its `drug_class` column, and
   a missing class fails *silently*.
3. **Every clinical threshold and price is invented** (`TRI-OPEN-01`,
   `BIL-OPEN-01`, `PRC-OPEN-01`, `PAY-OPEN-04`). They are settings, not
   code, and they are wrong until somebody from the clinic says
   otherwise.

The full cut is
[`../../planning/10-production-readiness.md`](../../planning/10-production-readiness.md).
