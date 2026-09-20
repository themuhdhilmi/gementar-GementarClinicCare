import { describe, expect, it } from 'vitest';
import { FlagLevel } from '../../generated/prisma/enums.js';
import {
  ADULT_THRESHOLDS,
  assertBloodPressure,
  assertPlausible,
  CHILD_THRESHOLDS,
  computeBmiX10,
  flagsFor,
  maxLevel,
  thresholdsFor,
} from './vitals.js';

describe('Implausible is not the same as abnormal (§12)', () => {
  it('TRI-T-03: refuses a reading that cannot be real', () => {
    // The whole point: 1200/80 is a slipped finger, and saving it would put
    // a red banner on a well patient and a wrong number in the record.
    expect(() => assertPlausible('systolic', 1200)).toThrow(/not a possible reading/);
    expect(() => assertPlausible('temperatureDc', 700)).toThrow(/not a possible reading/);
    expect(() => assertPlausible('spo2', 140)).toThrow();
    expect(() => assertPlausible('weightG', 100)).toThrow();
  });

  it('accepts a reading that is alarming but real', () => {
    // A critical value must still save. A nurse who cannot record what they
    // measured will write it on paper instead.
    expect(assertPlausible('spo2', 86)).toBe(86);
    expect(assertPlausible('systolic', 85)).toBe(85);
    expect(assertPlausible('temperatureDc', 410)).toBe(410);
  });

  it('says what it expected, in the unit a nurse typed', () => {
    expect(() => assertPlausible('temperatureDc', 700)).toThrow(/30.0 °C and 45.0 °C/);
    expect(() => assertPlausible('weightG', 500_000)).toThrow(/kg/);
  });

  it('refuses a blood pressure the wrong way round', () => {
    expect(() => assertBloodPressure(80, 120)).toThrow(/right way round/);
    expect(() => assertBloodPressure(120, 80)).not.toThrow();
    expect(() => assertBloodPressure(120, null)).not.toThrow();
  });
});

describe('Body mass index (TRI-R-02)', () => {
  it('TRI-T-01: 70 kg at 175 cm is 22.9', () => {
    expect(computeBmiX10(70_000, 1750)).toBe(229);
  });

  it('needs both, and says nothing with one', () => {
    expect(computeBmiX10(70_000, null)).toBeNull();
    expect(computeBmiX10(null, 1750)).toBeNull();
  });
});

describe('Flagging (TRI-F-03, TRI-R-03)', () => {
  it('TRI-T-02: oxygen saturation of 86 is critical', () => {
    const flags = flagsFor({ spo2: 86 }, ADULT_THRESHOLDS);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ param: 'spo2', level: 'CRITICAL', value: 86 });
    expect(flags[0]!.threshold).toContain('below 90');
    expect(maxLevel(flags)).toBe(FlagLevel.CRITICAL);
  });

  it('separates worth-a-look from tell-somebody-now', () => {
    expect(flagsFor({ spo2: 93 }, ADULT_THRESHOLDS)[0]!.level).toBe('ABNORMAL');
    expect(flagsFor({ spo2: 89 }, ADULT_THRESHOLDS)[0]!.level).toBe('CRITICAL');
    expect(flagsFor({ spo2: 97 }, ADULT_THRESHOLDS)).toEqual([]);
  });

  it('flags nothing when nothing was measured', () => {
    expect(flagsFor({}, ADULT_THRESHOLDS)).toEqual([]);
    expect(maxLevel([])).toBe(FlagLevel.NONE);
  });

  it('reports one flag per reading, at its worst level', () => {
    const flags = flagsFor(
      { systolic: 85, heartRate: 135, temperatureDc: 372 },
      ADULT_THRESHOLDS,
    );
    expect(flags.map((f) => f.param).sort()).toEqual(['heartRate', 'systolic']);
    expect(flags.every((f) => f.level === 'CRITICAL')).toBe(true);
  });

  it('explains itself in the unit the nurse used', () => {
    const [flag] = flagsFor({ temperatureDc: 400 }, ADULT_THRESHOLDS);
    expect(flag!.threshold).toContain('39.5 °C');
    expect(flag!.label).toBe('Temperature');
  });
});

describe('Children are not small adults (TRI-F-03)', () => {
  it('does not flag a toddler heart rate that would be noted in an adult', () => {
    // 120 bpm is worth a look in a man of fifty and unremarkable in a
    // three-year-old. Flagging it would teach everyone to ignore the colour.
    expect(flagsFor({ heartRate: 120 }, ADULT_THRESHOLDS)[0]!.level).toBe('ABNORMAL');
    expect(flagsFor({ heartRate: 120 }, CHILD_THRESHOLDS)).toEqual([]);
    // And 135 is critical in the adult, still nothing in the child.
    expect(flagsFor({ heartRate: 135 }, ADULT_THRESHOLDS)[0]!.level).toBe('CRITICAL');
    expect(flagsFor({ heartRate: 135 }, CHILD_THRESHOLDS)).toEqual([]);
  });

  it('still flags a child who is genuinely in trouble', () => {
    expect(flagsFor({ heartRate: 190 }, CHILD_THRESHOLDS)[0]!.level).toBe('CRITICAL');
    expect(flagsFor({ spo2: 88 }, CHILD_THRESHOLDS)[0]!.level).toBe('CRITICAL');
  });

  it('says nothing about a child’s body mass index', () => {
    // It means something different in a growing child, and reading it
    // against adult cut-offs is worse than not reading it at all.
    expect(flagsFor({ bmi: 160 }, CHILD_THRESHOLDS)).toEqual([]);
    expect(flagsFor({ bmi: 160 }, ADULT_THRESHOLDS)[0]!.param).toBe('bmi');
  });

  it('picks the table by age, and treats an unknown age as adult', () => {
    expect(thresholdsFor(3, ADULT_THRESHOLDS)).toBe(CHILD_THRESHOLDS);
    expect(thresholdsFor(11, ADULT_THRESHOLDS)).toBe(CHILD_THRESHOLDS);
    expect(thresholdsFor(12, ADULT_THRESHOLDS)).toBe(ADULT_THRESHOLDS);
    expect(thresholdsFor(null, ADULT_THRESHOLDS)).toBe(ADULT_THRESHOLDS);
  });

  it('uses the clinic’s own adult numbers when it has them', () => {
    const clinic = { ...ADULT_THRESHOLDS, spo2: { low: 92, criticalLow: 85 } };
    expect(flagsFor({ spo2: 93 }, thresholdsFor(40, clinic))).toEqual([]);
    expect(flagsFor({ spo2: 86 }, thresholdsFor(40, clinic))[0]!.level).toBe('ABNORMAL');
  });
});
