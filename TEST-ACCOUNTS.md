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

## Six patients to look at

```bash
npm run patients:seed --workspace @gementar/api
```

Adds six people to the pilot clinic, chosen so that every state worth seeing
is present at once. Running it again is safe: it brings the six up to date
rather than adding them twice, so it is also how you repair them after a
change.

| Who | Age | Worth opening because |
|---|---|---|
| Ahmad bin Zulkifli | 38 | No known allergies, recorded by a named person. Green badge. |
| Siti Nurhaliza binti Kassim | 34 | A life-threatening penicillin allergy, verified by Dr Farid. Red badge. |
| Muthu a/l Ramasamy | 51 | An allergy the counter wrote down that no clinician has confirmed. Amber, and the record says who recorded it. |
| Chan Wei Ming | 24 | Nobody has asked about allergies. Amber, and this is the state that matters most. |
| Nur Aisyah binti Ahmad | 1 mo | A newborn with no identity document, and a note saying whose baby she is. Her age reads in months, not years. |
| Rahmat Santoso | 42 | An Indonesian passport rather than a MyKad, so his date of birth had to be asked for rather than read off the card. |

Search for `ahmad`, `5533`, `012-345 6789`, or `ramasamy muthu` with the
words the wrong way round.

Two things in that table are the point of it. **Chan Wei Ming is amber and
Ahmad is green**, and the difference is that somebody asked Ahmad. A doctor
treats those two patients differently, and a system that showed both as
"no allergies" would be lying about one of them. **Muthu's allergy is amber
too**, because the counter recorded what he said and no clinician has
confirmed it; a prescriber needs to know which of those they are looking at.

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

## The waiting-room screen

```bash
# As the administrator, from the Branches screen, or:
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
