import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EncounterStatus } from '../../generated/prisma/enums.js';
import {
  ALL_TRANSITIONS,
  ENCOUNTER_TRANSITIONS,
  OPEN_STATUSES,
  STATION_STATUSES,
  STATION_WAITING,
  TERMINAL_STATUSES,
  VIEW_STATIONS,
  allowedFrom,
  callTargetFor,
  isAllowed,
  stationOf,
} from './transitions.js';

/** The migration that most recently defined the backstop function. */
const MIGRATION =
  'prisma/migrations/20260921220000_encounter_send_back/migration.sql';

describe('The transition table (§6, ENC-R-01)', () => {
  it('lets a visit run from the door to the door', () => {
    const journey: EncounterStatus[] = [
      EncounterStatus.REGISTERED,
      EncounterStatus.TRIAGE_WAITING,
      EncounterStatus.TRIAGE_IN_PROGRESS,
      EncounterStatus.DOCTOR_WAITING,
      EncounterStatus.IN_CONSULTATION,
      EncounterStatus.PHARMACY_WAITING,
      EncounterStatus.DISPENSING,
      EncounterStatus.PAYMENT_WAITING,
      EncounterStatus.COMPLETED,
    ];
    for (let i = 1; i < journey.length; i += 1) {
      expect(
        isAllowed(journey[i - 1]!, journey[i]!),
        `${journey[i - 1]} → ${journey[i]}`,
      ).toBe(true);
    }
  });

  it('allows paying before collecting medicine, and after', () => {
    // Which one a clinic uses is a branch setting, so both have to be legal
    // moves and the service decides which is offered.
    expect(
      isAllowed(EncounterStatus.DISPENSING, EncounterStatus.PAYMENT_WAITING),
    ).toBe(true);
    expect(
      isAllowed(
        EncounterStatus.PAYMENT_WAITING,
        EncounterStatus.PHARMACY_WAITING,
      ),
    ).toBe(true);
  });

  it('refuses to skip the middle of the day', () => {
    expect(
      isAllowed(EncounterStatus.REGISTERED, EncounterStatus.COMPLETED),
    ).toBe(false);
    expect(
      isAllowed(
        EncounterStatus.TRIAGE_WAITING,
        EncounterStatus.IN_CONSULTATION,
      ),
    ).toBe(false);
    expect(
      isAllowed(EncounterStatus.REGISTERED, EncounterStatus.PAYMENT_WAITING),
    ).toBe(false);
  });

  it('ENC-R-09: a visit cannot be cancelled once the consultation has begun', () => {
    expect(
      isAllowed(EncounterStatus.DOCTOR_WAITING, EncounterStatus.CANCELLED),
    ).toBe(true);
    expect(
      isAllowed(EncounterStatus.IN_CONSULTATION, EncounterStatus.CANCELLED),
    ).toBe(false);
    expect(
      isAllowed(EncounterStatus.PHARMACY_WAITING, EncounterStatus.CANCELLED),
    ).toBe(false);
  });

  it('but an administrator can abandon one, deliberately and on the record', () => {
    // §14: a patient who walks out mid-consultation still has to come off
    // the board. The alternative to a recorded override is a psql prompt.
    expect(
      isAllowed(EncounterStatus.IN_CONSULTATION, EncounterStatus.CANCELLED, {
        force: true,
      }),
    ).toBe(true);
    expect(
      isAllowed(EncounterStatus.DISPENSING, EncounterStatus.CANCELLED, {
        force: true,
      }),
    ).toBe(true);
    // Not permission to invent a state, though.
    expect(
      isAllowed(EncounterStatus.CANCELLED, EncounterStatus.IN_CONSULTATION, {
        force: true,
      }),
    ).toBe(false);
  });

  it('never offers a recovery move on an ordinary screen', () => {
    for (const status of OPEN_STATUSES) {
      for (const rule of allowedFrom(status)) {
        expect(rule.forceOnly, `${rule.from} → ${rule.to}`).toBeFalsy();
      }
    }
  });

  it('lets a patient called by mistake go back to the queue', () => {
    expect(
      isAllowed(
        EncounterStatus.IN_CONSULTATION,
        EncounterStatus.DOCTOR_WAITING,
      ),
    ).toBe(true);
  });

  it('has no move out of a cancelled visit', () => {
    expect(allowedFrom(EncounterStatus.CANCELLED)).toHaveLength(0);
    expect(TERMINAL_STATUSES).toContain(EncounterStatus.CANCELLED);
    expect(OPEN_STATUSES).not.toContain(EncounterStatus.CANCELLED);
  });

  it('puts every status on exactly one station board, or on none deliberately', () => {
    for (const status of OPEN_STATUSES) {
      const boards = (
        Object.keys(STATION_STATUSES) as Array<keyof typeof STATION_STATUSES>
      )
        // `reception` and `counter` are views over other people's
        // queues rather than queues of their own, which is exactly why
        // they are allowed to overlap and the real stations are not.
        .filter((station) => !VIEW_STATIONS.has(station))
        .filter((station) => STATION_STATUSES[station].includes(status));
      // REGISTERED and PROCEDURE_DONE are transient: reception sees them,
      // and no station queues on them.
      expect(
        boards.length,
        `${status} is on ${boards.length} boards`,
      ).toBeLessThanOrEqual(1);
    }
    expect(stationOf(EncounterStatus.DOCTOR_WAITING)).toBe('doctor');
    expect(stationOf(EncounterStatus.COMPLETED)).toBeUndefined();
  });

  it('never routes a call to a view station (ENC-F-15)', () => {
    // `stationOf` decides where a call goes. If it ever answered
    // `counter`, a clinic that does not use a combined counter would
    // have calls sent to a board nobody is watching.
    for (const status of OPEN_STATUSES) {
      const station = stationOf(status);
      expect(station === undefined || !VIEW_STATIONS.has(station)).toBe(true);
    }
  });

  it('a combined counter serves both lines, and moves each the right way', () => {
    // Somebody waiting for medicine goes into dispensing...
    expect(callTargetFor('counter', EncounterStatus.PHARMACY_WAITING)).toBe(
      EncounterStatus.DISPENSING,
    );
    // ...and somebody only waiting to pay has nowhere to go. There is no
    // "being paid" state, and inventing one would put a step in the
    // record that did not happen, so they are simply called.
    expect(
      callTargetFor('counter', EncounterStatus.PAYMENT_WAITING),
    ).toBeNull();

    // The separate stations are unchanged.
    expect(callTargetFor('pharmacy', EncounterStatus.PHARMACY_WAITING)).toBe(
      EncounterStatus.DISPENSING,
    );
    expect(
      callTargetFor('cashier', EncounterStatus.PAYMENT_WAITING),
    ).toBeNull();

    // And a target that the state machine would refuse is not offered.
    expect(
      callTargetFor('pharmacy', EncounterStatus.PAYMENT_WAITING),
    ).toBeNull();
  });

  it('the combined counter is exactly the two lines it replaces', () => {
    const combined = new Set(STATION_STATUSES.counter);
    for (const status of [
      ...STATION_STATUSES.pharmacy,
      ...STATION_STATUSES.cashier,
    ]) {
      expect(
        combined.has(status),
        `${status} is missing from the counter`,
      ).toBe(true);
    }
    expect(combined.size).toBe(
      new Set([...STATION_STATUSES.pharmacy, ...STATION_STATUSES.cashier]).size,
    );
  });

  it('ENC-F-24: every station a patient can be stuck at can send them back', () => {
    // The complaint this answers: a pharmacist reading a dose that cannot
    // be right, with nothing on the screen but "send to pay" and "finish".
    const sendsBack = (from: EncounterStatus) =>
      allowedFrom(from).filter((rule) => rule.back);

    for (const from of [
      EncounterStatus.TRIAGE_IN_PROGRESS,
      EncounterStatus.IN_CONSULTATION,
      EncounterStatus.PROCEDURE_WAITING,
      EncounterStatus.PROCEDURE_DONE,
      EncounterStatus.PHARMACY_WAITING,
      EncounterStatus.DISPENSING,
      EncounterStatus.PAYMENT_WAITING,
    ]) {
      expect(sendsBack(from).length, `${from} has no way back`).toBeGreaterThan(
        0,
      );
    }
  });

  it('sends them to the queue for the doctor, not straight into consultation', () => {
    // Putting a patient into IN_CONSULTATION would assert that the doctor
    // is with them. The doctor is with somebody else.
    for (const rule of ALL_TRANSITIONS.filter((r) => r.back)) {
      expect(rule.to, `${rule.from} → ${rule.to}`).not.toBe(
        EncounterStatus.IN_CONSULTATION,
      );
    }
  });

  it('asks why, whenever going back hands the patient to somebody else', () => {
    // Putting somebody back in your own line is a correction and needs no
    // explanation — the nurse called the wrong name. Sending them to a
    // different station is a claim that the work done there was wrong,
    // and the person receiving them needs to know what it was.
    for (const rule of ALL_TRANSITIONS.filter((r) => r.back)) {
      const handover = stationOf(rule.to) !== rule.station;
      expect(
        rule.requiresReason ?? false,
        `${rule.from} → ${rule.to} (from the ${rule.station}) ${
          handover ? 'should' : 'should not'
        } demand a reason`,
      ).toBe(handover);
    }
  });

  it('never marks a move backwards as a move onwards', () => {
    // A rule that is both `back` and `forceOnly` would be offered nowhere
    // and demanded of nobody, which is a rule that does nothing.
    for (const rule of ALL_TRANSITIONS.filter((r) => r.back)) {
      expect(rule.forceOnly, `${rule.from} → ${rule.to}`).toBeFalsy();
    }
  });

  it('a board shows the patient being dealt with, not just the line', () => {
    // The bug this pins: a doctor with somebody in the room saw an empty
    // board, because IN_CONSULTATION was on no board at all.
    expect(STATION_STATUSES.doctor).toContain(EncounterStatus.IN_CONSULTATION);
    expect(STATION_STATUSES.triage).toContain(
      EncounterStatus.TRIAGE_IN_PROGRESS,
    );
    expect(STATION_STATUSES.pharmacy).toContain(EncounterStatus.DISPENSING);
  });

  it('never offers to call somebody who is already being dealt with', () => {
    // `call next` takes the head of the *waiting* list. Taking the head
    // of the board would pick the patient in the chair — they have been
    // in that status longest — and re-call the person in front of you.
    for (const station of Object.keys(STATION_WAITING) as Array<
      keyof typeof STATION_WAITING
    >) {
      for (const status of STATION_WAITING[station]) {
        expect(
          STATION_STATUSES[station],
          `${station} can call ${status}, which is not even on its board`,
        ).toContain(status);
        expect(
          callTargetFor(station, status) !== null || station === 'cashier' ||
            station === 'counter',
          `${station} would call ${status} nowhere`,
        ).toBe(true);
      }
    }
  });

  it('the waiting list is never the whole board', () => {
    // Where a station has an in-progress state, the two lists must
    // differ — otherwise the guard above is vacuous.
    for (const station of ['triage', 'doctor', 'pharmacy'] as const) {
      expect(STATION_WAITING[station].length).toBeLessThan(
        STATION_STATUSES[station].length,
      );
    }
  });

  it('describes every move for the button that offers it', () => {
    for (const rule of ENCOUNTER_TRANSITIONS) {
      expect(rule.label.length, `${rule.from} → ${rule.to}`).toBeGreaterThan(2);
      expect(rule.station).toBeTruthy();
    }
  });

  it('never lists the same move twice', () => {
    const seen = ENCOUNTER_TRANSITIONS.map(
      (rule) => `${rule.from}->${rule.to}`,
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * The code table and the database trigger are two lists of the same rule,
   * and two lists drift. This is the test that notices.
   *
   * They are not required to be identical: the trigger is a backstop and
   * knows nothing about branch settings, so it is allowed to be looser. It
   * must never be stricter, because then it would refuse a move the
   * application legitimately permits.
   */
  it('the database backstop allows everything this table does', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const body = sql.slice(
      sql.indexOf('encounter_allowed_transition'),
      sql.indexOf('CREATE OR REPLACE FUNCTION encounter_status_guard'),
    );

    const missing = ALL_TRANSITIONS.filter(
      (rule) => !body.includes(`('${rule.from}', '${rule.to}')`),
    ).map((rule) => `${rule.from} → ${rule.to}`);

    expect(
      missing,
      `The migration's transition list is missing these, so the trigger would refuse ` +
        `a move the service allows:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
