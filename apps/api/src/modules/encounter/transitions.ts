import { EncounterStatus } from '../../generated/prisma/enums.js';

/**
 * Every legal move an encounter can make, in one table (§6, ENC-R-01).
 *
 * One table, consulted by one function, is the whole design. The alternative
 * — a status check scattered through each screen's handler — is how a clinic
 * ends up with a patient who is somehow in the pharmacy queue and also in
 * consultation, and nobody can say which line of code let it happen.
 *
 * A database trigger enforces the same table as a backstop, for anything
 * that writes the column without coming through here (ENC-T-10). The two
 * lists are deliberately separate: this one knows about branch settings and
 * about who is asking, and the trigger knows neither, so the trigger is the
 * looser of the two. A backstop that was stricter than the rule it backs up
 * would refuse work that is legitimately allowed.
 */

export type Station =
  | 'reception'
  | 'triage'
  | 'doctor'
  | 'pharmacy'
  | 'cashier'
  | 'procedure'
  /**
   * One counter doing both dispensing and payment (ENC-F-15).
   *
   * Not a state a visit is ever *in* — it is a **view** over the two
   * lines that a single person serves, which is how most small
   * Malaysian clinics run: the patient leaves the doctor's room and
   * goes to one window for medicine and the bill together. The
   * statuses underneath are unchanged, so nothing about the record
   * depends on how the counter happens to be staffed.
   */
  | 'counter';

export type TransitionRule = {
  from: EncounterStatus;
  to: EncounterStatus;
  /** What this move is called on the screen that offers it. */
  label: string;
  /** Which board it belongs to, for the "call next" button. */
  station: Station;
  /** Explains itself to whoever is refused it. */
  note?: string;
  /**
   * A move *backwards*, to a step the visit has already been through.
   *
   * Every station needs one. A pharmacist who reads a dose that cannot
   * be right, a nurse who called the wrong name, a cashier looking at a
   * bill for a procedure that did not happen — each of them has to be
   * able to put the patient back where the problem can be fixed. The
   * alternative is a telephone call and somebody editing the database,
   * which is how a queue and a record start disagreeing.
   *
   * Flagged rather than inferred, because "backwards" is a fact about
   * the clinic's workflow and not about the order of an enum.
   */
  back?: boolean;
  /**
   * The move is refused without a written reason.
   *
   * Sending somebody back is the move that gets asked about afterwards
   * — by the patient, by the doctor, occasionally by a regulator. An
   * unexplained jump backwards in a timeline is worse than no record of
   * it at all, because it looks like a mistake nobody owned.
   */
  requiresReason?: boolean;
  /**
   * Only reachable through `force-transition`, by an administrator, with a
   * reason, and logged loudly.
   *
   * These are not part of the clinic's day. They exist because a visit can
   * get stuck — a module that never fired, a patient who walked out
   * mid-consultation — and the alternative to a recorded override is
   * somebody editing the database.
   */
  forceOnly?: boolean;
};

const S = EncounterStatus;

