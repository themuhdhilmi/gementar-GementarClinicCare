# Patient Registry — open end items

Everything about `PAT` that is **not finished, not provable yet, or waiting on
someone else**. The module specification says what was built; this says what
is still owed, and how each one will be known to be done.

One item, `PAT-OPEN-01`, should be picked up this week rather than before
go-live: it is the only one that could still change the schema.

| | |
|---|---|
| **Module** | [v0-03-patient.md](v0-03-patient.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. Do this one first

| # | Item | Done when |
|---|---|---|
| **PAT-OPEN-01** | **Nobody has seen the pilot's existing data (PAT-Q-01, PAT-Q-02).** The importer is built, tested and takes a named-column CSV. What it does not have is a single real row from the system the clinic uses today. Every other open item can wait; this one decides whether the schema is right, and finding out after the clinical modules are built is far more expensive than finding out now. | An export sample is in hand, a mapping script turns it into the importer's format, and a dry run has been read through with the clinic. Any column they have that this schema cannot hold is either added or explicitly dropped, in writing. |

## B. Built but not yet exercised for real

| # | Item | Done when |
|---|---|---|
| **PAT-OPEN-02** | **Search measured on the wrong machine.** A hundred thousand patients were seeded and every way of searching was timed, but against a database across a network from a development laptop. The figures in §13 are the shape of the answer, not the answer. | Re-run on the production host: `PAT_LOAD_TEST=true npm run test:e2e -- test/patient-search-load.e2e-spec.ts`, and write the numbers into §13. This is the same job as `IAM-OPEN-01` and should be done in the same sitting. |
| **PAT-OPEN-03** | **The merge has never been used in anger.** It is tested in both directions, including the case that first broke it, where the survivor had borrowed the loser's identity number and would not give it back. What is untested is a merge of two records with months of history against both. | The first real duplicate is merged at the pilot, watched, and the result checked with whoever reported it. §18 expects this within the first month. |
| **PAT-OPEN-04** | **Attachments are on the server's disk.** Right for a few thousand small scans, and in the same backup as the rows referencing them. Wrong at volume, and wrong the moment there is more than one application server. | Either the pilot's attachment volume turns out to be small and this is closed as fine, or object storage arrives in V1 and `storage_key` becomes a bucket key. The `StorageService` seam exists so that is a new driver, not a change to PAT. Depends on the answer to `PAT-Q-06`. |
| **PAT-OPEN-05** | **A failed file write leaves a row with no bytes.** The row is committed and the file is written afterwards, because a twenty megabyte write must not hold a database transaction open (TEN-F-17). Downloading such a document answers "not found". | Either a nightly check reconciles `patient_document` against the store and reports orphans, or object storage makes the two-phase upload natural and this goes away. Decide when `PAT-OPEN-04` is decided. |

## C. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **PAT-OPEN-06** | **The patient header is used by one screen.** `components/patient-header.tsx` exists, takes the clinical summary as a prop so the allergy badge costs no second request, and is the thing TRI, CON, RX and DSP must reuse rather than reimplement. Four implementations would eventually disagree about which state is amber, and that disagreement is a prescribing error. | Each of `v0-05-triage.md`, `v0-06-consultation.md`, `v0-07-prescription.md` and `v0-08-dispensing.md` imports it. Check at each one. |
| **PAT-OPEN-07** | **The Visits tab is empty.** Nothing records a visit yet. | `v0-04-encounter-queue.md`. It also has to publish `encounter.completed`, which is what keeps `last_visit_at` current for the search result row. |
| **PAT-OPEN-08** | **Allergies do not stop anything.** They are recorded, verified, refuted and shown. Nothing checks a prescription against them, and the unlinked free-text ones can only be matched by a human. | `v0-07-prescription.md`: it consumes `patient.allergy_added`, matches on drug class and generic name, and warns "check by hand" for free text. That is where PAT-R-07's blocking warning lives. |
| **PAT-OPEN-09** | **A patient's old identity number is not searchable.** A MyKid becomes a MyKad at twelve. The change is allowed and carries a reason, and the old number survives only in the audit trail. Somebody searching the old number finds nothing. | V1 adds an identifiers table (§19). Until then, the audit trail is the record and the front desk searches by name. |

## D. To confirm with the pilot clinic

| # | Item | Done when |
|---|---|---|
| **PAT-OPEN-10** | **PAT-Q-03: how are allergies written down today?** Assumed to be free text, which the importer handles by keeping the original wording and marking it unverified. | Asked. If the clinic keeps a structured list, the import gets better and nothing else changes. |
| **PAT-OPEN-11** | **PAT-Q-04: race and religion.** Optional, unused, printed nowhere. | Confirmed either way. If they are not collected, the fields stay and stay empty. |
| **PAT-OPEN-12** | **PAT-Q-05: the patient number.** Defaults to `P-000001`. A tenant setting, so it changes on the settings screen. | The clinic has chosen a prefix, and said whether their existing numbering should continue. If it should, the import carries the old numbers and `--startMrnAt` moves the counter past them. |
| **PAT-OPEN-13** | **PAT-Q-06: how much scanning do they do?** Decides whether `PAT-OPEN-04` is urgent or academic. | Asked, with a rough count per day. |
| **PAT-OPEN-14** | **PAT-Q-07: a MyKad reader.** Not built. The form reads a typed number and fills in three fields, which removes most of the error a reader would. | Asked. Worth raising unprompted: a reader also removes the transposition that creates duplicate records in the first place. |

## E. Deliberately not built

| # | Item | Why |
|---|---|---|
| **PAT-OPEN-15** | **PAT-F-06, patient photographs.** A Could. The column and the storage are there; there is no capture. | A webcam at the counter is a hardware question for the clinic, and nothing in V0 needs the photograph. Revisit if identity confusion turns out to be a real problem at the pilot. |

---

## Closed on 2026-09-21

Kept so the list reads as a history rather than only a backlog.

- The load test found that search read every row in the table. Ranking every
  candidate in a subquery and then keeping the ones that scored was a
  sequential scan: 220 ms end to end at a hundred thousand patients, against
  0.05 ms for the same lookup through an index. Rewritten as one indexed
  branch per way of reading what was typed.
- Name search matched only contiguous text, so "hassan zulkifli" did not find
  "Zulkifli bin Hassan". Every word typed is now required, in any order.
- Duplicate detection never fired on the commonest path of all. It looked at
  the date of birth as typed, and registering from a MyKad fills that in
  rather than asking for it, so the name-and-birthday check saw nothing.
- Unmerging failed on the unique index when the survivor had borrowed the
  loser's identity number during the merge and would not give it back.
- Searching became a POST, because the text is very often an identity card
  number and PAT-N-06 says those never reach a URL.
