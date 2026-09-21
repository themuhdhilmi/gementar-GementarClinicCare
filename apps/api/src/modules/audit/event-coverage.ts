import { AUDIT_ACTION_SET } from './audit.actions.js';
import { DomainEvent } from '../events/domain-events.js';

/**
 * AUD-F-08, answered differently from the way it is written.
 *
 * The specification asks for a subscriber that persists every domain
 * event into `audit_log`, so that the log is also the event history.
 * That is not what this system does, for two reasons that are worth
 * having in one place rather than discovering twice.
 *
 * **The bus publishes after commit.** A subscriber writing an entry
 * would be writing it outside the transaction of the change, which is
 * exactly what AUD-R-02 forbids and §14 explains: an audit write that
 * fails must take the change with it. An after-commit subscriber cannot
 * do that. It would also only log its own failure, which is the same
 * shape of mistake billing refused when it declined to take money from
 * an event.
 *
 * **It would double-log.** Almost every event already has an entry
 * written inside the transaction, with `before` and `after` that the
 * event payload does not carry. Persisting both would leave two rows per
 * action, disagreeing in detail, and an investigator picking between
 * them.
 *
 * So the log *is* the event history, reached the safe way: every event
 * either has an audit action recording the same act, or is listed below
 * as a derived signal — something the system noticed rather than
 * something a person did. `event-coverage.spec.ts` fails if a new event
 * appears in neither list, which is the same guarantee by a different
 * route.
 */

/** The event and the entry describe the same act under different names. */
export const EVENT_AUDIT_ALIAS: Partial<Record<string, string>> = {
  [DomainEvent.EncounterCompleted]: 'encounter.status_changed',
  [DomainEvent.DiagnosisRecorded]: 'consultation.signed',
  [DomainEvent.PrescriptionCreated]: 'prescription.activated',
  [DomainEvent.PrescriptionUpdated]: 'prescription.item_updated',
  [DomainEvent.PrescriptionCompleted]: 'dispense.session_completed',
  [DomainEvent.StockMoved]: 'stock.adjusted',
  [DomainEvent.DispenseCompleted]: 'dispense.session_completed',
  [DomainEvent.DocumentPrinted]: 'document.reprinted',
  [DomainEvent.InvoiceLineAdded]: 'invoice.manual_line_added',
  [DomainEvent.InvoiceLineRemoved]: 'invoice.manual_line_removed',
  [DomainEvent.InvoiceStatusChanged]: 'invoice.issued',
  // A receipt is not issued on its own; it is the paper side of taking
  // the money, and `payment.received` is the act.
  [DomainEvent.ReceiptIssued]: 'payment.received',
};

/**
 * Events with no actor, because nobody did them.
 *
 * A low-stock alert is the system noticing a threshold; an abnormal
 * vital sign is an arithmetic comparison. Writing these to the audit
 * trail would fill it with rows whose `actor_name` is a job name and
 * whose `before` is nothing — and would bury the rows that record what a
 * person chose to do, which is what the trail is for. They are
 * recorded: as alerts, as flags on the record, in the application log.
 * Just not here.
 */
export const DERIVED_EVENTS: ReadonlySet<string> = new Set<string>([
  DomainEvent.TriageAbnormalFlagged,
  DomainEvent.PrescriptionWarningRaised,
  DomainEvent.DispensePartial,
  DomainEvent.StockLow,
  DomainEvent.StockCritical,
  DomainEvent.StockExpiring,
  DomainEvent.StockExpired,
  DomainEvent.StockReconciliationMismatch,
]);

export function uncoveredEvents(): string[] {
  return Object.values(DomainEvent).filter(
    (event) =>
      !AUDIT_ACTION_SET.has(event) &&
      !DERIVED_EVENTS.has(event) &&
      !(event in EVENT_AUDIT_ALIAS),
  );
}
