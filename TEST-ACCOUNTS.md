# Test accounts

Accounts for trying the system out on the **development database**. They exist
in the `klinik-pilot` tenant at branch `KL01` (Cawangan Cheras).

> **Not for production.** These passwords are written down in a file in the
> repository, which means they are not secrets. Before the clinic goes live,
> create real accounts through the Staff screen, let each person set their own
> password from their invitation link, and delete these.

Sign in at **http://localhost:3000/login** after starting the app with
`npm run dev`.

All six use the same password:

```
ujian-klinik-2026-selamat
```

| Email | Name | Role | At sign-in |
|---|---|---|---|
| `doctor@klinikpilot.test` | Dr Farid | Doctor | Straight to the workspace |
| `nurse@klinikpilot.test` | Jururawat Mei | Nurse | Straight to the workspace |
| `frontdesk@klinikpilot.test` | Puan Zana | Reception + dispenser + cashier | Straight to the workspace |
| `dispenser@klinikpilot.test` | En Kamal | Dispenser only | Straight to the workspace |
| `cashier@klinikpilot.test` | Cik Rina | Cashier only | Straight to the workspace |
| `admin@klinikpilot.test` | Dr Aisyah | Administrator | Stops at MFA enrolment first |

The front desk is three roles rather than one, so a clinic that separates the
counter can say so. Puan Zana holds all three, which is the one-person front
desk; En Kamal and Cik Rina hold one each, which is the larger clinic.

Start with the doctor if you only want to look around.

> This file is the **quick tour**. For a module-by-module walkthrough —
> what to click, what to expect, and what to try to break — see
> [`documents/modules/V0/`](documents/modules/V0/README.md).

## The administrator needs an authenticator app

Administrators can read every clinical record, so a second factor is mandatory
for them in V0 (`IAM-F-09`). The first sign-in will not let you past enrolment.

1. Sign in with the password above.
2. Scan the QR code with any TOTP app — Google Authenticator, Aegis, 1Password,
   Bitwarden. If you cannot scan, "Cannot scan? Show the setup key" gives you
   the key to type in.
3. Enter the six digits it shows.
4. Save the ten recovery codes. They are shown once and each works once.

After that, sign-in is password then code. If you lose the secret, reset it:

```bash
npm run user:create --workspace @gementar/api -- \
  --email admin@klinikpilot.test --name "Dr Aisyah" --role ADMIN \
  --branch KL01 --password "ujian-klinik-2026-selamat" --mfa-off
```

## What each role sees

Permissions resolve per role at the active branch, so the difference is visible
immediately in the header and on the workspace page.

| | Doctor | Nurse | Reception | Dispenser | Cashier | Administrator |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Permissions at this branch | 24 | 14 | 12 | 13 | 15 | 34 |
| Staff, Branches, Clinic and Audit tabs | – | – | – | – | – | ✓ |
| Check a patient in, run the queue | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record vitals at triage | ✓ | ✓ | – | – | – | ✓ |
| Read vitals and consultations | ✓ | ✓ | – | – | – | ✓ break-glass |
| Write and sign a consultation | ✓ | – | – | – | – | – |
| Amend a signed record | ✓ | – | – | – | – | – |
| Force a stuck visit, issue a display token | – | – | – | – | – | ✓ |
| Register and search patients | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See a full identity number | ✓ | – | ✓ | – | ✓ | ✓ |
| Record an allergy | ✓ | ✓ | – | – | – | ✓ |
| Confirm or rule out an allergy | ✓ | – | – | – | – | – |
| Write clinical notes | ✓ | – | – | – | – | – |
| Dispense medicine | ✓ | ✓ | – | ✓ | – | ✓ |
| Take payment | – | – | – | – | ✓ | ✓ |
| Register a patient, run the queue | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read clinical notes | ✓ | ✓ | – | – | – | ✓ break-glass |

## Worth trying

- **Sign in as the doctor, then as the front desk.** The workspace lists exactly
  what that role can do; neither sees the Staff or Audit tabs.
- **Compare the cashier and the dispenser.** Cik Rina can take payment and
  cannot dispense; En Kamal is the other way round; Puan Zana can do both.
  Ticking all three boxes in the staff drawer is how a one-person counter is
  set up.
- **As the administrator, add a person.** The drawer takes a name, an email and
  a role per branch. Email is not connected yet, so the invitation link is shown
  on screen for you to hand over.
- **Disable someone while they are signed in.** Their next request fails and
  they are signed out everywhere, in the same moment. Their name stays on
  everything they have already done.