export const ENCOUNTER_TRANSITIONS: readonly TransitionRule[] = [
  // Reception. Which of these two is offered depends on the branch's triage
  // policy (ENC-F-05); both are legal moves.
  {
    from: S.REGISTERED,
    to: S.TRIAGE_WAITING,
    label: 'Send to triage',
    station: 'reception',
  },
  {
    from: S.REGISTERED,
    to: S.DOCTOR_WAITING,
    label: 'Send straight to the doctor',
    station: 'reception',
  },

  // Triage.
  {
    from: S.TRIAGE_WAITING,
    to: S.TRIAGE_IN_PROGRESS,
    label: 'Start triage',
    station: 'triage',
  },
  {
    from: S.TRIAGE_IN_PROGRESS,
    to: S.DOCTOR_WAITING,
    label: 'Send to the doctor',
    station: 'triage',
  },

  // Consultation.
  {
    from: S.DOCTOR_WAITING,
    to: S.IN_CONSULTATION,
    label: 'Start consultation',
    station: 'doctor',
  },
  {
    from: S.IN_CONSULTATION,
    to: S.DOCTOR_WAITING,
    label: 'Return to the queue',
    station: 'doctor',
    back: true,
    note: 'For a patient called by mistake. Their place in the queue is kept.',
  },
  {
    from: S.IN_CONSULTATION,
    to: S.PROCEDURE_WAITING,
    label: 'Send for a procedure',
    station: 'doctor',
  },
  {
    from: S.IN_CONSULTATION,
    to: S.PHARMACY_WAITING,
    label: 'Send to the pharmacy',
    station: 'doctor',
  },
  {
    from: S.IN_CONSULTATION,
    to: S.PAYMENT_WAITING,
    label: 'Send to pay',
    station: 'doctor',
  },
  {
    from: S.IN_CONSULTATION,
    to: S.COMPLETED,
    label: 'Finish, nothing to pay',
    station: 'doctor',
    note: 'Only when there is no prescription and nothing to charge for.',
  },

  // Procedures.
  {
    from: S.PROCEDURE_WAITING,
    to: S.PROCEDURE_DONE,
    label: 'Procedure done',
    station: 'procedure',
  },
  {
    from: S.PROCEDURE_DONE,
    to: S.PHARMACY_WAITING,
    label: 'Send to the pharmacy',
    station: 'procedure',
  },
  {
    from: S.PROCEDURE_DONE,
    to: S.PAYMENT_WAITING,
    label: 'Send to pay',
    station: 'procedure',
  },
  {
    from: S.PROCEDURE_DONE,
    to: S.COMPLETED,
    label: 'Finish',
    station: 'procedure',
  },

  // Dispensing and payment. Both orders appear here because the branch
  // setting decides which one a clinic runs, and both are real (ENC-F-10).
  {
    from: S.PHARMACY_WAITING,
    to: S.DISPENSING,
    label: 'Start dispensing',
    station: 'pharmacy',
  },
  {
    from: S.DISPENSING,
    to: S.PAYMENT_WAITING,
    label: 'Send to pay',
    station: 'pharmacy',
  },
  { from: S.DISPENSING, to: S.COMPLETED, label: 'Finish', station: 'pharmacy' },
  {
    from: S.PAYMENT_WAITING,
    to: S.PHARMACY_WAITING,
    label: 'Send to the pharmacy',
    station: 'cashier',
  },
  {
    from: S.PAYMENT_WAITING,
    to: S.COMPLETED,
    label: 'Finish',
    station: 'cashier',
  },

  /**
   * Sending somebody back (ENC-F-24).
   *
   * All of these land on `DOCTOR_WAITING` rather than `IN_CONSULTATION`:
   * putting a patient straight into consultation would assert that the
   * doctor is with them, which is not true — the doctor is with somebody
   * else. They go into the doctor's line, which is what happens in the
   * corridor.
   */
  {
    from: S.TRIAGE_IN_PROGRESS,
    to: S.TRIAGE_WAITING,
    label: 'Back to the triage queue',
    station: 'triage',
    back: true,
    note: 'For a patient called by mistake.',
  },
  {
    from: S.PROCEDURE_WAITING,
    to: S.DOCTOR_WAITING,
    label: 'Back to the doctor',
    station: 'procedure',
    back: true,
    requiresReason: true,
    note: 'When the procedure cannot be done as it was ordered.',
  },
  {
    from: S.PROCEDURE_DONE,
    to: S.DOCTOR_WAITING,
    label: 'Back to the doctor',
    station: 'procedure',
    back: true,
    requiresReason: true,
    note: 'When the doctor needs to see the result before the patient leaves.',
  },
  {
    from: S.PHARMACY_WAITING,
    to: S.DOCTOR_WAITING,
    label: 'Back to the doctor',
    station: 'pharmacy',
    back: true,
    requiresReason: true,
    note: 'A query on the prescription: the dose, an interaction, or nothing on the shelf.',
  },
  {
    from: S.DISPENSING,
    to: S.PHARMACY_WAITING,
    label: 'Back to the pharmacy queue',
    station: 'pharmacy',
    back: true,
    note: 'For a patient called to the counter by mistake.',
  },
  {
    from: S.DISPENSING,
    to: S.DOCTOR_WAITING,
    label: 'Back to the doctor',
    station: 'pharmacy',
    back: true,
    requiresReason: true,
    note: 'A query found while dispensing. Anything already handed over stays on the record.',
  },
  {
    from: S.PAYMENT_WAITING,
    to: S.DOCTOR_WAITING,
    label: 'Back to the doctor',
    station: 'cashier',
    back: true,
    requiresReason: true,
    note: 'When something on the bill has to be settled by the doctor.',
  },

  // Leaving before being seen.
  {
    from: S.REGISTERED,
    to: S.CANCELLED,
    label: 'Cancel',
    station: 'reception',
  },
  {
    from: S.TRIAGE_WAITING,
    to: S.CANCELLED,
    label: 'Cancel',
    station: 'reception',
  },
  {
    from: S.TRIAGE_IN_PROGRESS,
    to: S.CANCELLED,
    label: 'Cancel',
    station: 'triage',
  },
  {
    from: S.DOCTOR_WAITING,
    to: S.CANCELLED,
    label: 'Cancel',
    station: 'reception',
  },
  {
    from: S.TRIAGE_WAITING,
    to: S.NO_SHOW,
    label: 'Did not answer',
    station: 'triage',
  },
  {
    from: S.DOCTOR_WAITING,
    to: S.NO_SHOW,
    label: 'Did not answer',
    station: 'doctor',
  },
  {
    from: S.PHARMACY_WAITING,
    to: S.NO_SHOW,
    label: 'Did not answer',
    station: 'pharmacy',
  },
  {
    from: S.PAYMENT_WAITING,
    to: S.NO_SHOW,
    label: 'Did not answer',
    station: 'cashier',
  },

  // Coming back, and putting a mistake right.
  {
    from: S.NO_SHOW,
    to: S.DOCTOR_WAITING,
    label: 'They came back',
    station: 'reception',
    note: 'Same day only.',
  },
  {
    from: S.COMPLETED,
    to: S.PAYMENT_WAITING,
    label: 'Reopen at payment',
    station: 'reception',
  },
  {
    from: S.COMPLETED,
    to: S.PHARMACY_WAITING,
    label: 'Reopen at the pharmacy',
    station: 'reception',
  },
  {
    from: S.COMPLETED,
    to: S.IN_CONSULTATION,
    label: 'Reopen the consultation',
    station: 'reception',
  },
];

