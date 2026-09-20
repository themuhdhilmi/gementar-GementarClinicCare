# Triage — open end items

Everything about `TRI` that is **not finished or not decided here**. Short,
because the module is small and most of it is done.

`TRI-OPEN-01` is a clinical decision, not a coding task, and it should
happen in the same conversation as the queue settings.

| | |
|---|---|
| **Module** | [v0-05-triage.md](v0-05-triage.md) |
| **Opened** | 2026-09-21 |
| **Last reviewed** | 2026-09-21 |

---

## A. Needs the clinic's doctor

| # | Item | Done when |
|---|---|---|
| **TRI-OPEN-01** | **Nobody has agreed the thresholds, and the paediatric ones are not even settings (TRI-Q-01).** The adult bands are tenant settings with defaults taken from the specification; those defaults are a starting point for a general practice, not a clinical standard, and no doctor has looked at them. The paediatric bands are constants in `vitals.ts`. That asymmetry is deliberate — inventing paediatric settings nobody has agreed would look like a decision had been made — but it is a gap. **A threshold that is wrong in the tolerant direction misses a sick patient; one that is wrong the other way trains everybody to ignore the colour.** | Twenty minutes with the clinic's doctor over the table in §5. The adult numbers are confirmed or changed on the settings screen. The paediatric bands are either confirmed as they stand, or moved into settings once there is an agreed set to put there. |
| **TRI-OPEN-02** | **Nobody has timed a real nurse (TRI-N-02, and the 45-second target).** The form is one column in the order readings are taken, with strict tab order and fixed units, and it has only ever been used by its author. Whether it is quick with a patient standing there is a different question. | Watched during shadowing, with a stopwatch. If it is slow, the fix is almost certainly the order of the fields or the number of them, and both are cheap to change. Also settles TRI-Q-02: a nurse tabbing on a desktop and one tapping on a tablet with gloves are different sessions. |

## B. Built but not yet exercised

| # | Item | Done when |
|---|---|---|
| **TRI-OPEN-03** | **Nothing locks a triage record.** `lockForEncounter` exists and is tested, and the only thing that should call it is the consultation being signed, which does not exist. Until then every record stays editable. | `v0-06-consultation.md` calls it on signing, and consumes `consultation.signed` as §9 describes. |
| **TRI-OPEN-04** | **The trend is an endpoint with no chart (TRI-F-09).** A Could. The data comes back; nothing draws it. | Either a sparkline beside each field, or closed as not worth it. Worth deciding rather than leaving half-built — it is most useful in the consultation, so decide it there. |
| **TRI-OPEN-05** | **Weight is not yet used for dosing.** §14 says prescribing shows the weight beside the dose for a patient under twelve, and reads it from the latest triage. | `v0-07-prescription.md` reads the latest triage weight and displays it. Check it there. |

## C. Deliberately not done

| # | Item | Why |
|---|---|---|
| **TRI-OPEN-06** | **No recomputation of historical flags.** Changing a threshold leaves every existing record exactly as it was (TRI-R-03), and there is no tool to rewrite them. | What a nurse saw and acted on is the record. A tool that rewrote it would make the trail a fiction. If a clinic ever genuinely needs to re-review old readings against new bands, that is a report, not an update. |

---

## Closed on 2026-09-21

- An implausible reading answers 422 with a sentence a nurse can act on,
  rather than 400 naming a field and a limit. The validation bounds on the
  request object were widened so the service's message is the one that
  reaches the screen.
- Body mass index is refused outright if a client sends it, rather than
  being quietly ignored: a client that sends it has misunderstood.