- **Read clinical data as the administrator.** It is allowed, and it appears on
  the Audit page as a break-glass entry. A doctor doing the same thing is
  routine and is not flagged.
- **As the administrator, open Clinic.** The settings form is generated from
  the schema the API serves, so every field carries its own help text and
  default. Change the front desk discount limit and it applies everywhere.
- **Then open Branches and override it for one branch.** Tick the box beside
  the setting, give it a different number, and save. Untick it later and that
  branch follows the clinic again, including any change made since — only the
  difference is ever stored.
- **Upload a logo on a branch.** PNG, JPEG or SVG up to 512 KB. Try renaming
  something that is not an image to `.png`: it is refused, because the file is
  judged by its bytes rather than by its name.
- **Register a patient from a MyKad.** Type `900101-14-5678` into the number
  field on the registration form. The date of birth and sex fill themselves
  in from the card. Try `901301-14-5678` and it is refused, because there is
  no thirteenth month.
- **Try to register the same card twice.** Refused, with a link to the
  existing record. Then try a different card with the same name and birthday:
  that one warns rather than refuses, because twins exist.
- **Search for someone three ways.** The last four digits of their card, their
  telephone number in any format, and their name with the words in the wrong
  order. `hassan zulkifli` finds `Zulkifli bin Hassan`, because "bin" is not
  part of anybody's name.
- **Look at the allergy badge.** A new patient is amber and says "allergies
  not recorded", which is not the same as having none. Record "no known
  allergies" and it turns green with somebody's name against it.
- **Record an allergy as the nurse, then as the doctor.** The nurse's is
  unverified; the doctor's is verified on the spot. Ruling one out keeps it in
  the record with the reason, because the next prescriber needs to know the
  question was asked.
- **Change your own password from My account.** It asks for your password again
  first, and signs out your other devices afterwards.
- **Get a password wrong five times.** The sixth attempt is refused with a
  countdown rather than another try.

## Things that will look like bugs and are not

- **"Too many attempts" when you know the password is right.** Sign-in is rate
  limited: five failures for one email address in fifteen minutes, and twenty
  failures from one IP address. Testing from one machine reaches the second
  limit quickly. Wait it out, or clear the history:

  ```sql
  DELETE FROM login_attempt;
  ```

- **Signed out after a while.** Sessions idle out after an hour and last at
  most twelve, sized for a shared reception computer. Both are environment
  settings if your clinic gives everyone their own device.
- **An invitation link that no longer works.** They are single-use and last 72
  hours; password reset links last 30 minutes.
- **The administrator cannot disable themselves,** and cannot drop their own
  ADMIN role while they are the only administrator. A clinic locking itself out
  at 6pm is a worse outcome than the inconvenience.

## Seven patients to look at

```bash
npm run patients:seed --workspace @gementar/api
```

Adds seven people to the pilot clinic, chosen so that every state worth
seeing is present at once. Running it again is safe: it brings them up to
date rather than adding them twice, so it is also how you repair them after
a change.

Run `npm run catalogue:seed --workspace @gementar/api` first, or run it
afterwards and re-run this one. One of the allergies below is linked to a
specific medicine in the catalogue, and the link can only be made if the
medicine is there.

| Who | Age | Worth opening because |
|---|---|---|
| Ahmad bin Zulkifli | 38 | No known allergies, recorded by a named person. Green badge. |
| Siti Nurhaliza binti Kassim | 34 | A life-threatening penicillin allergy, verified by Dr Farid. Red badge. |
| Muthu a/l Ramasamy | 51 | An allergy the counter wrote down that no clinician has confirmed. Amber, and the record says who recorded it. |
| Chan Wei Ming | 24 | Nobody has asked about allergies. Amber, and this is the state that matters most. |
| Nur Aisyah binti Ahmad | 1 mo | A newborn with no identity document, and a note saying whose baby she is. Her age reads in months, not years. |
| Kavitha a/p Selvam | 43 | An allergy written down as "some antibiotic, cannot remember which". Nothing can match it, so every prescription warns that it has to be checked by hand. |
| Rahmat Santoso | 42 | An Indonesian passport rather than a MyKad, so his date of birth had to be asked for rather than read off the card. Also a severe allergy linked to a specific medicine — the one case that stops a signature. |

Search for `ahmad`, `5533`, `012-345 6789`, or `ramasamy muthu` with the
words the wrong way round.

Two things in that table are the point of it. **Chan Wei Ming is amber and
Ahmad is green**, and the difference is that somebody asked Ahmad. A doctor
treats those two patients differently, and a system that showed both as
"no allergies" would be lying about one of them. **Muthu's allergy is amber
too**, because the counter recorded what he said and no clinician has
confirmed it; a prescriber needs to know which of those they are looking at.

