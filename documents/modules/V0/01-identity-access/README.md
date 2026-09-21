# 01 · Identity & Access (IAM)

Signing in, the second factor, what each role can reach, and what
happens when somebody gets it wrong.

**Register:** [`../v0-01-identity-access-end-item-OPEN.md`](../../v0-01-identity-access-end-item-OPEN.md)

## Setup

Nothing beyond `db:seed`. Have an authenticator app on your phone —
Google Authenticator, Aegis, 1Password, Bitwarden — for the
administrator.

## Walk through

1. **Sign in as Dr Farid** (`doctor@klinikpilot.test`). Straight to the
   workspace. The page lists what this role can do; it is generated from
   the permissions, not written by hand.
2. **Sign out, sign in as Dr Aisyah** (`admin@klinikpilot.test`). She
   does not reach the workspace — she stops at MFA enrolment. Scan the
   QR, enter the six digits, and **save the ten recovery codes**. They
   are shown once.
   *Why: an administrator can read every clinical record, so a second
   factor is mandatory for that role in V0 (IAM-F-09).*
3. **Sign out and back in as Dr Aisyah.** Password, then code. Try a
   code from thirty seconds ago — refused.
4. **Compare two roles side by side.** Open a private window, sign in as
   Cik Rina (`cashier@klinikpilot.test`) in one and En Kamal
   (`dispenser@klinikpilot.test`) in the other. Cik Rina has Billing and
   Drawer; En Kamal has Pharmacy. Puan Zana has all three, because she
   holds three roles.
5. **As Dr Aisyah → Staff → add somebody.** A name, an email, a role per
   branch. Email is not connected, so the invitation link is shown on
   screen for you to hand over. Open it in a private window and set a
   password.
6. **My account → change your password.** It asks for your current one
   first, and signs out your other devices afterwards.

## Try to break it

- **Get a password wrong five times.** The sixth is refused with a
  countdown rather than another attempt. Then try a *different* account
  from the same browser — you will hit the IP limit at twenty.
  To clear it: `DELETE FROM login_attempt;`
- **Disable somebody while they are signed in.** Two windows: disable
  Cik Rina as the administrator, then click anything in her window. She
  is out, everywhere, on her next request. Her name stays on everything
  she has already done.
- **Try to disable yourself** as the only administrator. Refused. Try to
  drop your own ADMIN role. Also refused. *A clinic locking itself out
  at 6pm is worse than the inconvenience.*
- **Use a recovery code.** It works once. Use it again — refused.
- **Let a session idle for an hour.** Signed out. Twelve hours is the
  hard cap even if you are active. Both are environment settings sized
  for a shared reception computer.
- **Open an invitation link twice.** Single-use, 72 hours. A password
  reset link lasts 30 minutes.

## What is deliberately not here

- **Email does not send** (`IAM-OPEN-04`). Invitations and resets are
  links on screen. Survivable for six people; not survivable the first
  Saturday somebody is locked out.
- **There is one administrator** (`IAM-OPEN-08`). If Dr Aisyah loses her
  phone *and* her recovery codes, recovery needs a command line. Make a
  second one before go-live.
- **Argon2 is tuned too cheap** (`IAM-OPEN-02`) — 46 ms against a
  200–300 ms target, measured on a laptop. One environment variable on
  the real host.

## Notes

<!-- yours -->
