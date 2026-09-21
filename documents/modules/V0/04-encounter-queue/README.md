# 04 · Encounter & Queue (ENC)

Today's list, who is where, calling people, and the waiting-room screen.

**Register:** [`../v0-04-encounter-queue-end-item-OPEN.md`](../../v0-04-encounter-queue-end-item-OPEN.md)

## Setup

Patients seeded ([03](../03-patient/README.md)). Sign in as **Puan Zana**.

## Walk through

1. **Patients → Ahmad → Check in.** He gets a queue number and appears
   on **Today**.
2. **Today.** Columns by station: waiting for triage, in triage, waiting
   for the doctor, and so on. Check in three more people so there is
   something to look at.
3. **Open a second browser window on Today** and sign in as Dr Farid.
   Check somebody in from the first window. **The second updates within
   a second**, without a refresh — it is an SSE stream, not polling.
4. **Call the next patient** from the doctor's column. The row moves and
   the call is counted.
5. **Call the same person again.** The count goes up. A patient called
   three times is a patient who has gone to the toilet, and the number
   is what tells the front desk to go and look.
6. **Skip somebody.** They go to the back but keep their number.
7. **Mark somebody a no-show**, with a reason. Then **revert it** — they
   came back.
8. **Issue a display token.** There is no screen for this yet
   (`ENC-OPEN-16`), so as the administrator:
   ```bash
   curl -sb cookies.txt -X POST -H 'Content-Type: application/json' \
     -d '{"label":"Waiting room television"}' \
     http://localhost:3001/api/v1/branches/<branchId>/display-tokens
   ```
   It returns an address like `/display/<token>`. Open it in a private
   window: that is the waiting-room screen — numbers in very large
   type, a first name at most, no clinical detail, no sign-in.
9. **Call somebody** and watch the waiting-room screen change.

## Try to break it

- **Check the same patient in twice.** Refused — they already have an
  open visit.
- **Try to send somebody from "waiting for triage" straight to
  "completed".** Refused, and the message lists what *is* allowed from
  where they are. The state machine is a table, not a set of ifs.
- **Try to complete a visit with an unissued bill.** Refused
  (`invoice_not_issued`). **Now issue the bill and try again** —
  refused again (`balance_outstanding`), because payment registered the
  second guard. Pay it and it completes. See [11](../11-billing/README.md) and
  [12](../12-payment/README.md).
- **As the administrator, force a stuck visit.** It works, and it is
  audited as a *forced* transition rather than a normal one.
- **Set a priority** on somebody — elderly, or in pain. They move up
  their column and the reason is recorded.
- **Revoke the display token** (`DELETE /display-tokens/<id>`) and
  watch the waiting-room screen stop. That is what to do when a screen
  is replaced or photographed.

## What is deliberately not here

- **Nobody has run a real morning on it** (`ENC-OPEN-13`,
  `ENC-OPEN-14`). The queue board was built for a clinic seeing three
  hundred people a day and has only ever had four rows on it.
- **Wait times are measured but not shown on the board** — they are in
  the queue-performance report ([15](../15-reporting-dashboard/README.md)).

## Notes

<!-- yours -->