Three of them carry the three kinds of allergy the prescribing checks can
tell apart. **Siti's** is against a class, so it warns on every penicillin.
**Rahmat's** is against one specific medicine, so it is an exact match and
at severe it stops the signature. **Kavitha's** is words nobody has linked
to anything, so it warns that it cannot be checked at all — which is
annoying by design, because the alternative is a screen that looks like it
checked and did not.

## Running a clinic day

Open **Today** in the header. Everything below happens on that screen, and
it updates itself: a change made at one station appears on every other board
within a second, without anyone pressing refresh.

1. **Check somebody in.** Open a patient and press Check in. They get a
   queue number and join the triage queue.
2. **Sign in as the nurse and press Space.** That calls the patient at the
   head of the triage queue. Send them on to the doctor.
3. **Sign in as the doctor.** Call them, then choose where they go next. The
   buttons come from the state machine itself, so the screen can never offer
   a move the system would refuse.
4. **Try to finish a visit early.** Reception cannot send a patient straight
   from the triage queue to finished. The refusal says what *is* possible
   from where they are.

Worth trying:

- **Check the same patient in twice at one branch.** Refused, with their
  existing queue number. At a different branch it is allowed, with a warning,
  because a referred patient legitimately has two visits in a day.
- **Check somebody in as an emergency.** They get an `E-` number and go to
  the front of every queue. The reason is required and is shown to whoever
  was moved down.
- **Call a patient three times.** The screen offers to mark them absent
  rather than doing it: they may be in the toilet. Mark them absent, then
  put them back in the queue from their visit.
- **Skip somebody.** They go to the back of the same queue, not out of it.
- **As the administrator, force a stuck visit closed.** It asks for your
  password again and a reason, and it appears on the Audit screen.

## Taking vitals

Sign in as the nurse, open **Today**, go to the Triage board and call the
next patient. The row turns into a Record vitals button.

The form is one column in the order a nurse actually takes readings, and
values colour themselves as you type:

- **Type 86 into oxygen saturation.** The field turns red and a banner
  appears. Save, and it offers to move that patient to the front of every
  queue. It offers; it does not decide.
- **Type 1200 into systolic.** Refused, because that is a slipped finger
  rather than a hypertensive crisis. The message says to check what was
  typed. A genuinely alarming reading like 85 saves without complaint.
- **Enter 70 kg and 175 cm.** The body mass index appears, worked out on the
  server. Sending one from outside is refused rather than ignored.
- **Try it for a child.** Register somebody born three years ago and enter a
  pulse of 120. Nothing is flagged, because that is unremarkable in a
  toddler. The same reading in an adult is noted.
- **Save and keep here.** For a second set after a nebuliser. Each set is a
  new record, and the doctor sees them in order.

The form asks about allergies the first time it opens for a patient nobody
has asked about. One click records "no known allergies" against your name,
which is what turns the amber badge green.

## Writing a consultation

Sign in as the doctor, call the next patient from the Doctor board, then
press Write the note.

- **It saves itself.** The indicator at the top says when. Close the tab
  halfway through and come back: everything is there. Pull the network out
  and it says so in red rather than pretending.
- **Try to sign an empty note.** Refused, naming exactly what is missing.
  Add what brought the patient in and a diagnosis, and it signs.
- **Signing routes the patient.** They appear on the Payment board — or on
  the Pharmacy board if you prescribed something — and the visit's timeline
  says why they moved.
- **Now try to change it.** The record is read-only. The Amend button adds
  something beside it: a correction shows the original struck through with
  the new text under it, and an addendum is added at the foot. Both carry
  your name and your reason, and the reason has to be a sentence.
- **Look at the vitals afterwards.** They locked when you signed, because
  they are part of what you signed. Editing them now needs an amendment
  too.
- **Make a template.** Fill in a few sections, save it as a template, then
  open a new consultation and apply it. It fills what you left empty and
  leaves alone anything you had already typed, and says which.

Two things to notice as an administrator. A visit cannot be finished while
a consultation is unsigned, and the message says so. And every signed
record is fingerprinted when it is signed, then checked against that
fingerprint nightly.

## Prescribing

```bash
npm run catalogue:seed --workspace @gementar/api
```

Adds twenty-five medicines — the things a GP clinic reaches for — each with
a generic name, and a drug class on everything an allergy is usually
recorded against. Running it again brings them up to date.

