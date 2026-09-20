# Safety, Integrity and Compliance

The parts where a bug is not a bug. A wrong invoice total is embarrassing; a wrong allergy warning or an editable signed consultation is a different category of problem.

> Nothing here is legal advice. The Malaysian regulatory items below are flagged as things to **verify with the clinic and, where it matters, with a professional** — deadlines and thresholds change, and a planning document is the wrong place to trust a remembered date.

---

## 1. Medical record integrity

A signed clinical record is a legal document. It can be added to; it cannot be silently changed.

**Rules:**
1. A consultation is `DRAFT` while the doctor works. Drafts are freely editable and visible only to their author.
2. Signing sets `status = SIGNED`, `signed_by`, `signed_at`. The encounter cannot complete with an unsigned consultation.
3. After signing the row is immutable. Enforce twice:
   - Service layer refuses the update
   - A Postgres `BEFORE UPDATE` trigger raises if `OLD.status = 'SIGNED'` and any clinical column changed

   The trigger is the one that will actually save you, because it holds regardless of which code path is involved.
4. A change after signing creates a `consultation_amendment` with the full before and after snapshots, the author, the timestamp and a **mandatory reason**.
5. Printed and displayed records show amendment history. A document that hides that it was amended is worse than no document.

**Draft safety:** a doctor's browser will crash mid-consultation. Autosave drafts every few seconds to the server, not to localStorage — the recovery case includes "the machine died", and the clinic will have a locum on a different computer.

---

## 2. Audit trail

Built in Phase 0. Retrofitting an audit trail means the first months of real data are unauditable, and those are exactly the months you will want to reconstruct.

**Log at minimum:**

| Category | Events |
|---|---|
| Access | login, logout, failed login, session revoked, password change |
| Clinical | **viewing** a patient's clinical record, consultation created/signed/amended, prescription created/changed |
| Patient | patient created, edited, merged, soft-deleted |
| Stock | adjustment, damage, expiry write-off, any manual quantity change |
| Money | invoice issued, voided, discount applied, payment taken, payment voided, refund |
| Admin | role change, permission change, price change, user created/disabled |

Viewing clinical records is on this list deliberately. "Who looked at this patient's file" is a question that gets asked when it matters, and only an access log can answer it.

Each entry: actor, action, entity, before/after, IP, user agent, timestamp, branch. Append-only at the grant level, not by convention.

**Implementation:** a Nest interceptor handles the routine cases from route metadata; explicit service-level calls handle the ones with domain meaning (a discount is more than an UPDATE on a row). Do not attempt to generate the whole trail from database triggers — you lose the actor and the intent, which is most of the value.

---

## 3. PDPA and patient data

Malaysia's Personal Data Protection Act governs this, and a clinic's records are sensitive personal data — the category with the strictest handling. Recent amendments have added obligations around breach notification and data protection officers; **confirm the current requirements and what applies to a clinic of this size before go-live.**

What to build regardless, because it is right and it is cheap now:

- **Encryption in transit** everywhere. TLS, HSTS, no exceptions.
- **Encryption at rest** for the database volume and the document bucket.
- **IC/passport numbers**: stored, because registration requires them. Displayed masked (`•••••-••-1234`) except where the full value is genuinely needed, with the unmask action audited.
- **Access minimisation**: front desk and finance staff cannot read consultation notes. Enforce at the API, never by hiding a button.
- **Retention**: Malaysian medical records generally must be kept for a substantial number of years, and longer for minors — **confirm the applicable period**. Build soft-delete and a retention field now; build purge tooling when the first period actually expires.
- **Export**: a patient may request their data. A simple per-patient export in V1 is enough.
- **Breach readiness**: know, before you need to know, how you would determine what was accessed. This is the audit log's other job.

---

## 4. Prescribing safety

V0 ships two checks. Both are simple and both are worth real care, because a warning that fires constantly gets ignored — and then the one that mattered gets ignored too.

**Allergy check.** On adding a prescription item, match against `patient_allergy`. Match on the product's generic name and its drug class, not the brand name — a patient allergic to amoxicillin must be warned about Augmentin. That requires a `generic_name` and ideally a class on every product; make it a required field when the catalogue is built.

**Duplicate check.** Warn when prescribing a second item with the same generic in one prescription, and when the patient has an overlapping active prescription from a recent visit.

Both are **warnings with a recorded override**, not blocks. The doctor is the clinician. But record the override, with reason, into the audit trail.

