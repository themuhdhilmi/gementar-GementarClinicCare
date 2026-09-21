# Production readiness

One list, cut one way: **what stops real patients being seen on this
system**, and what does not.

Every module's register already says what is unfinished, module by module.
That view answers "is `RX` done?". It does not answer the question that
actually matters on the morning of go-live, which is "if we switch this on
today, what hurts?" — because the things that hurt are spread across nine
registers and most of them are not code.

The test is deliberately narrow. An item is a **production blocker** if
switching on without it risks one of:

- **losing data** that cannot be recovered,
- **harming a patient**, through a wrong drug or a missed warning,
- **losing money** the clinic cannot get back,
- **exposing one clinic's data to another**, or to the internet,
- **stopping the clinic working**, with no manual way round it.

Everything else — however unfinished, however annoying — is not a blocker.
A missing screen that has a `curl` equivalent is not a blocker. An untimed
interaction is not a blocker. A module that does not exist yet is not a
blocker if the clinic can do that job on paper the way they do today.

| | |
|---|---|
| **Written** | 2026-09-21 |
| **Covers** | v0-01 … v0-11 (all of V0 except PAY, DOC, RPT) |
| **Reviewed against** | the nine `*-end-item-OPEN.md` registers |

---

## 1. Production blockers

Eighteen. None of them is a feature.

### 1.1 Data you cannot get back

| # | Item | Why it blocks |
|---|---|---|
| `IAM-OPEN-09` | **No backups, and no rehearsed restore.** | The single worst item on this page. A clinic's patient records are the clinic. `02-architecture.md` puts this in Phase 0 and it is still open. A backup nobody has restored is not a backup — it is a file of unknown validity. Nightly encrypted `pg_dump` off the box, 30 daily and 12 monthly, and **one timed restore with the time written down**. |
| `IAM-OPEN-10` | **The encryption key has one copy, in a `.env` on one laptop.** | Lose `APP_KEK_V1` and every enrolled MFA secret is undecryptable: every member of staff re-enrols, and until they do, administrators cannot sign in at all. Leak it next to a database dump and those secrets are readable. Needs an off-repository, off-backup copy and a written recovery procedure. |
| `PAT-OPEN-04` | **Attachments are on the server's own disk.** | Patient documents are written to `STORAGE_ROOT`, which the database backup does not cover. A restore brings back every row pointing at a file that is gone. Either the disk is in the backup set or attachments move to object storage — but the two must not be backed up separately and restored to different points in time. |

### 1.2 Isolation and exposure

| # | Item | Why it blocks |
|---|---|---|
| `IAM-OPEN-05` / `TEN-OPEN-15` | **The application connects as the owner of its tables.** | The same item from two directions. Row-level security is `FORCE`d, so tenant isolation itself holds even against the owner. What does not hold is the second line: this account can `DROP POLICY`, and it is the account facing the internet. `prisma/sql/app-role.sql` and `09-database-roles.md` are written; nobody has run them against production. |
| `IAM-OPEN-11` | **Nothing terminates TLS, and there is no staging.** | The HSTS header is set and would be a lie. Separately: migrations now rewrite enums and expand rows, and they should never meet patient data for the first time. Caddy in front, and one environment that has taken the full migration set before production does. |
| `INV-OPEN-03` | **The app role can write `quantity_on_hand` directly.** | Same shape as `IAM-OPEN-05` and listed separately because it is a different grant. `move()` is the only write path by module boundary, which a compiler checks; nothing stops a mistaken direct `UPDATE`, and only the nightly job would notice, the next morning. |
| `TEN-OPEN-13` | **The box has to be in Malaysia.** | Weak as a technical blocker, real as a legal one. The backup destination counts: an encrypted dump in a bucket in Virginia is the part people forget. |

### 1.3 Clinical safety

These are the ones where the code is finished and the **data** is a guess.
Each is an hour in a room, not a sprint.