Prescribing happens inside the consultation, in the Prescription card on the
right. Type three letters and press Enter.

- **Type `amox`, press Enter.** The dose, route and frequency arrive filled
  in from the product, and the quantity works itself out: 500 mg three times
  a day for five days is 15 capsules, with an `auto` badge. Type over the
  quantity and the badge goes, because it is no longer the computer's number.
- **Read the label.** It is in Malay, and it says "Ambil 1 biji", not "Ambil
  500 mg" — the person holding the bag is holding capsules.
- **Prescribe amoxicillin to Siti Nurhaliza.** A red banner: she is allergic
  to penicillin and this is in that class. Try to sign: refused. Give a
  reason and it signs.
- **Prescribe diclofenac to Rahmat Santoso.** Also red, and this one is worse
  — an exact match to a severe allergy. A reason is not enough: the sign
  dialogue makes you tick a box for that specific item, every time. Nothing
  remembers the tick.
- **Prescribe anything to Kavitha a/p Selvam.** An amber banner on every
  item saying her allergy cannot be matched and has to be checked by hand.
- **Prescribe anything at all to Chan Wei Ming.** Amber: nobody has ever
  asked him about allergies.
- **Prescribe the same medicine twice.** The second one says it is already
  on the prescription. Do it on a later visit and it names the date, the
  branch and the doctor.
- **Sign, then change your mind.** On the signed record, Amend an item: a
  version 2 appears, version 1 is struck through and kept. The plain edit
  button is gone, and the API refuses one with a 409.
- **Try 500 mg of a syrup.** Refused, and it says the quantity cannot be
  worked out from that. It will not guess milligrams into millilitres,
  because guessing a concentration is how a child gets ten times the dose.

A patient with a prescription is routed to the pharmacy when the note is
signed. Dispensing it is the next section.

## The pharmacy counter

Sign in as the dispenser and open Pharmacy. A patient appears there as soon
as a doctor signs a note with a prescription on it.

- **Open one.** Every item shows the batch to take from, chosen by earliest
  expiry, with how many are in it and what the line costs. Press *Hand over*.
- **Watch the stock.** Go to Stock and look at the medicine: a `DISPENSE`
  movement for exactly what you gave, with the balance it left behind.
- **Print the label.** It is in the patient's language — "Ambil 1 biji, 3
  kali sehari" — with the lot number, the expiry and "keep out of reach of
  children". Print it twice and the count goes up; the second print is
  audited.
- **Press Undo within fifteen minutes.** The stock goes back as a matching
  reversal and the item is waiting again. Try it after fifteen and it tells
  you to record a return instead.
- **Give less than prescribed.** It asks why, and leaves the item part
  dispensed rather than finished.
- **Pick a different batch.** Refused unless you say why, because the one it
  suggested expires first.
- **Substitute.** Another brand of the same generic goes through. A
  different medicine is refused for a nurse and allowed for a dispenser or a
  doctor, because that is a prescribing decision.
- **Dispense a controlled drug** — tramadol is in the seeded list. A register
  entry is written in the same transaction with a running balance, and the
  patient's identity number is recorded in full on purpose. A patient with no
  identity number is refused, and the message says to fix their file.
- **Try to finish the visit with medicine still waiting.** Refused. Deal with
  every item first — hand it over, or mark it not taken.

The register is at
`/api/v1/branches/<branchId>/controlled-register`, and reading it is audited
because it shows unmasked identity numbers. Nothing prints it yet
(`DSP-OPEN-02`), and no label reaches a printer (`DSP-OPEN-01`) — the payload
is complete and the hardware is not chosen.

## Procedures and stock

```bash
npm run procedures:seed --workspace @gementar/api
```

Adds fifteen consumables, an opening balance of each at every branch, and
thirteen procedures with their consumable mappings. Running it again tops
the shelves back up rather than doubling them.

**As the doctor**, in a consultation, the Procedures card is above the
Prescription card. Type "neb", press Enter. Sign: the patient is routed to
`PROCEDURE_WAITING` rather than to the pharmacy.

**As the nurse**, open Procedures in the sidebar.

- **The board lists people, not procedures.** One row per patient, with
  what is waiting underneath. Press *Do it*.
- **The consumables are already filled in** — a mask and a salbutamol
  respule for a nebuliser — with how many are on the shelf beside each.
  Change a number if more was used.
- **Press Done.** Go to Stock and look at the mask: two movements, the
  opening balance and the one you just made, each with the balance it left
  behind.
- **Try a suturing.** It needs consent *and* a doctor, so the nurse is
  refused on both counts and the message says which.
