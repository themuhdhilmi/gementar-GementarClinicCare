# 10 · Procedures (PRC)

Ordering something done, recording that it was, and the stock it used
up.

**Register:** [`../v0-10-procedures-end-item-OPEN.md`](../../v0-10-procedures-end-item-OPEN.md)

## Setup

```bash
npm run procedures:seed --workspace @gementar/api
npm run catalogue:seed  --workspace @gementar/api
```

Sign in as **Dr Farid** to order, **Jururawat Mei** to perform.

## Walk through

1. **In a consultation, the Procedures panel** sits beside the
   prescription — ordered from the plan, the same way medicines are.
2. **Search and add one.** Category chips, price on every row. Two
   keystrokes, not a form.
3. **Sign the consultation.** The order stands.
4. **As the nurse → Procedures.** The list of what is waiting.
5. **Perform one.** Record who did it, when, and anything about it.
6. **Look at the stock** ([09](../09-inventory/README.md)) for whatever that
   procedure consumes. It came off the shelf automatically, as
   `CONSUME` movements.
7. **A charge appeared on the bill** ([11](../11-billing/README.md)) at the
   procedure's price.
8. **Record a vaccination.** Vaccine, batch, expiry, site, who gave it.
   It shows on the patient's record.

## Try to break it

- **Cancel an ordered procedure** before it is done. Clean.
- **Void a performed one**, with a reason. The consumables go back as
  reversal movements and the charge is removed. Both are recorded;
  neither is an edit.
- **Perform a procedure whose consumables are out of stock.** Worth
  poking at — note below what happens and whether it is what a nurse
  would want.
- **Retire a procedure from the catalogue** that has been ordered. The
  order stands; only new ones are blocked.
- **Change the price** of a catalogue item after a procedure was
  performed. The charge keeps the price it was performed at, not
  today's.

## What is deliberately not here

- **The consumable mappings are guesses** (`PRC-OPEN-01`). **A
  production blocker**, and it degrades unpleasantly: a dressing mapped
  to two gauze swabs when the nurse uses six drifts the count by four
  *every time*, and a wrong number gets believed where a known gap gets
  counted.
- **No procedure admin screen** (`PRC-OPEN-10`) — and this is the one
  to build first, not because it blocks anything but because editing
  consumable mappings *is* the session that closes `PRC-OPEN-01`, and
  doing that through `curl` with a nurse watching is a bad hour.
- **No printable immunisation record** (`PRC-OPEN-09`, `DOC-OPEN-12`).
  The data is complete — vaccine, batch, expiry, site, who, when. The
  card a parent carries does not exist.

## Notes

<!-- yours -->