| # | Item | Why it blocks |
|---|---|---|
| `RX-OPEN-01` | **The medicine catalogue is twenty-five guesses.** | An allergy check is exactly as good as its `drug_class` column. A patient allergic to penicillin gets **no warning** on a cephalosporin the clinic stocks under a brand name with no class recorded. The service refuses to prescribe a medicine with no *generic* name, so that gap is loud; a missing *class* is silent, and silence reads as "checked, all clear". |
| `TRI-OPEN-01` | **Nobody has agreed the vitals thresholds.** | The flags that tell a doctor a patient is sick are set to numbers somebody chose. The paediatric ones are not even settings. Wrong thresholds either cry wolf until they are ignored, or miss. |
| `BIL-OPEN-01` | **The fee schedule is one invented rule.** | A flat RM 35 consultation, seeded so there is something to bill. The clinic charges differently for a follow-up and almost certainly after hours. Every invoice until this is real is correct arithmetic on a made-up number — and unlike a wrong stock figure, a wrong price is money the clinic does not get back. The same conversation settles the discount cap. |
| `PRC-OPEN-01` | **Procedure consumable mappings are guesses.** | Softer than the two above — it is money and stock rather than harm — but it degrades in an unpleasant way. A dressing mapped to two gauze swabs when the nurse uses six drifts the count by four *every time*, and a wrong number gets believed where a known gap gets counted. |
| `INV-OPEN-01` | **No physical count, so no true opening stock.** | Every figure in the system was typed in. Without a count everybody signed off on, later reconciliation measures drift from a guess, and the first time the shelf disagrees nobody knows which of the two to trust. |

### 1.4 The clinic cannot work without it

| # | Item | Why it blocks |
|---|---|---|
| `DSP-OPEN-01` | **No label printer, so nothing prints.** | A pharmacy counter cannot hand a patient an unlabelled bag. The payload is complete — drug, dose, instructions in the patient's language, lot, expiry, warnings — and has never met paper. Needs the printer model and label size (`DSP-Q-02`), a template, and twenty real labels read at arm's length. |
| `DSP-OPEN-02` | **The controlled register has never been shown to an inspector.** | The data is right and append-only, and a controlled drug physically cannot leave without an entry. Whether the *printed* register is what their inspector expects to be handed is unknown, and finding out during an inspection is the wrong time. §18 asks for two weeks of parallel paper at R3. |
| `IAM-OPEN-04` | **No email provider is configured.** | Invitations and password resets are hand-carried links. That is survivable for six people on day one and not survivable the first time somebody is locked out on a Saturday. Needs a sending domain with SPF, DKIM and DMARC, and one real reset that arrives in an inbox rather than in spam. |
| `IAM-OPEN-08` | **There is exactly one administrator, and MFA is mandatory for them.** | If that person loses their phone *and* their recovery codes, nobody can reset the second factor through the application. Recovery needs database access and a command-line script. Two administrators, recovery codes in two different drawers. |
| `TEN-OPEN-14` | **The five default settings are guesses.** | The discount limit of 10%, cash rounding to 5 sen, daily queue-number reset, and not requiring a diagnosis to sign. A wrong discount limit is a real and recurring loss. Reading five lines aloud to the owner closes it. |

---

## 2. Not blockers

Everything else. Grouped by *why* it is not, because the reason is the
useful part — it is what stops each of these being re-litigated every week.

### 2.1 Modules that do not exist yet

`PAY` payment, `DOC` documents, `RPT` reporting.

**Not blockers**, because the clinic does all of these today without this
system and can continue to. A prescription is written, printed by hand or
read off the screen, and the pharmacy counter works the way it worked last
year. Nothing is lost that was not already outside the system.

What this costs: invoices are produced and **nothing collects payment**
(`BIL-OPEN-10`), so money is taken at the counter and written in the
clinic's own book against an invoice number the system issued; and
nothing is printed — no invoice, receipt, prescription slip, dispensing
label or immunisation certificate (`BIL-OPEN-09`, `CON-OPEN-05`,
`RX-OPEN-02`, `DSP-OPEN-01`, `PRC-OPEN-09`).

The one thing to *decide* rather than defer: whether the clinic bills on
paper during the pilot, or whether the pilot waits for `BIL`. That is a
scheduling answer, not an engineering one.

### 2.2 Measurements taken on the wrong machine

`IAM-OPEN-01`, `IAM-OPEN-02`, `IAM-OPEN-03`, `IAM-OPEN-23`, `TEN-OPEN-04`,
`PAT-OPEN-02`, `ENC-OPEN-03`.

**Not blockers**, because every one of them is expected to *improve* on the
real host — the database moves from a network hop away to the same box.
They are on this list to be re-run, not to be fixed.

The exception worth watching: `IAM-OPEN-02`, the Argon2 cost. It is
measured at 46 ms on this laptop against a 200–300 ms target, which means
password hashing is currently too **cheap**. That is a security weakening
rather than a slowness, and it is set by an environment variable on the
production host. Not a blocker because setting it is one line, but do not
skip the line.

### 2.3 Things that work and have no screen

`INV-OPEN-11` catalogue admin, `PRC-OPEN-10` procedure admin,
`TEN-OPEN-06` module switches, `TRI-OPEN-04` the vitals chart.

**Not blockers**, because each has a working API and a documented `curl`,
and in every case there is exactly one person who would use it — me, during
the pilot.