- **Try an influenza vaccination.** It needs a site; leave it empty and
  Done stays disabled. Fill it in, save, then open the patient's record —
  there is a Vaccinations card with the batch number and the expiry.
- **Order the same thing when the shelf is empty.** Correct a consumable
  down to zero in Stock first. The perform form warns before you commit,
  and *Record it anyway* performs the procedure, deducts what there was
  and flags the difference.

**As the administrator**, void one within a day: the stock goes back as a
matching reversal, and the patient's vaccination record stays, struck
through, with the reason.

## Stock

Stock is in the sidebar for anyone who can read it.

- **Record a delivery.** Search a product, give a quantity, a batch number
  and an expiry. `2027-03` is accepted and means the 31st, which is what a
  blister pack means when it is stamped 03/2027.
- **Try receiving something already expired.** Refused.
- **Try the same batch number with a different expiry.** Refused, saying
  one of the two is wrong.
- **Correct a number.** It writes a movement with a reason rather than
  editing the figure, so History still explains how the shelf got here.
- **Try to take out more than is there.** Refused, with both numbers.
- **Expiring within 90 days** is a filter, and those dates are amber. Past
  ones are red.
- **Retire a product that still has stock.** The catalogue refuses, saying
  how many are on the shelf.

Every night at 04:15 a job recomputes every batch's quantity from its
movements and compares. It never corrects anything — a job that silently
fixes a mismatch destroys the evidence of how it happened. An administrator
can run it on demand:

```bash
curl -sb cookies.txt -X POST \
  'http://localhost:3001/api/v1/admin/stock-reconciliation'
```

## Billing

```bash
npm run billing:seed --workspace @gementar/api
```

Adds five consultation-fee rules and seven counter items. **Every price
is invented** — replacing them is one hour with the clinic's owner
(`BIL-OPEN-01`), and until then the arithmetic is right and the numbers
are not.

Billing is the **cashier's** screen, not reception's. The front desk was
split three ways: reception registers, the dispenser hands over medicine,
the cashier takes money. Create one if you have not:

```bash
npm run user:create --workspace @gementar/api -- \
  --email cashier@klinikpilot.test --name "Juruwang Aina" \
  --role CASHIER --branch KL01 --password "another-long-password"
```

- **Sign a consultation.** Open Billing: the fee is already there, RM 35
  in hours and RM 50 after six or on a Sunday. The line says which rule
  decided it.
- **Dispense something first.** The medicine is on the bill at the price
  it was dispensed at — change the product's price afterwards and the
  invoice does not move.
- **Try to edit that line.** Refused: it came from what was done, so you
  change it by undoing the dispense.
- **Undo the dispense.** The line disappears from the bill.
- **Add an item by hand** — a medical certificate from the list, or
  anything typed out with a price.
- **Discount the bill by 3%.** Fine. **Try 8%** — it asks why. **Try 15%**
  — refused, because the cashier's cap is 10%, and the message says an
  administrator has to approve it.
- **Issue it.** A number like `KL01-INV-2026-000001`, gapless per branch
  per year. Now try to change anything: refused, by the API and by the
  database.
- **Void it** (administrator, with a sentence) **and reissue.** The same
  lines come back as a new draft, the new invoice gets the next number,
  and the two point at each other. The voided number stays in the series.
- **Sell something at the counter** to a walk-up with no record — a name
  is enough.

A visit cannot be finished until its bill has been issued. It is **not**
blocked on being unpaid: nothing can take payment yet, and a guard nothing
can clear would make every visit impossible to close. That half arrives
with `v0-12-payment.md` (`BIL-OPEN-16`).

An issued invoice now prints: **Print** on the bill opens it as a stored,
numbered document. There is still no receipt, because nothing takes
payment yet (`DOC-OPEN-10`).

## Paperwork the patient takes away

Certificates, referrals and letters are issued from a **signed**
consultation and nowhere else — there is nothing to make a document out
of until the record exists (DOC-R-01), so all of this is invisible while
the note is still a draft.

Tick **They need a certificate, referral or letter** in the sign dialog
and the screen stays on the consultation after signing instead of
returning to the queue. A **Documents** card appears under the note with
three buttons.

Try the certificate. Pick two days and read the line under the dates: it
says *Covers 21 Sep 2026 — 22 Sep 2026*, because two days means today and
tomorrow, not today and the next two. That is the thing everybody gets
wrong, so the screen says it out loud rather than leaving it to be
discovered by an employer.

Then try these:

