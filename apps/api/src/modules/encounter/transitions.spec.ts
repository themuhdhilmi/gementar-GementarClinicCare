import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EncounterStatus } from '../../generated/prisma/enums.js';
import {
  ALL_TRANSITIONS,
  allowedFrom,
  ENCOUNTER_TRANSITIONS,
  isAllowed,
  OPEN_STATUSES,
  STATION_STATUSES,
  stationOf,
  TERMINAL_STATUSES,
} from './transitions.js';

/** The migration that most recently defined the backstop function. */
const MIGRATION = 'prisma/migrations/20260921090000_encounter_recovery/migration.sql';

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
      expect(isAllowed(journey[i - 1]!, journey[i]!), `${journey[i - 1]} → ${journey[i]}`).toBe(true);
    }
  });

  it('allows paying before collecting medicine, and after', () => {
    // Which one a clinic uses is a branch setting, so both have to be legal
    // moves and the service decides which is offered.
    expect(isAllowed(EncounterStatus.DISPENSING, EncounterStatus.PAYMENT_WAITING)).toBe(true);
    expect(isAllowed(EncounterStatus.PAYMENT_WAITING, EncounterStatus.PHARMACY_WAITING)).toBe(true);
  });

  it('refuses to skip the middle of the day', () => {
    expect(isAllowed(EncounterStatus.REGISTERED, EncounterStatus.COMPLETED)).toBe(false);
    expect(isAllowed(EncounterStatus.TRIAGE_WAITING, EncounterStatus.IN_CONSULTATION)).toBe(false);
    expect(isAllowed(EncounterStatus.REGISTERED, EncounterStatus.PAYMENT_WAITING)).toBe(false);
  });

  it('ENC-R-09: a visit cannot be cancelled once the consultation has begun', () => {
    expect(isAllowed(EncounterStatus.DOCTOR_WAITING, EncounterStatus.CANCELLED)).toBe(true);
    expect(isAllowed(EncounterStatus.IN_CONSULTATION, EncounterStatus.CANCELLED)).toBe(false);
    expect(isAllowed(EncounterStatus.PHARMACY_WAITING, EncounterStatus.CANCELLED)).toBe(false);
  });

  it('but an administrator can abandon one, deliberately and on the record', () => {
    // §14: a patient who walks out mid-consultation still has to come off
    // the board. The alternative to a recorded override is a psql prompt.
    expect(isAllowed(EncounterStatus.IN_CONSULTATION, EncounterStatus.CANCELLED, { force: true })).toBe(true);
    expect(isAllowed(EncounterStatus.DISPENSING, EncounterStatus.CANCELLED, { force: true })).toBe(true);
    // Not permission to invent a state, though.
    expect(isAllowed(EncounterStatus.CANCELLED, EncounterStatus.IN_CONSULTATION, { force: true })).toBe(false);
  });

  it('never offers a recovery move on an ordinary screen', () => {
    for (const status of OPEN_STATUSES) {
      for (const rule of allowedFrom(status)) {
        expect(rule.forceOnly, `${rule.from} → ${rule.to}`).toBeFalsy();
      }
    }
  });

  it('lets a patient called by mistake go back to the queue', () => {
    expect(isAllowed(EncounterStatus.IN_CONSULTATION, EncounterStatus.DOCTOR_WAITING)).toBe(true);
  });

  it('has no move out of a cancelled visit', () => {
    expect(allowedFrom(EncounterStatus.CANCELLED)).toHaveLength(0);
    expect(TERMINAL_STATUSES).toContain(EncounterStatus.CANCELLED);
    expect(OPEN_STATUSES).not.toContain(EncounterStatus.CANCELLED);
  });

  it('puts every status on exactly one station board, or on none deliberately', () => {
    for (const status of OPEN_STATUSES) {
      const boards = (Object.keys(STATION_STATUSES) as Array<keyof typeof STATION_STATUSES>)
        .filter((station) => station !== 'reception')
        .filter((station) => STATION_STATUSES[station].includes(status));
      // REGISTERED and PROCEDURE_DONE are transient: reception sees them,
      // and no station queues on them.
      expect(boards.length, `${status} is on ${boards.length} boards`).toBeLessThanOrEqual(1);
    }
    expect(stationOf(EncounterStatus.DOCTOR_WAITING)).toBe('doctor');
    expect(stationOf(EncounterStatus.COMPLETED)).toBeUndefined();
  });

  it('describes every move for the button that offers it', () => {
    for (const rule of ENCOUNTER_TRANSITIONS) {
      expect(rule.label.length, `${rule.from} → ${rule.to}`).toBeGreaterThan(2);
      expect(rule.station).toBeTruthy();
    }
  });

  it('never lists the same move twice', () => {
    const seen = ENCOUNTER_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`);
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
