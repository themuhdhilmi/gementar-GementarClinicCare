# Test accounts

Accounts for trying the system out on the **development database**. They exist
in the `klinik-pilot` tenant at branch `KL01` (Cawangan Cheras).

> **Not for production.** These passwords are written down in a file in the
> repository, which means they are not secrets. Before the clinic goes live,
> create real accounts through the Staff screen, let each person set their own
> password from their invitation link, and delete these.

Sign in at **http://localhost:3000/login** after starting the app with
`npm run dev`.

All four use the same password:

```
ujian-klinik-2026-selamat
```

| Email | Name | Role | At sign-in |
|---|---|---|---|
| `doctor@klinikpilot.test` | Dr Farid | Doctor | Straight to the workspace |
| `nurse@klinikpilot.test` | Jururawat Mei | Nurse | Straight to the workspace |
| `frontdesk@klinikpilot.test` | Puan Zana | Front desk | Straight to the workspace |
| `admin@klinikpilot.test` | Dr Aisyah | Administrator | Stops at MFA enrolment first |

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

| | Doctor | Nurse | Front desk | Administrator |
|---|:-:|:-:|:-:|:-:|
| Permissions at this branch | 24 | 14 | 20 | 34 |
| Staff tab | – | – | – | ✓ |
| Audit tab | – | – | – | ✓ |
| Write clinical notes | ✓ | – | – | – |
| Take payment | – | – | ✓ | ✓ |
| Read clinical notes | ✓ | ✓ | – | ✓ break-glass |

## Worth trying

- **Sign in as the doctor, then as the front desk.** The workspace lists exactly
  what that role can do; neither sees the Staff or Audit tabs.
- **As the administrator, add a person.** The drawer takes a name, an email and
  a role per branch. Email is not connected yet, so the invitation link is shown
  on screen for you to hand over.
- **Disable someone while they are signed in.** Their next request fails and
  they are signed out everywhere, in the same moment. Their name stays on
  everything they have already done.
- **Read clinical data as the administrator.** It is allowed, and it appears on
  the Audit page as a break-glass entry. A doctor doing the same thing is
  routine and is not flagged.
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

- **Signed out after a while.** Sessions idle out after 12 hours and expire
  after 7 days regardless.
- **An invitation link that no longer works.** They are single-use and last 72
  hours; password reset links last 30 minutes.
- **The administrator cannot disable themselves,** and cannot drop their own
  ADMIN role while they are the only administrator. A clinic locking itself out
  at 6pm is a worse outcome than the inconvenience.

## Recreating or adding accounts

```bash
npm run user:create --workspace @gementar/api -- \
  --email nurse2@klinikpilot.test --name "Jururawat Aminah" \
  --role NURSE --branch KL01 --password "another-long-password"
```

`--role` can be repeated for someone who holds more than one. Running it again
for an existing address resets that person's password and roles. The password
must pass the same policy the application enforces: at least 12 characters and
not on a breach list.

To start over completely, drop the schema, re-run `npm run db:migrate` and
`npm run db:seed`, then recreate these four.