- **Issue it twice and print the second one.** The reprint carries a grey
  COPY watermark. The stored file is untouched — the watermark is added
  on the way out, so the fingerprint taken at issue still describes the
  document.
- **Cancel one.** It asks why, in a sentence, and keeps its number: a
  cancelled certificate is not a returned number, it is a spent one, and
  a gap in a certificate series is a question nobody can answer later.
  Reprint it and it comes out stamped CANCELLED in red.
- **Backdate one.** Set the start date to yesterday and the dialog asks
  why. The reason goes into the audit trail with the certificate.
  More than seven days back is refused outright.
- **Sign in as the front desk and open the patient's record.** The
  Documents tab shows the certificate but not the referral — a referral
  carries clinical detail, so it is invisible to a role without
  `clinical.read`, in the list as well as in the document.
- **Tick "Print the diagnosis".** Off by default, because the person who
  reads a certificate is usually an employer.

The patient's record has both kinds of paperwork under **Documents**:
*Issued by this clinic* on top, *Attachments* — what was brought in and
scanned — underneath. They are different things that share a word.

To charge for a certificate, create a billable item coded `DOC_MC`:

```bash
curl -sb cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"code":"DOC_MC","name":"Sijil Cuti Sakit","defaultPrice":5}' \
  http://localhost:3001/api/v1/billable-items
```

From then on every certificate puts a RM 5 line on the visit's bill.
`DOC_REFERRAL`, `DOC_LETTER` and `DOC_LAB_REQUEST` work the same way, and
no item means the document is free. There is no separate switch —
`DOC-OPEN-17`.

A doctor's signature is uploaded with `curl`, because the screen for it
is not built (`DOC-OPEN-07`):

```bash
curl -sb cookies.txt -X PUT -F file=@signature.png \
  http://localhost:3001/api/v1/me/signature
```

PNG or JPEG only, and the file is checked by its first bytes rather than
by what the browser claims it is. With nothing uploaded a certificate
prints a typed name block, which is a supported outcome rather than a
failure.

**Everything above prints from the browser, and no printer has ever been
tried** (`DOC-OPEN-01`). The A4 margins, the 80 mm receipt and the 50×30
mm label are all assumptions until somebody prints one.

## Counting the shelves

**Counts** in the sidebar. Three things live there: what needs attention,
what is worth ordering, and the counts themselves.

- **Start a cycle count.** Leave "blind" ticked — the counter does not see
  what the system expects, because a number on the sheet is a number people
  count towards. Type what is on the shelf; the difference appears only
  after you press *Done counting*.
- **Approve it** as an administrator. One adjustment per line that
  disagrees, each pointing back at the count. Look at **Stock → History**:
  the movement says `Corrected by a stock count` with the balance it left.
- **A line that agrees posts nothing.** A movement of nothing is not a
  movement.
- **Try to submit with a box left blank.** Refused — a blank is not a zero,
  and "we did not get to that shelf" and "there are none" produce very
  different adjustments.
- **Start a second count** while one is open. Refused: two people counting
  the same shelves against two frozen snapshots produce two different
  truths, and approving both applies the difference twice.
- **Open a count, then dispense something.** The expected figure does not
  move — it was frozen when the count started, so the dispense is not
  mistaken for a discrepancy.

**Opening stock from a spreadsheet.** Start an *Opening* count and attach a
CSV with `sku, batch_no, expiry, quantity, cost`. It tells you everything
wrong with the file before writing anything, and refuses the whole file
rather than importing half — a partly imported opening balance cannot be
told from a complete one afterwards.

**Alerts** appear once, when a condition starts being true. Set a reorder
level on a product (Stock → the product → its branch settings), then
dispense past it: one alert. Dispense again: still one, with the number
updated. Restock above the level and it disappears, so a later recurrence
is news again. *Seen* hides it without pretending the shelf is full.

**Worth ordering** counts days of cover from what actually left the shelf
in the last ninety days. A product nothing has moved says "not used"
rather than a number, because "it will last forever" is a lie.

**Quarantine** is what came back from a patient — off the saleable shelf,
still on the premises. It leaves in one of three directions with a reason:
back to the shelf, destroyed, or returned to the supplier. An expired batch
cannot go back.

**Try writing off more than RM 500 of stock at cost.** It asks for your
password again, before anything moves. Smaller ones do not, because most
adjustments are a box of gauze.

## The waiting-room screen

```bash
# As the administrator. There is no screen for this yet (ENC-OPEN-16).
curl -sb cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"label":"Waiting room television"}' \
  http://localhost:3001/api/v1/branches/<branchId>/display-tokens
```

