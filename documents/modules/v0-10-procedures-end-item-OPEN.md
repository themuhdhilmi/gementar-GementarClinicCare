# Procedures — open end items

Everything about `PRC` that is **not finished, not provable here, or
waiting on a module that does not exist yet**.

The module is complete against its specification. What is missing is not
code: it is an hour with the clinic's nurse over their actual procedure
list and what each one uses. `PRC-OPEN-01`.

| | |
|---|---|
| **Module** | [v0-10-procedures.md](v0-10-procedures.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. The one that decides whether the stock figures stay true

| # | Item | Done when |
|---|---|---|
| **PRC-OPEN-01** | **The catalogue and its consumable mappings are guesses (PRC-Q-01).** Thirteen procedures are seeded with plausible prices and plausible materials. **The mapping is the whole point of the module**: a dressing mapped to two gauze swabs when the nurse uses six is a stock figure that drifts by four every dressing, which is worse than not deducting at all — a known gap gets counted, a wrong number gets believed. | An hour with the nurse, going through what they actually do and what each one actually uses, and an hour with the owner on prices. Load before R3. Until then the deductions are precise and wrong. |

## B. Decisions for the clinic

| # | Item | Done when |
|---|---|---|
| **PRC-OPEN-04** | **Nurse-initiated procedures are switched off, and the switch does not exist (PRC-F-06, PRC-Q-02).** A nurse ordering without a doctor is refused and the refusal names the setting. The setting is not built, because "may a nurse do this to a patient unasked" is not a question to answer with a default. | The clinic says which procedures — almost certainly dressing changes on a nurse-only visit — and `procedures.allow_nurse_initiated` becomes a branch setting. The service already reads a function; it needs a settings group behind it. Half a day once the answer exists. |
| **PRC-OPEN-05** | **Consent is a tick, not a signature (PRC-Q-04).** Required where the procedure says so, recorded with who consented and when. No form, no signature, nothing printable. | `v0-13-documents.md` gives a printable consent form. Ask first whether they capture written consent today and for what; building a form nobody signs is worse than a tick everybody does. |
| **PRC-OPEN-06** | **Nobody has timed the perform form (PRC-N-02).** The target is thirty seconds for a standard nebuliser. It is one screen with the consumables prefilled, and it has only been used by its author. | One shadowed session with the nurse at R3, stopwatch in hand. Depends on `PRC-OPEN-01`: timing a form full of the wrong consumables measures the wrong thing. |

## C. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **PRC-OPEN-07** | **Nothing is charged.** `procedure.performed` carries the price snapshot and `procedure.voided` carries what to take off, which is exactly what `PRC-R-07` specifies. Nothing consumes either. The charge sits on the row as `price_snapshot` in the meantime, so no revenue is lost — it is simply not invoiced yet. | `v0-11-billing.md`. |
| **PRC-OPEN-08** | **Voiding after an invoice is issued is not handled (§14).** Today a void inside 24 hours always succeeds, because there are no invoices for it to contradict. When there are, a void against an issued invoice has to become a credit note. | `v0-11-billing.md`. The 24-hour window is the placeholder that keeps this from mattering yet, and it should be revisited at the same time. |
| **PRC-OPEN-09** | **No printable immunisation record (PRC-F-11).** The data is complete — vaccine, batch, expiry, site, who gave it, when — and shows on the patient's record. There is no certificate. | `v0-13-documents.md`, and V1 for the schedule and reminders. |

## D. Smaller things, honestly listed

| # | Item | Done when |
|---|---|---|
| **PRC-OPEN-10** | **No catalogue screen for procedures.** Adding one, or changing a price, or fixing a consumable mapping, is an API call. This is the same gap the product catalogue has, and it matters more here because the mappings will be edited repeatedly during `PRC-OPEN-01`. | A screen under `/admin`, with the consumable editor. Do it before the session with the nurse, not after — editing mappings live is the session. |
| **PRC-OPEN-11** | **A batch cannot be chosen by hand from the perform form.** The service takes one if given, and the form always lets FEFO decide. For a vaccination the nurse is holding a specific vial and may want to say which. | A batch select beside each batched consumable, defaulted to the FEFO pick. Small, and worth asking about first: FEFO is usually right and a select the nurse always accepts is a select that wastes two seconds every time. |
| **PRC-OPEN-12** | **Ordering the same procedure twice creates two rows, by design (§14).** The `quantity` on the order endpoint does this. There is no bilateral-in-one-row path, and `laterality: BILATERAL` exists for clinics that prefer it. | The clinic says which they want for dressings. Both work today; only one of them charges twice. |
| **PRC-OPEN-13** | **`allowShortfall` is recorded and not reported.** A procedure performed against stock that was not on the shelf is flagged in the audit entry and in the response. Nothing lists them, so nobody knows to go and count. | A line on the stock screen: "procedures performed against stock that was not recorded". Cheap, and it is the signal that a mapping is wrong — which is `PRC-OPEN-01` again, discovered the expensive way. |

---

## Closed on 2026-09-21

- `CON-OPEN-07`, fully: the plan's four orders are now two. A signed note
  with a procedure on it routes the patient to the treatment room, the
  same way a prescription routes them to the pharmacy. Medical
  certificates and referrals are still missing, and both are `DOC`.
- `ENC-OPEN-15`, in part: the completion registry has its procedure
  check. A visit cannot be finished with a procedure still waiting. The
  dispensing and balance halves remain open, with `v0-08-dispensing.md`
  and `v0-11-billing.md`.
- `RX-T-09` stopped being a placeholder. It asserted that the
  `stock_movement` table did not exist; it now asserts that nothing in it
  references a prescription, which is what `RX-R-01` actually says.