`PRC-OPEN-10` is the one to do first anyway, not because it blocks anything
but because editing consumable mappings *is* the session that closes
`PRC-OPEN-01`, and doing that through `curl` with a nurse watching is a bad
hour.

### 2.4 Built, and waiting for something to notice it

`CON-OPEN-02` consultation integrity, `INV-OPEN-14` stock reconciliation,
`IAM-OPEN-12` break-glass review.

Three jobs that detect exactly the things you would most want to know
about, and write them to a log nobody reads.

**Not blockers** in the strict sense, because the detection works and the
evidence is recorded. But this is the softest "not a blocker" on the page:
detection nobody sees is very close to no detection. A ten-minute cron that
greps for `INTEGRITY FAILURE` and `STOCK MISMATCH` and emails is worth
doing before go-live even though nothing forces it.

### 2.5 Guards that currently guard nothing

`TEN-OPEN-02` branch-id constraint, `ENC-OPEN-15` dispensing and balance
completion guards, `INV-OPEN-05` quarantine, `INV-OPEN-09` transfers,
`IAM-OPEN-07` duplicate email across tenants.

**Not blockers**, because in every case the thing being guarded against
cannot happen yet: there is one branch, nothing dispenses, nothing bills,
and there is one clinic. Each register names the module that will make its
guard necessary.

`ENC-OPEN-15` is deliberate rather than merely unfinished, and worth
restating: the undispensed-medicine completion guard is **not** registered,
because registering it today would make every prescribed visit impossible
to finish. A guard nothing can satisfy is a trap.

### 2.6 Not built on purpose

`PAT-OPEN-15` patient photographs, `PAT-OPEN-14` MyKad reader,
`TRI-OPEN-06` historical flag recomputation, `RX-OPEN-06` paediatric mg/kg,
`CON-OPEN-06` keyboard overlay, `INV-OPEN-07` GS1 barcode parsing.

**Not blockers**, and several should stay unbuilt until somebody asks. The
mg/kg helper is the clearest case: the specification is explicit that it
must never auto-fill, and putting an uninvited number beside a dose field
is a way to create the error it was meant to prevent.

### 2.7 Nobody has used it for a day

`ENC-OPEN-13`, `ENC-OPEN-14`, `CON-OPEN-04`, `TRI-OPEN-02`, `PRC-OPEN-06`,
`PAT-OPEN-03`.

**Not blockers**, because they are the pilot itself. The consultation
workspace was built for a ninety-second note and has only ever been used by
its author; so has the triage form, the perform form and the merge. These
close by watching somebody use them, which is what a pilot is for.

---

## 3. The order to do them in

Not by severity — by what unblocks the next thing.

1. **`IAM-OPEN-09` backups, with one timed restore.** Before anything else
   touches real data. Everything below is recoverable if this is done and
   nothing is if it is not.
2. **`IAM-OPEN-11` TLS and a staging environment.** Staging is where the
   next three are rehearsed rather than discovered.
3. **`IAM-OPEN-05` / `TEN-OPEN-15` / `INV-OPEN-03` the unprivileged role.**
   One piece of work, three registers. Rehearse on staging; the end-to-end
   suite passing against the restricted account is the proof.
4. **`IAM-OPEN-10` the key, `IAM-OPEN-04` email, `IAM-OPEN-08` a second
   administrator.** Operational, independent, all small.
   **`DSP-OPEN-01` the label printer** belongs here too: it is a purchase
   and a template, not engineering, and the counter cannot open without
   it.
5. **The room, in one visit:** `RX-OPEN-01` drug classes, `TRI-OPEN-01`
   thresholds, `PRC-OPEN-01` consumable mappings, `BIL-OPEN-01` the fee
   schedule and discount cap, `TEN-OPEN-14` the five defaults,
   `CON-OPEN-01` templates, `DSP-OPEN-02` the register layout. Also
   `BIL-OPEN-02`: whether to continue their existing invoice numbering,
   which must be decided *before* the first invoice is issued. These are the same meeting, and the
   catalogue screens (`INV-OPEN-11`, `PRC-OPEN-10`) should exist before it
   so the answers can be typed in as they are given — `BIL-OPEN-04` is
   the fee-schedule screen, and it blocks that conversation in practice.
6. **`INV-OPEN-01` the opening count.** After the catalogue is real, and on
   a day the clinic is closed.
7. **The ten-minute cron** for `CON-OPEN-02` and `INV-OPEN-14`.

Steps 1 to 4 are mine and take days. Step 5 is theirs and takes one
morning. Step 6 is theirs and takes one day. Nothing in the list is
engineering work of any size, which is the point: **the system is not what
is unfinished.**
