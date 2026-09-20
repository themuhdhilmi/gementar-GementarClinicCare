import { describe, expect, it } from 'vitest';
import { StockMovementType } from '../../generated/prisma/enums.js';
import { DIRECTION, MOVEMENT_LABEL } from './movement-kinds.js';

/**
 * A movement type added to the enum and not to these tables would
 * default to nothing: `DIRECTION[type]` would be undefined, and the
 * arithmetic would silently produce NaN. Both tables are checked against
 * the enum so that cannot happen quietly.
 */
describe('INV-F-10 — every movement type is accounted for', () => {
  const types = Object.values(StockMovementType);

  it('has a direction', () => {
    const missing = types.filter((type) => DIRECTION[type] === undefined);
    expect(missing, `no direction for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has a label somebody can read', () => {
    const missing = types.filter((type) => !MOVEMENT_LABEL[type]);
    expect(missing, `no label for: ${missing.join(', ')}`).toEqual([]);
  });

  it('sends the obvious ones the obvious way', () => {
    expect(DIRECTION.RECEIVE).toBe(1);
    expect(DIRECTION.DISPENSE).toBe(-1);
    expect(DIRECTION.CONSUME).toBe(-1);
    // A reversal must undo its movement, or a voided procedure leaves
    // the shelf short.
    expect(DIRECTION.CONSUME_REVERSAL).toBe(-DIRECTION.CONSUME);
    expect(DIRECTION.DISPENSE_REVERSAL).toBe(-DIRECTION.DISPENSE);
    expect(DIRECTION.ADJUST_IN).toBe(-DIRECTION.ADJUST_OUT);
    expect(DIRECTION.TRANSFER_IN).toBe(-DIRECTION.TRANSFER_OUT);
  });
});