/**
 * ENC-R-09 and §14: the recovery hatch.
 *
 * A visit cannot be cancelled once the consultation has begun — that is the
 * rule, and it is right, because clinical work has happened and something
 * has to account for it. But a patient who walks out halfway through still
 * has to be got off the board somehow, and the answer is an administrator
 * saying so in writing rather than an UPDATE at a psql prompt.
 */
const RECOVERABLE_FROM: readonly EncounterStatus[] = [
  S.IN_CONSULTATION,
  S.PROCEDURE_WAITING,
  S.PROCEDURE_DONE,
  S.PHARMACY_WAITING,
  S.DISPENSING,
  S.PAYMENT_WAITING,
  S.REGISTERED,
  S.TRIAGE_WAITING,
  S.TRIAGE_IN_PROGRESS,
  S.DOCTOR_WAITING,
];

export const RECOVERY_TRANSITIONS: readonly TransitionRule[] =
  RECOVERABLE_FROM.flatMap((from) =>
    [S.CANCELLED, S.COMPLETED]
      .filter(
        (to) =>
          !ENCOUNTER_TRANSITIONS.some((r) => r.from === from && r.to === to),
      )
      .map((to) => ({
        from,
        to,
        label: to === S.CANCELLED ? 'Abandon this visit' : 'Close this visit',
        station: 'reception' as Station,
        forceOnly: true,
        note: 'Administrator only. The reason is recorded and shown on the audit screen.',
      })),
  );

export const ALL_TRANSITIONS: readonly TransitionRule[] = [
  ...ENCOUNTER_TRANSITIONS,
  ...RECOVERY_TRANSITIONS,
];

