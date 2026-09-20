import { describe, expect, it } from 'vitest';
import { calculateQuantity } from './quantity.js';

const base = {
  frequencyCode: 'TDS' as const,
  frequencyPerDay: null,
  durationDays: 5,
  untilFinished: false,
};

describe('RX-F-03 — quantity', () => {
  it('RX-T-05: 500 mg TDS for 5 days of a 500 mg tablet is 15 tablets', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 500,
      doseUnit: 'mg',
      dispenseUnit: 'tab',
      strengthValue: 500,
      strengthUnit: 'mg',
    });
    expect(result?.quantity).toBe(15);
    expect(result?.unit).toBe('tab');
    expect(result?.formula).toContain('TDS');
  });

  it('divides by the strength rather than multiplying by it', () => {
    // 500 mg of a 250 mg tablet is two tablets, not half of one.
    const result = calculateQuantity({
      ...base,
      doseValue: 500,
      doseUnit: 'mg',
      dispenseUnit: 'tab',
      strengthValue: 250,
      strengthUnit: 'mg',
    });
    expect(result?.quantity).toBe(30);
  });

  it('converts within a dimension', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 1,
      doseUnit: 'g',
      dispenseUnit: 'tab',
      strengthValue: 500,
      strengthUnit: 'mg',
      frequencyCode: 'BD',
      durationDays: 3,
    });
    expect(result?.quantity).toBe(12);
  });

  it('refuses to convert across dimensions', () => {
    // Milligrams to millilitres needs a concentration nobody supplied.
    const result = calculateQuantity({
      ...base,
      doseValue: 250,
      doseUnit: 'mg',
      dispenseUnit: 'bottle',
      strengthValue: 100,
      strengthUnit: 'ml',
    });
    expect(result).toBeNull();
  });

  it('takes the dose as-is when it is already in the dispensing unit', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 5,
      doseUnit: 'ml',
      dispenseUnit: 'ml',
      frequencyCode: 'QID',
      durationDays: 7,
    });
    expect(result?.quantity).toBe(140);
  });

  it('rounds discrete units up so the course can be finished', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 0.5,
      doseUnit: 'tab',
      dispenseUnit: 'tab',
      frequencyCode: 'OD',
      durationDays: 5,
    });
    // 2.5 tablets is 3 in the bag.
    expect(result?.quantity).toBe(3);
  });

  it('leaves measured units unrounded', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 2.5,
      doseUnit: 'ml',
      dispenseUnit: 'ml',
      frequencyCode: 'TDS',
      durationDays: 5,
    });
    expect(result?.quantity).toBe(37.5);
  });

  it('counts Q4H as six doses a day, not four', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 1,
      doseUnit: 'tab',
      dispenseUnit: 'tab',
      frequencyCode: 'Q4H',
      durationDays: 2,
    });
    expect(result?.quantity).toBe(12);
  });

  it('gives one dose for STAT whatever the duration says', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 2,
      doseUnit: 'tab',
      dispenseUnit: 'tab',
      frequencyCode: 'STAT',
      durationDays: 30,
    });
    expect(result?.quantity).toBe(2);
  });

  it('declines to guess for PRN', () => {
    expect(
      calculateQuantity({
        ...base,
        doseValue: 1,
        doseUnit: 'tab',
        dispenseUnit: 'tab',
        frequencyCode: 'PRN',
      }),
    ).toBeNull();
  });

  it('declines to guess for "until finished"', () => {
    expect(
      calculateQuantity({
        ...base,
        doseValue: 1,
        doseUnit: 'tab',
        dispenseUnit: 'tab',
        durationDays: null,
        untilFinished: true,
      }),
    ).toBeNull();
  });

  it('declines when the strength is unknown', () => {
    expect(
      calculateQuantity({
        ...base,
        doseValue: 500,
        doseUnit: 'mg',
        dispenseUnit: 'tab',
        strengthValue: null,
        strengthUnit: null,
      }),
    ).toBeNull();
  });

  it('needs an explicit rate for a custom frequency', () => {
    expect(
      calculateQuantity({
        ...base,
        doseValue: 1,
        doseUnit: 'tab',
        dispenseUnit: 'tab',
        frequencyCode: 'CUSTOM',
        frequencyPerDay: null,
      }),
    ).toBeNull();

    expect(
      calculateQuantity({
        ...base,
        doseValue: 1,
        doseUnit: 'tab',
        dispenseUnit: 'tab',
        frequencyCode: 'CUSTOM',
        frequencyPerDay: 5,
        durationDays: 2,
      })?.quantity,
    ).toBe(10);
  });

  it('handles a weekly dose', () => {
    const result = calculateQuantity({
      ...base,
      doseValue: 1,
      doseUnit: 'tab',
      dispenseUnit: 'tab',
      frequencyCode: 'WEEKLY',
      durationDays: 28,
    });
    expect(result?.quantity).toBe(4);
  });
});
