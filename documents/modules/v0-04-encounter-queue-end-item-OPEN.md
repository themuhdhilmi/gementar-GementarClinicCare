# Encounter & Queue — open end items

Everything about `ENC` that is **not finished, not provable here, or waiting
on somebody else**. The module specification says what was built; this says
what is still owed, and how each one will be known to be done.

`ENC-OPEN-01` is the one to deal with before the pilot sees this, because it
needs hardware that has to be bought.

| | |
|---|---|
| **Module** | [v0-04-encounter-queue.md](v0-04-encounter-queue.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. Needs the clinic's own hardware

| # | Item | Done when |
|---|---|---|
| **ENC-OPEN-01** | **ENC-T-12 and ENC-N-04: the display has never run for twelve hours on a television.** It is built, it reconnects by itself, and nothing in it accumulates by design — the view is replaced wholesale, the clock is one interval, the chime closes its audio context. None of that is the same as having watched it run a full clinic day on the actual screen, in the actual browser, at the actual distance. **This is the item most likely to embarrass the pilot**, because it fails in the waiting room in front of patients. | A television and a stick PC are in the clinic, the page has been left running from open to close, and somebody has confirmed at the end of the day that it is still connected, still updating, and still legible from the furthest seat. Depends on the answer to `ENC-Q-05`. |
| **ENC-OPEN-02** | **ENC-T-07 is only half proved.** The display payload is tested to carry no name, no identity number and no patient id. What is not tested is the one-second delivery: an automated test of server-sent events needs a real browser, and the suite runs in Node. | Either a browser-level test exists, or two screens are opened side by side at the pilot and somebody watches a transition appear on both. The second is cheaper and proves more. |
| **ENC-OPEN-03** | **ENC-N-05: five hundred concurrent streams, untested.** The fan-out is in-process and holds no database connection, so the arithmetic says it is fine. Nobody has run it. A single branch needs perhaps ten. | Either load-tested, or consciously accepted as far beyond what one clinic can generate. Revisit when a second branch exists, which is also when `ENC-OPEN-08` becomes real. |

## B. Built but not yet exercised

| # | Item | Done when |
|---|---|---|
| ~~**ENC-OPEN-04**~~ | ~~**Nothing registers a completion guard.**~~ **Closed 2026-09-21.** `CON` registers an unsigned-consultation check, so a visit cannot be finished while the doctor has not signed. `RX` and `BIL` still owe theirs, tracked as `ENC-OPEN-15`. | Done. |
| ~~**ENC-OPEN-15**~~ | ~~**Undispensed medicine and an unpaid balance do not block completion.**~~ **Closed 2026-09-21.** All three guards are registered: `CON` for an unsigned note, `DSP` for medicine not handed over, `PRC` for a procedure not done, and `BIL` for a bill unissued or unpaid. The registry has one check in it. The two branch settings that switch these guards on and off are built and tested against a planted check. **Updated 2026-09-21:** `RX` was built and deliberately did *not* register the medicine check. A guard nothing can satisfy is a trap — with no dispensing module, every prescribed visit would become impossible to finish. It belongs with the module that can clear it. | Done. |
| **ENC-OPEN-05** | **The eight queue settings have never been discussed with the clinic.** Triage policy, payment order, the two completion guards, display privacy, the amber and red thresholds, and how many calls before a no-show is suggested. Every default is a guess. | Read through with whoever runs the clinic, and changed or confirmed on the settings screen. A board that is entirely red because the thresholds are wrong for this clinic is a board nobody looks at. |
| **ENC-OPEN-06** | **No printed queue ticket (`ENC-Q-06`).** The number is shown on screen at check-in. A clinic whose patients are used to taking a paper slip will ask for one. | Asked. If they want it, it is a small piece of work and a receipt printer, and it belongs with `DOC`. |
| **ENC-OPEN-16** | **There is no screen for display tokens.** Issuing one, listing them and revoking one all work and are administrator-only; none has a button, so setting up a waiting-room television means `curl` and revoking a compromised one means `curl` in a hurry. The second is the one that matters: the reason to revoke is that a screen was photographed or replaced, and that is not a moment for a terminal. | A block on the branch screen: issue, list with their labels and last-seen times, revoke. Small, and it should exist before a television does. |
| **ENC-OPEN-07** | **The follow-up flag is stored and shown nowhere (`ENC-F-14`).** A Should. The column and the route exist; the patient record does not display it. | Either surfaced on the patient record, or deferred to `APT` in V1, which is where it is actually useful. Decide rather than leave it half-done. |

## C. Waiting on another module

| # | Item | Lands with |
|---|---|---|
| **ENC-OPEN-08** | **Live updates do not cross processes.** The fan-out is in-process, which is right while one process serves one clinic. A second process would mean a board that misses events from the other one. | `v2-01-multi-branch.md`, using PostgreSQL LISTEN/NOTIFY, as §19 says. Until then, **do not run two API processes**, because the failure is silent: boards simply stop updating for half the staff. |
| **ENC-OPEN-09** | **Nothing consumes the events this module publishes.** `encounter.status_changed`, `encounter.completed` and the rest are published and audited, and no module listens yet. | `TRI`, `CON`, `RX`, `DSP`, `BIL` and `PAY` each consume the ones §9 lists. Also `PAT-OPEN-07`: `encounter.completed` is what keeps the last-visit column in patient search current, and nothing updates it today. |
| **ENC-OPEN-11** | **The patient header is used by two screens, not five.** Reused correctly on the encounter chart, which is `PAT-OPEN-06` half closed. | `TRI`, `CON`, `RX` and `DSP` each import it rather than building their own. |
| **ENC-OPEN-12** | **`encounter_event` grows without limit.** ENC-N-06 wants monthly partitioning at five million rows. At three hundred visits a day and perhaps eight events each, that is roughly six years away. | Partitioned when the row count passes a million, or with `v0-14-audit-trail.md`, which has the same problem and should solve both the same way. |

## D. Worth doing while the clinic is watching

| # | Item | Done when |
|---|---|---|
| **ENC-OPEN-13** | **Nobody has run a whole day on it.** §18 asks for three days in parallel with the whiteboard before the whiteboard goes. That is not a test, it is the rollout, and it is where the things nobody thought of turn up. | Three full days run in parallel, the differences between board and whiteboard written down each evening, and the whiteboard retired on the clinic's say-so rather than ours. |
| **ENC-OPEN-14** | **The keyboard shortcuts have only been used by their author.** `Space` calls the next patient from anywhere on a station board. That is either the best thing on the screen or an accident waiting to happen, depending on whether staff rest anything on the keyboard. | Watched during training. If it fires by accident even once, put it behind a modifier. |

---

## Closed on 2026-09-21

Kept so the list reads as a history rather than only a backlog.

- The per-request transaction interceptor could not have carried a streaming
  route: it takes the first value from the handler and unsubscribes, which
  would close the connection after one event, and it would have held a
  database transaction open for as long as a waiting-room screen was on.
  `@NoRequestTransaction` is the opt-out, and it requires a stated reason.
- Emergencies had their own numbering series, and the first emergency of the
  day collided with the first ordinary patient on the encounter number. One
  counter per branch per day, with the letter as display only.
- The recovery hatch was blocked by its own backstop: forcing a stuck visit
  to closed is exactly what an administrator needs, and the database trigger
  refused it. The recovery moves are now in both lists, and a test compares
  them so they cannot drift apart.
- A patient called by mistake now keeps their place in the queue.
- `TEN-OPEN-01`, open since v0-02: a branch with patients still in its queue
  can no longer be deactivated. Encounter registers the check on start-up,
  which keeps the dependency pointing the right way — branches know nothing
  about encounters.
