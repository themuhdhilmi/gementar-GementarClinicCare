# Dispensing — open end items

Everything about `DSP` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The module is complete against its specification, and two of the things
it needs are physical objects nobody has bought yet: a label printer and
whatever the clinic's inspector expects a controlled register to look
like on paper.

| | |
|---|---|
| **Module** | [v0-08-dispensing.md](v0-08-dispensing.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one the counter cannot work without

| # | Item | Done when |
|---|---|---|
| **DSP-OPEN-01** | **Nothing prints (DSP-F-12, DSP-Q-02).** `v0-13-documents.md` now turns a dispensed item into a stored, numbered label document at 50×30 mm — so there is a label to print, which there was not before. **It has still never met paper, and that was always the whole item.** The label endpoint returns everything a label needs — clinic, branch, telephone, patient, drug, strength, quantity, the instructions in the patient's language, lot number, expiry, "keep out of reach of children", cold-chain and controlled warnings — and counts the print. It has never met paper. **A pharmacy counter cannot run without labels**, so this is the difference between a demonstration and a working clinic. | The printer model and label size are known (`DSP-Q-02`), a template renders to it, and twenty real labels have been printed and read at arm's length. `DSP-N-03` — that a printer failure must not roll back the dispense — is already true by construction: printing is a separate request. |

## B. Legal, and unverified

| # | Item | Done when |
|---|---|---|
| **DSP-OPEN-02** | **The controlled register is the right data in an unknown shape (DSP-Q-01).** Append-only, running balance per product per branch, unmasked patient identity number, prescriber, batch, dispenser, optional witness — and a controlled drug physically cannot leave without an entry, enforced by a deferred constraint trigger. What nobody has checked is whether the *printed* register matches what an inspector expects to be handed. | The clinic's pharmacist or owner describes what their inspector asks for, and the print view matches it. §18 also asks for two weeks of parallel paper running at R3; that is the real acceptance test. |
| **DSP-OPEN-03** | **A witness is optional and never required.** `controlled.witness_required` is named in §12 as a tenant setting. It does not exist, so a witness is recorded when offered and never insisted on. | The clinic says whether their practice requires one. The field and the audit trail are already there; only the gate is missing. |

## C. Decisions for the clinic

| # | Item | Done when |
|---|---|---|
| **DSP-OPEN-04** | **Counselling is per session, not per item (DSP-F-13, DSP-Q-05).** Finishing a session records that the patient was counselled. Ticking it drug by drug is what the specification allows for and nobody has said they want. | Asked. If the answer is per item, the column is already on `dispense_item` and unused. |
| **DSP-OPEN-05** | **Batch pricing is stored and unread (DSP-Q-06).** Every line is priced from the product's list price. The batch's own selling price exists for clinics that mark up on cost. | The owner answers, and if it is batch-based, one branch in `dispenseItem`. Pairs with `INV-OPEN-08`. |
| **DSP-OPEN-09** | **No barcode scanning (DSP-Q-03).** A batch is picked from a list of one or two, which is fast enough at a small clinic and would not be at a busy one. | The clinic confirms they have scanners and their packs carry GS1. Same conversation as `INV-OPEN-07`. |

## D. Built, and not yet exercised for real

| # | Item | Done when |
|---|---|---|
| **DSP-OPEN-06** | **Nobody has dispensed for a week (DSP-N-01, DSP-N-02, §18).** The transaction is tested for correctness, including twenty simultaneous dispenses from a shelf of ten, and has never been timed on the production host or used by somebody standing up. | One week of live dispensing at R3 with a daily spot-count of the ten fastest-moving products, and `DSP-N-01` measured on the real machine. Depends on `INV-OPEN-01`: counting against a guessed opening balance proves nothing. |
| **DSP-OPEN-07** | **The undo window is fifteen minutes because fifteen is a round number.** It is a constant, not a setting. Nobody has watched how long a bag actually sits on a counter before the patient takes it. | `DSP-OPEN-06`'s shadowing answers it. Changing the number is one line; changing it *after* somebody has been caught by it is the expensive order. |
| **DSP-OPEN-14** | **Opening a session plans FEFO once per item, not once per session (DSP-N-04).** The requirement asks for one query; reading a session issues one batch lookup per line, so a five-item prescription costs five. Correct, and against the letter of the non-functional requirement. At a GP clinic's prescription sizes the difference is a few milliseconds on a local database. | The session read loads every product's batches in one query and plans in memory. Worth doing with `DSP-OPEN-06`'s timing, so the change is measured rather than assumed. |
| **DSP-OPEN-10** | **Partial dispensing has no top-up flow.** An item dispensed short is left `PARTIAL` and visible, and §4 describes a later top-up "within 7 days" from the same prescription. Reopening the encounter and dispensing the remainder works; there is no purpose-built path for it. | Somebody actually part-dispenses and comes back. The data supports it today. |

## E. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| ~~**DSP-OPEN-08**~~ | ~~**Nothing is billed.**~~ **Closed 2026-09-21.** A dispensed line becomes an invoice line at the price it was dispensed at, written inside the dispensing transaction; an undo takes it off again. Collecting the money is `v0-12-payment.md`. | Done. |
| **DSP-OPEN-11** | **A return credits nothing.** The medicine is quarantined and the patient is not refunded, because there is no invoice to credit. §14 says a return after payment needs a void and reissue. | `v0-11-billing.md`, and V1 for credit notes. |
| **DSP-OPEN-12** | **Quarantined stock has nowhere to go.** A return increments the batch's quarantined count and there is no workflow to destroy it, release it or write it off. | `INV-OPEN-05`. Until then quarantined stock accumulates as a number nobody acts on — which is still better than putting it back on the shelf. |
| **DSP-OPEN-13** | **Labels are not reprinted from anywhere but the session.** Once a session is finished there is no screen that reaches its labels. The endpoint works and counts reprints; nothing links to it. | A line on the visit's timeline, or the patient's record. Small, and worth doing when somebody first asks for a reprint the next morning. |

---

## Closed on 2026-09-21

- `ENC-OPEN-15`, in part and finally: the medicine half of the completion
  guard is registered. A visit cannot be finished while something
  prescribed has not been handed over, declined or marked external. The
  unpaid-balance half remains, with `v0-11-billing.md`.
- `RX-OPEN-07`, open since this morning: prescriptions can now be
  dispensed. Items move to `DISPENSED`, `PARTIAL` or `DECLINED`, and a
  prescription settles to `COMPLETED` on its own when nothing is left
  waiting.
- `INV-OPEN-13`: the `DISPENSE` and `DISPENSE_REVERSAL` movement types
  have their caller. They were in the enum with directions and no path
  to them since the ledger was built.
