import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether anything has been written to the audit trail during this
 * request.
 *
 * The alternative — asking the database — would mean counting rows by
 * `request_id`, which is not indexed and would not be worth indexing:
 * it is a column for correlating with application logs after the fact,
 * queried by a human once a month, not by every write.
 */
type AuditRequestState = { written: number };

const storage = new AsyncLocalStorage<AuditRequestState>();

export function trackAuditWrites<T>(
  run: (state: AuditRequestState) => Promise<T>,
): Promise<T> {
  const state: AuditRequestState = { written: 0 };
  return storage.run(state, () => run(state));
}

export function noteAuditWrite(): void {
  const state = storage.getStore();
  if (state) state.written += 1;
}
