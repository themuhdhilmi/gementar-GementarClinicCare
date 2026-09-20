# Threat model — login, password reset, MFA

Scope: the three flows an attacker actually attacks. Written as part of the
definition of done for `v0-01-identity-access.md`. Half a page was the brief;
this is a little over, because the reset flow deserves its own paragraph.

## What we are protecting

One clinic's staff logins. Behind them: every patient's clinical record, every
prescription, and the ability to void money. The realistic attacker is not a
state actor. It is credential stuffing from a botnet, a phishing page aimed at a
receptionist, and a departed employee who still knows a password.

## Login

| Threat | Control | Residual risk |
|---|---|---|
| Credential stuffing | 5 failures per email and 20 per IP per 15 minutes, both from a durable table so a restart does not reset them; lockout after 10 consecutive failures | A slow, distributed attack under both thresholds is not stopped. Accepted for V0; the failed-login dashboard is how it gets noticed. |
| User enumeration | Identical status, body and message for unknown email, wrong password, locked, disabled and not-yet-invited; a decoy Argon2 verify runs when there is no user, so timing matches | Response time still varies with load. Not a practical oracle. |
| Offline cracking after a database theft | Argon2id, per-password salt, parameters tuned to the host; only hashes are stored | A weak passphrase still falls. Hence the breach-list check at the point of choosing. |
| Password spraying one common password across many accounts | Breached-password rejection at set time; per-IP limit | An attacker with many IPs and one password per account per window gets through the limits. Same mitigation as above: it is visible. |
| Stolen session cookie | `httpOnly`, `Secure`, `SameSite=Lax`; 12-hour idle and 7-day absolute lifetimes; the user can see and revoke sessions; an administrator can revoke all | A cookie stolen and used immediately, from the same network, is indistinguishable from the user. V3 adds optional IP and user-agent binding. |
| CSRF | `SameSite=Lax` plus an `Origin` check on every mutating request | A same-site subdomain takeover would defeat both. There are no other subdomains on the app origin. |
| Privilege confusion after a role change | Sessions carry a permission version; a change bumps it and permissions reload on the next request; the active branch is re-validated every request, not only when switched | A request already in flight completes with the old permissions. Bounded by one request. |

## Password reset

The dangerous flow, because it grants access with no password at all.

- Tokens are 256 bits of randomness; only a SHA-256 hash is stored, so a stolen
  database cannot be replayed into account takeover.
- Reset tokens live 30 minutes, invite tokens 72 hours. Both are single-use, and
  single-use is enforced by a conditional update (`used_at IS NULL`), not by a
  read-then-write, so two simultaneous requests cannot both consume one.
- Consuming a token sets the password, revokes **every** session for that user
  and invalidates every other outstanding token — all in one transaction. A
  half-completed reset would be the worst of both worlds.
- The request endpoint always answers `202` with the same body, and caps a user
  to three tokens per 15 minutes, so it cannot be used to confirm who exists or
  to flood an inbox.
- **Weakest link: the mailbox.** Anyone with access to a staff email account can
  take over that account. Nothing in this system can fix that; it is the reason
  MFA is mandatory for administrators, since a second factor survives a
  compromised mailbox.

## Multi-factor authentication

- TOTP, RFC 6238, ±1 step for clock skew. Every accepted code's time step is
  recorded, so the same code cannot be used twice — this closes the window where
  a phished code is replayed seconds later.
- Secrets and recovery codes are encrypted with AES-256-GCM under a key held
  outside the database, and the ciphertext is bound to the user id as additional
  authenticated data, so a blob copied between rows will not decrypt.
- Recovery codes are stored as peppered hashes inside that ciphertext and are
  consumed individually.
- Enrolment and disabling need a re-authentication no older than 5 minutes.
  Signing in with a password counts as one, which is what lets a new
  administrator enrol immediately without typing the password twice.
- **What TOTP does not stop:** a real-time phishing proxy that relays the code
  the moment it is typed. WebAuthn is the answer to that and is V3 (`SEC`).
- Administrators can reset a user's MFA after verifying identity out of band.
  That is a deliberate back door for the lost-phone case; it revokes all
  sessions and is audited, because it is exactly the step an attacker would try
  to talk someone into taking.

## Trusted devices

"Remember this device" skips the second factor for 30 days, never the first. The
device token is 256 bits, stored hashed, revocable, and cleared whenever MFA is
reset or the user is disabled. On a shared clinic workstation it should not be
used, which is a training point rather than a technical one — and it is also
`IAM-Q-02`, still open with the pilot.

## Things deliberately left undone in V0

- No WebAuthn, no SSO. Both are V3.
- No IP allow-listing, no device binding. V3.
- No anomaly detection. The failed-login and break-glass counters on the audit
  dashboard are the manual version, and for one clinic that is the right size.
- Break-glass is *allowed*, not blocked: an administrator can read clinical data,
  and every such read is recorded. Blocking it would create a worse failure mode,
  where the only person who can fix a problem at 2am cannot see the problem.