It returns an address like `/display/<token>`. Open it in another window: it
needs no sign-in, shows queue numbers in very large type, chimes when a new
number is called, and reconnects by itself. It shows a first name and an
initial at most, and the clinic can turn that off on the Clinic settings
screen.

Revoking the token stops that address working immediately, which is what to
do when a screen is replaced or photographed.

## Taking money

**Drawer** in the header, first. Nothing can be taken until somebody
opens it with a float — try paying without one and the panel says so
rather than failing at the last step.

Open it with RM 200, then go to **Billing**, open a bill and issue it.
The payment panel appears underneath.

The thing to try first is the rounding:

- **Make a bill of RM 77.43 and pay it in cash.** The panel says
  **RM 77.45** and *"Rounded up by RM 0.02 — five-sen coins."* Bank
  Negara's mechanism, and the receipt shows the adjustment as its own
  line.
- **Make another for RM 77.42.** It rounds *down* to RM 77.40.
- **Now pay a RM 77.43 bill by card instead.** Exactly RM 77.43. The
  rounding belongs to the coins, not to the bill.
- **Split one.** Card RM 50.00 first, then cash for the rest. The card
  leg is exact; only the final cash leg rounds. The clinic collects two
  sen more than it billed, once — not twice.

Then the till itself:

- **Type an amount tendered** and the change appears as you type. The
  quick buttons offer the exact amount and the notes somebody is likely
  to be holding.
- **Take some cash out** — "to the safe at lunchtime" — and watch what
  is expected in the drawer drop by that much.
- **Count and close.** Type a figure and the variance appears *before*
  you commit to it, so a cashier who is short can recount. Inside RM 10
  it closes with a note; beyond it, only an administrator can, and only
  with an explanation. The expected figure is never adjusted to match
  the count — that is the whole point.
- **Print the Z-report.** Totals by method, every movement, the
  variance and the note.

And the things that go wrong:

- **Void a payment** (administrator, same day, asks for your password
  again). The invoice goes back to unpaid, the rounding goes back with
  it, and the drawer records a `VOID_OUT`.
- **Try to void one from yesterday.** Refused — use a refund, which is
  recorded as a negative payment pointing at the original. The trail
  reads as two events, because that is what happened.
- **Try to finish a visit with an unpaid bill.** Refused, naming what is
  owed. Pay it and the visit completes. This is the guard billing wrote
  and deliberately left switched off until something could clear it.

Receipts print from the browser at 80 mm. Ask for the same receipt
twice and you get the same document — not a second one claiming the
same money was taken. The first print is the handover; every one after
is stamped COPY.

**No receipt has ever come out of a printer** (`PAY-OPEN-01`). The
width, the font and whether their printer even wants HTML are all
assumptions.

## The dashboard and the reports

**Dashboard** in the header. Nine tiles, each one a link to the report
behind it.

Sign in as the doctor and then as the administrator and compare them.
The doctor sees patients, waiting, wait times, stock and unsigned notes.
The administrator sees those plus what was billed today, what was voided
and how many bills were started and never issued. The money tiles are not
greyed out for the doctor — the API never sends them, so there is nothing
on the page to reveal.

The dashboard refreshes itself. Check a patient in on another tab and
watch the counts move, at most once every five seconds however busy the
morning gets.

**Reports** lists everything this role may run.

Everything V0 promises is there now, including **Collections**, the
**End-of-day pack** and **Sales versus collections** — the three that
used to say they were waiting for payment.

Worth trying:

- **Sales versus collections.** Billed, collected, still owed, voided.
  Billed must equal collected plus outstanding, to the sen, and the
  screen says so in green when it does. It also checks the two ways of
  knowing what was collected against each other — the invoices' own
  figure and the payments themselves — which is the assertion that
  would catch a payment an invoice never heard of.
- **Collections**, grouped by method, cashier, drawer session or day.
- **Daily sales, then export it.** The CSV has every amount twice: once
  in sen, which adds up, and once as ringgit, which reads. Open it in
  Excel — the byte order mark is there so the Malay names are not
  mojibake.
- **Then look at the Audit page for `report.exported`.** It records which
  report, which dates, and whether the report names patients.
- **Discounts.** Every discount with the reason somebody typed and the
  name of whoever allowed it. Give one on a bill and watch it appear.
- **Queue performance.** Median and ninetieth-percentile waits, taken
  from the event log rather than from a column — so a patient only counts
  once somebody has actually called them.
