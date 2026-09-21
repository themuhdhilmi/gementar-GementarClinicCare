import { describe, expect, it } from 'vitest';
import { roundToPacks } from './pack-rounding.js';

const bottle = { isPackDispensed: true, packSize: 60, dispenseUnit: 'ml' };
const loose = { isPackDispensed: false, packSize: 1, dispenseUnit: 'tab' };

describe('DSP-F-06 — pack rounding', () => {
  it('leaves a loose product alone', () => {
    expect(roundToPacks(37.5, loose)).toMatchObject({ quantity: 37.5, packRounded: false });
  });

  it('rounds up to whole packs and says so', () => {
    const result = roundToPacks(37.5, bottle);
    expect(result.quantity).toBe(60);
    expect(result.packRounded).toBe(true);
    expect(result.note).toContain('Prescribed 37.5');
    expect(result.note).toContain('1 pack of 60');
  });

  it('rounds up rather than down, so the course can be finished', () => {
    expect(roundToPacks(61, bottle).quantity).toBe(120);
  });

  it('does not flag an exact number of packs', () => {
    expect(roundToPacks(120, bottle)).toMatchObject({ quantity: 120, packRounded: false, note: null });
  });

  it('treats a pack of one as loose', () => {
    expect(
      roundToPacks(7, { isPackDispensed: true, packSize: 1, dispenseUnit: 'tab' }),
    ).toMatchObject({ quantity: 7, packRounded: false });
  });
});
