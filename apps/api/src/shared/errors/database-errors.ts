import { AppError } from './domain-errors.js';

/**
 * Prisma error codes that mean "the database is not answering", rather than
 * "your request was wrong".
 *
 * They matter on the login screen more than anywhere else: when the database
 * is unreachable, a receptionist at nine in the morning should be told the
 * system cannot reach its database, not handed a trace id and a shrug
 * (IAM-N-06).
 */
// Deliberately excluded: P2010 (raw query failed) and the constraint codes.
// A statement rejected by a trigger, a policy or a unique index is a decision
// the database made about the request, not an outage, and answering 503 would
// hide a real rule violation behind "try again later".
const UNAVAILABLE_CODES = new Set([
  'P1000', // authentication failed against the database
  'P1001', // cannot reach the database server
  'P1002', // the database server was reached but timed out
  'P1008', // operation timed out
  'P1017', // the server has closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API error, including "unable to start a transaction"
]);

export class DatabaseUnavailableError extends AppError {
  constructor(detail: string) {
    super(503, 'database_unavailable', 'Service unavailable', detail);
  }
}

type MaybePrismaError = { name?: string; code?: string };

export function isDatabaseUnavailable(error: unknown): boolean {
  const candidate = error as MaybePrismaError;
  if (candidate?.name === 'PrismaClientInitializationError') return true;
  if (candidate?.name === 'PrismaClientRustPanicError') return true;
  return typeof candidate?.code === 'string' && UNAVAILABLE_CODES.has(candidate.code);
}

export function toDatabaseUnavailable(_error?: unknown): DatabaseUnavailableError {
  return new DatabaseUnavailableError(
    'The system cannot reach its database right now. Nothing you typed was saved. ' +
      'Try again in a moment, and tell whoever looks after the server if it continues.',
  );
}
