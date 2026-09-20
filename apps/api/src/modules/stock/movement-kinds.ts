import { StockMovementType } from '../../generated/prisma/enums.js';

/**
 * Which way each kind of movement goes.
 *
 * The sign lives here rather than at every call site, because a caller
 * that has to remember to pass -3 is a caller that will one day pass 3.
 * `move()` takes a quantity that is always positive and a type that says
 * which direction it means.
 */
export const DIRECTION: Record<StockMovementType, 1 | -1> = {
  OPENING: 1,
  RECEIVE: 1,
  DISPENSE: -1,
  DISPENSE_REVERSAL: 1,
  CONSUME: -1,
  CONSUME_REVERSAL: 1,
  ADJUST_IN: 1,
  ADJUST_OUT: -1,
  DAMAGE: -1,
  EXPIRE: -1,
  RETURN_TO_SUPPLIER: -1,
  RETURN_FROM_PATIENT: 1,
  QUARANTINE_IN: -1,
  QUARANTINE_OUT: 1,
  TRANSFER_OUT: -1,
  TRANSFER_IN: 1,
  /// Signed by the variance: a count can find more or less than expected.
  COUNT_ADJUST: 1,
};

/**
 * Movements a person posts by hand, which therefore need a reason
 * (INV-F-13). Everything else is posted by a module that already records
 * why — a dispense references the prescription, a consume references the
 * procedure.
 */
export const NEEDS_REASON = new Set<StockMovementType>([
  StockMovementType.ADJUST_IN,
  StockMovementType.ADJUST_OUT,
  StockMovementType.DAMAGE,
  StockMovementType.EXPIRE,
  StockMovementType.RETURN_TO_SUPPLIER,
  StockMovementType.QUARANTINE_IN,
  StockMovementType.QUARANTINE_OUT,
  StockMovementType.COUNT_ADJUST,
]);

/** INV-F-13: a controlled list, so "adjustment" reports mean something. */
export const REASON_CODES = [
  'miscount',
  'damaged',
  'expired',
  'lost',
  'found',
  'returned_to_supplier',
  'recall',
  'donation',
  'sample',
  'opening_balance',
  'other',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** How a movement reads in a history list. */
export const MOVEMENT_LABEL: Record<StockMovementType, string> = {
  OPENING: 'Opening balance',
  RECEIVE: 'Received',
  DISPENSE: 'Dispensed',
  DISPENSE_REVERSAL: 'Dispense reversed',
  CONSUME: 'Used in a procedure',
  CONSUME_REVERSAL: 'Procedure voided',
  ADJUST_IN: 'Adjusted up',
  ADJUST_OUT: 'Adjusted down',
  DAMAGE: 'Damaged',
  EXPIRE: 'Written off, expired',
  RETURN_TO_SUPPLIER: 'Returned to the supplier',
  RETURN_FROM_PATIENT: 'Returned by the patient',
  QUARANTINE_IN: 'Moved to quarantine',
  QUARANTINE_OUT: 'Released from quarantine',
  TRANSFER_OUT: 'Transferred out',
  TRANSFER_IN: 'Transferred in',
  COUNT_ADJUST: 'Corrected by a stock count',
};
