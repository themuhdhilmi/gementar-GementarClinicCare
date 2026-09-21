import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_SET } from './audit.actions.js';
import { DomainEvent } from '../events/domain-events.js';
import {
  DERIVED_EVENTS,
  EVENT_AUDIT_ALIAS,
  uncoveredEvents,
} from './event-coverage.js';

describe('AUD-F-08 — the log is the event history', () => {
  it('every domain event is recorded, or is documented as a derived signal', () => {
    // A new event with no entry behind it is the failure this catches: a
    // thing the system does that leaves no trace of who caused it.
    expect(uncoveredEvents()).toEqual([]);
  });

  it('every alias points at an action that exists', () => {
    for (const [event, action] of Object.entries(EVENT_AUDIT_ALIAS)) {
      expect(AUDIT_ACTION_SET.has(action!), `${event} -> ${action}`).toBe(true);
    }
  });

  it('neither list has gone stale', () => {
    const events = new Set<string>(Object.values(DomainEvent));
    for (const derived of DERIVED_EVENTS) {
      expect(events.has(derived), `${derived} is no longer an event`).toBe(
        true,
      );
    }
    for (const event of Object.keys(EVENT_AUDIT_ALIAS)) {
      expect(events.has(event), `${event} is no longer an event`).toBe(true);
    }
    // An alias for an event that has since gained its own audit action
    // would be a lie the next reader believes.
    for (const event of Object.keys(EVENT_AUDIT_ALIAS)) {
      expect(
        AUDIT_ACTION_SET.has(event),
        `${event} now has its own action`,
      ).toBe(false);
    }
  });
});