/** Statuses an encounter can no longer move on from by itself. */
export const TERMINAL_STATUSES: readonly EncounterStatus[] = [
  S.COMPLETED,
  S.CANCELLED,
  S.NO_SHOW,
];

/** Statuses that still count as an open visit, for ENC-R-06 and the boards. */
export const OPEN_STATUSES: readonly EncounterStatus[] = Object.values(
  S,
).filter((status) => !TERMINAL_STATUSES.includes(status));

/** Which board a waiting encounter appears on (ENC-F-15). */
export const STATION_STATUSES: Readonly<
  Record<Station, readonly EncounterStatus[]>
> = {
  reception: OPEN_STATUSES,
  triage: [S.TRIAGE_WAITING],
  doctor: [S.DOCTOR_WAITING],
  procedure: [S.PROCEDURE_WAITING],
  pharmacy: [S.PHARMACY_WAITING, S.DISPENSING],
  cashier: [S.PAYMENT_WAITING],
  counter: [S.PHARMACY_WAITING, S.DISPENSING, S.PAYMENT_WAITING],
};

/**
 * Stations that are a way of looking at the board rather than a place a
 * visit can be. `stationOf` must never return one, or a call would be
 * routed to a view instead of to a queue.
 */
export const VIEW_STATIONS: ReadonlySet<Station> = new Set([
  'reception',
  'counter',
]);

/**
 * What "call next" moves a patient into at each station. Reception has no
 * such button: it is the board that sees everything, not a queue of its own.
 */
export const STATION_CALL_TARGET: Readonly<
  Partial<Record<Station, EncounterStatus>>
> = {
  triage: S.TRIAGE_IN_PROGRESS,
  doctor: S.IN_CONSULTATION,
  pharmacy: S.DISPENSING,
  procedure: S.PROCEDURE_DONE,
};

/**
 * Where calling the next patient moves them, when the station serves
 * more than one line.
 *
 * A combined counter has two queues in front of it and they do not move
 * the same way: somebody waiting for medicine goes into dispensing,
 * while somebody only waiting to pay has nowhere to go — there is no
 * "being paid" state, and inventing one would put a step in the record
 * that did not happen. So they are called, and that is all.
 */
export function callTargetFor(
  station: Station,
  status: EncounterStatus,
): EncounterStatus | null {
  const fixed = STATION_CALL_TARGET[station];
  if (fixed) return isAllowed(status, fixed) ? fixed : null;
  if (station === 'counter') {
    return status === S.PHARMACY_WAITING ? S.DISPENSING : null;
  }
  return null;
}

const BY_FROM = new Map<EncounterStatus, TransitionRule[]>();
for (const rule of ALL_TRANSITIONS) {
  const list = BY_FROM.get(rule.from) ?? [];
  list.push(rule);
  BY_FROM.set(rule.from, list);
}

/** What a screen may offer. Recovery moves are not among them. */
export function allowedFrom(
  status: EncounterStatus,
): readonly TransitionRule[] {
  return (BY_FROM.get(status) ?? []).filter((rule) => !rule.forceOnly);
}

/** Including the recovery moves, for an administrator who is forcing one. */
export function allowedFromWithForce(
  status: EncounterStatus,
): readonly TransitionRule[] {
  return BY_FROM.get(status) ?? [];
}

export function isAllowed(
  from: EncounterStatus,
  to: EncounterStatus,
  options: { force?: boolean } = {},
): boolean {
  const rules = options.force ? allowedFromWithForce(from) : allowedFrom(from);
  return rules.some((rule) => rule.to === to);
}

export function ruleFor(
  from: EncounterStatus,
  to: EncounterStatus,
): TransitionRule | undefined {
  return allowedFromWithForce(from).find((rule) => rule.to === to);
}

/** The board a given status belongs to, for routing a call. */
export function stationOf(status: EncounterStatus): Station | undefined {
  return (Object.keys(STATION_STATUSES) as Station[]).find(
    (station) =>
      !VIEW_STATIONS.has(station) && STATION_STATUSES[station].includes(status),
  );
}