**Not in V0:** drug–drug interaction checking. Doing it properly needs a licensed clinical database with meaningful recurring cost, and doing it improperly is worse than not doing it — a half-populated interaction database that misses a real interaction teaches clinicians to trust something untrustworthy. V2, with a real vendor.

**Controlled substances.** The Poisons Act and Dangerous Drugs Act impose register-keeping requirements on clinics dispensing scheduled poisons. The `product.is_controlled` flag is in the V0 schema; **ask the pilot clinic what they currently dispense and what register they keep** (`08`). If they handle controlled items, a compliant register may be a V0 requirement rather than a later one.

---

## 5. Money

**Integer sen, everywhere.** No floats in any code path that touches an amount.

**Malaysian 5-sen rounding.** Cash payments round to the nearest 5 sen under the Bank Negara rounding mechanism; non-cash payments (card, DuitNow, transfer) are charged exact. So rounding is a property of *the payment method*, not of the invoice — which means:

- `invoice.grand_total` is the exact amount
- `rounding_adjustment` applies when settling in cash
- A split payment of part cash, part card rounds only the cash portion
- The receipt shows the adjustment as its own line

Get this wrong and the daily cash reconciliation is out by a few sen every day, which is exactly the kind of small persistent wrongness that destroys a clinic's trust in the system.

**Rounding rule for discounts:** decide once, write it down, test it. Recommended: compute at the line level, round half-up to the sen, store the integer. The invoice total is the sum of stored line totals — never recomputed from percentages at display time, or the receipt and the report will disagree.

**End-of-day reconciliation:** the cashier counts the drawer, enters the figure, the system shows the variance against recorded cash payments. Variance is recorded, not silently corrected. This is a feature that makes the clinic owner trust the software, and it costs a day to build.

---

## 6. e-Invoice (MyInvois)

LHDN's e-Invoice regime is being phased in by revenue band. **Verify where the pilot clinic falls and what their deadline is — this determines whether it is V1 or urgent.** Do not assume; the thresholds and dates have moved more than once.

Design implications worth honouring in V0 even before building it:

- Invoices need a stable, gapless, tenant-scoped numbering series. Build that correctly now — retrofitting invoice numbering is horrible.
- Buyer TIN and identification need a place to live on `patient` and on the corporate account. Nullable columns now cost nothing.
- Submission status, LHDN UUID, validation link and QR need somewhere to go on `invoice`. Add them nullable in V0, populate in V1.
- Consolidated invoicing for walk-in patients who do not request an e-invoice is likely how a clinic will mostly operate — the model must support many encounters rolling into one submission.

---

## 7. Security baseline

For V0:

- Argon2id password hashing
- Sessions as opaque server-side tokens in httpOnly, Secure, SameSite cookies. Not JWTs — you need revocation, and a clinic will ask you to kick out a departed employee immediately
- Rate limiting on login and on patient search
- Idempotency keys on payment and dispense
- CSRF protection on cookie-authenticated mutations
- No patient identifiers in URLs that end up in logs, and no patient data in error tracking payloads
- Dependency scanning in CI
- MFA for `ADMIN` in V0; for all clinical roles in V1

**Availability is a safety property here.** If the system is down, the clinic stops. Two things matter more than they look:

1. **A printed fallback.** If the system is unreachable, the clinic needs a defined paper process and a way to enter the backlog afterwards. Agree it with them before go-live.
2. **The clinic's internet.** A single fibre line with no failover means one outage takes the clinic offline for a day. Ask (`08`). A 4G backup router costs little and removes the worst failure mode.

---

## 8. Compliance checklist before go-live

- [ ] Restore from backup rehearsed end-to-end and timed
- [ ] Tenant isolation test suite green, including the all-tables RLS assertion
- [ ] Signed consultations provably immutable — verified by attempting the update directly in SQL
- [ ] Audit log covering every event in section 2
- [ ] IC masking, with unmask audited
- [ ] TLS, HSTS, encryption at rest confirmed
- [ ] Cash rounding verified against real receipts from the clinic's current system
- [ ] Invoice numbering gapless under concurrent load
- [ ] Stock ledger reconciliation job running and alerting
- [ ] Paper fallback process written and agreed with the clinic
- [ ] PDPA retention period confirmed and recorded
- [ ] Controlled-substance requirements confirmed with the clinic
- [ ] MyInvois obligation and deadline confirmed
