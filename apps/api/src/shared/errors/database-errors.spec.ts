import { describe, expect, it } from 'vitest';
import { isDatabaseUnavailable, toDatabaseUnavailable } from './database-errors.js';
import { AuthenticationFailedError } from './domain-errors.js';

describe('database availability errors', () => {
  it('recognises the codes a dead or unreachable database produces', () => {
    for (const code of ['P1001', 'P1002', 'P1017', 'P2024', 'P2028']) {
      expect(isDatabaseUnavailable({ name: 'PrismaClientKnownRequestError', code }), code).toBe(true);
    }
    expect(isDatabaseUnavailable({ name: 'PrismaClientInitializationError' })).toBe(true);
  });

  it('does not mistake a rule the database enforced for an outage', () => {
    // A trigger, a policy or a unique index rejecting a statement is an answer,
    // not a failure to answer. Reporting 503 would hide it behind "try again".
    for (const code of ['P2010', 'P2002', 'P2003', 'P2004']) {
      expect(isDatabaseUnavailable({ name: 'PrismaClientKnownRequestError', code }), code).toBe(false);
    }
  });

  it('leaves ordinary failures alone', () => {
    expect(isDatabaseUnavailable(new AuthenticationFailedError())).toBe(false);
    expect(isDatabaseUnavailable({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBe(false);
    expect(isDatabaseUnavailable(new Error('something else'))).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });

  it('answers 503 with something a receptionist can act on', () => {
    const problem = toDatabaseUnavailable();
    expect(problem.status).toBe(503);
    expect(problem.code).toBe('database_unavailable');
    expect(problem.detail ?? '').toContain('cannot reach its database');
    expect(problem.detail ?? '').toContain('Nothing you typed was saved');
    // No trace-id shrug, and nothing about Prisma or SQL.
    expect((problem.detail ?? '').toLowerCase()).not.toContain('prisma');
  });
});