- **Prescribing.** The antibiotic rate is shown next to the number of
  items with no drug class recorded, and the screen warns when there are
  any. With the pilot's catalogue there will be a lot: the rate is a
  floor, not a figure (`RX-OPEN-01`).
- **Stock valuation.** What is on the shelves, at cost.
- **A date range.** Everything is bucketed in the branch's own day, so a
  patient seen at 11 p.m. is on that day's report and not the next. Ask
  for more than a year and it is refused rather than run.

## The audit trail

**Audit** in the admin sidebar. Six tiles across the top, and each one is
a link rather than a statistic — click a number and the list below
filters to the entries behind it.

Things worth doing:

- **Open a patient's clinical tab as the administrator, then look at
  Break-glass access.** The count goes up. Do the same as the doctor and
  it does not: reading a record you are responsible for is routine, and
  flagging it would make the flag worthless.
- **Click a row.** It opens with the before and after side by side, with
  the changed fields picked out — the old value struck through in red,
  the new one in green — and the request id, which is the string that
  ties this entry to the application log.
- **Change a patient's telephone number, then find the entry.** The diff
  shows `phone` and nothing else, because that is all that changed.
- **Open a patient's record and look at Access history.** Every view and
  every change, in plain English, with the name of whoever made it. This
  is the view a PDPA request turns into. Only an administrator sees the
  tab at all.
- **Try to change history.** You cannot, from the application — there is
  no endpoint. From `psql`, as the database owner:

  ```sql
  UPDATE audit_log SET action = 'nothing.happened' WHERE id = '…';
  -- ERROR: AUDIT_IMMUTABLE: audit_log rows cannot be update
  ```

  The same happens for a `DELETE`, and for a write aimed straight at a
  monthly partition.
- **Export a range.** It asks for your password again, downloads a CSV
  and then records the export — filter and all — as an entry you can
  find in the list you just exported.

The table is partitioned by month, so `audit_log` is really
`audit_log_2026_09` and its neighbours:

```sql
\dt audit_log*
```

A nightly job keeps three months ahead. There is also an
`audit_log_unclaimed` partition that should always be empty; anything in
it means a month went by with no maintenance, and the job says so in the
morning log.

### Every route says whether it is audited

156 mutating routes, each carrying `@Audited('…')` or
`@NotAudited('why not')`. The build fails if a new one says neither:

```bash
npm run lint:audited --workspace @gementar/api
```

Eight routes are deliberately not audited — consultation autosave,
prescription notes, patient search, duplicate checking, MFA enrolment
before it is confirmed, blind count entry, and two personal shortcut
lists. Each reason is written in the decorator and each is a judgement
somebody could argue with.

## Bringing patients across from another system

```bash
# Nothing is written. Read the report first.
curl -sb cookies.txt -F file=@patients.csv \
  'http://localhost:3001/api/v1/patients/import?dryRun=true'
```

The first line of the file names the columns, and a column it does not
recognise is refused rather than ignored. Recognised: `name`, `id_type`,
`id_number`, `date_of_birth`, `gender`, `phone`, `email`, `address_line1`,
`address_line2`, `postcode`, `city`, `state`, `mrn`, `allergies`, `notes`.

Allergies arrive as unverified with the original wording kept in a note, so a
clinician confirms them at the patient's next visit.

## Suspending the clinic, and other platform jobs

Creating a clinic, suspending one and switching a module on are done on the
box rather than in the app, because in V0 there is no self-serve signup.

```bash
npm run tenant --workspace @gementar/api -- list
npm run tenant --workspace @gementar/api -- suspend --slug klinik-pilot --reason "Testing"
npm run tenant --workspace @gementar/api -- resume  --slug klinik-pilot
npm run tenant --workspace @gementar/api -- modules --slug klinik-pilot --on appointments
```

While suspended, everyone signed in is refused on their next request and sees
a page saying the clinic is suspended and that nothing has been deleted.
Signing in again is refused too. `resume` puts it back exactly as it was.

## Recreating or adding accounts

```bash
npm run user:create --workspace @gementar/api -- \
  --email nurse2@klinikpilot.test --name "Jururawat Aminah" \
  --role NURSE --branch KL01 --password "another-long-password"
```

`--role` takes `ADMIN`, `DOCTOR`, `NURSE`, `RECEPTION`, `DISPENSER` or
`CASHIER`, and can be repeated for someone who holds more than one. Running it again
for an existing address resets that person's password and roles. The password
must pass the same policy the application enforces: at least 12 characters and
not on a breach list.

To start over completely, drop the schema, re-run `npm run db:migrate` and
`npm run db:seed`, then recreate these six.
