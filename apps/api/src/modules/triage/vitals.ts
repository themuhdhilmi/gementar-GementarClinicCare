import { FlagLevel } from '../../generated/prisma/enums.js';
import { InvariantViolationError } from '../../shared/errors/domain-errors.js';

/**
 * Vitals: what may be recorded, what is implausible, and what is worrying.
 *
 * Three ideas are kept carefully apart here, and confusing any two of them
 * is how a triage screen becomes dangerous:
 *
 *   **Implausible** is a typing error. `1200/80` is not a critical blood
 *   pressure, it is a slipped finger, and saving it would put a red banner
 *   on a well patient and a wrong number in their record for ever. Rejected.
 *
 *   **Abnormal** is outside the usual range and worth the doctor's eye.
 *   Advisory: it never stops the nurse saving.
 *
 *   **Critical** is "tell somebody now". Also advisory — a nurse who cannot
 *   record a reading because the system disapproves of it will write it on
 *   paper instead — but it prompts loudly.
 */

/** §12: the range a reading can physically be, in the unit stored. */
const PLAUSIBLE = {
  systolic: [50, 300],
  diastolic: [20, 200],
  heartRate: [20, 250],
  respRate: [4, 80],
  temperatureDc: [300, 450],
  spo2: [50, 100],
  weightG: [500, 400_000],
  heightMm: [300, 2500],
  glucoseX10: [5, 500],
  painScore: [0, 10],
} as const satisfies Record<string, readonly [number, number]>;

export type VitalName = keyof typeof PLAUSIBLE;

/** How each reading is spoken about, for an error a nurse has to act on. */
const SPOKEN: Record<VitalName, { label: string; unit: string; scale: number }> = {
  systolic: { label: 'Systolic blood pressure', unit: 'mmHg', scale: 1 },
  diastolic: { label: 'Diastolic blood pressure', unit: 'mmHg', scale: 1 },
  heartRate: { label: 'Heart rate', unit: 'bpm', scale: 1 },
  respRate: { label: 'Respiratory rate', unit: 'breaths a minute', scale: 1 },
  temperatureDc: { label: 'Temperature', unit: '°C', scale: 10 },
  spo2: { label: 'Oxygen saturation', unit: '%', scale: 1 },
  weightG: { label: 'Weight', unit: 'kg', scale: 1000 },
  heightMm: { label: 'Height', unit: 'cm', scale: 10 },
  glucoseX10: { label: 'Blood glucose', unit: 'mmol/L', scale: 10 },
  painScore: { label: 'Pain score', unit: 'out of 10', scale: 1 },
};

function show(name: VitalName, value: number): string {
  const { scale, unit } = SPOKEN[name];
  const shown = scale === 1 ? String(value) : (value / scale).toFixed(scale === 1000 ? 1 : 1);
  return `${shown} ${unit}`;
}

/**
 * Refuses a reading that cannot be real.
 *
 * Deliberately separate from the abnormal thresholds, and deliberately not
 * configurable: a clinic may disagree about what counts as a high
 * temperature, and no clinic has a patient at 70 °C.
 */
export function assertPlausible(name: VitalName, value: number): number {
  if (!Number.isInteger(value)) {
    throw new InvariantViolationError(
      'implausible_vital',
      `${SPOKEN[name].label} must be a whole number.`,
    );
  }
  const [low, high] = PLAUSIBLE[name];
  if (value < low || value > high) {
    // 422, not 400: the request is well formed and the value is wrong,
    // which is exactly the distinction those two codes are for (TRI-T-03).
    throw new InvariantViolationError(
      'implausible_vital',
      `${SPOKEN[name].label} of ${show(name, value)} is not a possible reading. ` +
        `Expected between ${show(name, low)} and ${show(name, high)}. Check what was typed.`,
    );
  }
  return value;
}

export type VitalFlag = {
  param: VitalName | 'bmi';
  level: 'ABNORMAL' | 'CRITICAL';
  /** As stored, so the flag can be read back without the original row. */
  value: number;
  /** In words: "below 90", "at or above 39.5 °C". */
  threshold: string;
  label: string;
};

/**
 * A band for one reading: outside `low`/`high` is abnormal, outside
 * `criticalLow`/`criticalHigh` is critical. Any bound may be absent, which
 * means that direction is not flagged.
 */
export type Band = {
  low?: number;
  high?: number;
  criticalLow?: number;
  criticalHigh?: number;
};

export type Thresholds = Partial<Record<VitalName | 'bmi', Band>>;

/**
 * §5's table, in the stored units.
 *
 * These are a starting point for a general practice, not a clinical
 * standard. The clinic's own doctor owns them (TRI-Q-01), which is why they
 * are tenant settings rather than constants.
 */
export const ADULT_THRESHOLDS: Thresholds = {
  systolic: { low: 100, high: 140, criticalLow: 90, criticalHigh: 180 },
  diastolic: { low: 60, high: 90, criticalHigh: 120 },
  heartRate: { low: 50, high: 100, criticalLow: 40, criticalHigh: 130 },
  respRate: { low: 12, high: 20, criticalLow: 8, criticalHigh: 30 },
  temperatureDc: { low: 355, high: 378, criticalLow: 350, criticalHigh: 395 },
  spo2: { low: 95, criticalLow: 90 },
  glucoseX10: { low: 40, high: 110, criticalLow: 30, criticalHigh: 200 },
  bmi: { low: 185, high: 275 },
  painScore: { high: 6 },
};

/**
 * Children are not small adults (TRI-F-03).
 *
 * A heart rate of 120 is an emergency in a man of fifty and unremarkable in
 * a toddler, so flagging a child against adult bands would bury the nurse
 * in false alarms and teach everyone to ignore the colour.
 *
 * **These are code defaults, not the clinic's numbers.** The adult bands are
 * tenant settings because the clinic's doctor owns them; the paediatric ones
 * are waiting on that same conversation (TRI-Q-01), and until it happens
 * these are a conservative starting point rather than an agreed standard.
 */
export const CHILD_THRESHOLDS: Thresholds = {
  ...ADULT_THRESHOLDS,
  systolic: { low: 80, high: 120, criticalLow: 70, criticalHigh: 140 },
  diastolic: { low: 45, high: 80, criticalHigh: 100 },
  heartRate: { low: 70, high: 140, criticalLow: 60, criticalHigh: 180 },
  respRate: { low: 18, high: 34, criticalLow: 12, criticalHigh: 50 },
  // Body mass index means something different in a growing child, and
  // reading it against adult cut-offs is worse than not reading it at all.
  bmi: undefined,
};

/** Under twelve, per TRI-F-03. */
export const CHILD_AGE_YEARS = 12;

export function thresholdsFor(ageYears: number | null, adult: Thresholds): Thresholds {
  if (ageYears !== null && ageYears < CHILD_AGE_YEARS) {
    // The clinic's adult numbers do not carry over to a child, so the
    // paediatric table is used whole rather than merged.
    return CHILD_THRESHOLDS;
  }
  return adult;
}

/** TRI-R-02: worked out here, never accepted from a client. */
export function computeBmiX10(weightG: number | null, heightMm: number | null): number | null {
  if (!weightG || !heightMm) return null;
  const metres = heightMm / 1000;
  const bmi = weightG / 1000 / (metres * metres);
  if (!Number.isFinite(bmi) || bmi <= 0) return null;
  return Math.round(bmi * 10);
}

type Reading = Partial<Record<VitalName | 'bmi', number | null>>;

/**
 * TRI-R-03: what was out of range, judged now, and stored.
 *
 * The result is written into the row rather than recomputed on read, so
 * that a clinic revising its thresholds next year does not silently change
 * what the nurse saw and acted on today.
 */
export function flagsFor(reading: Reading, thresholds: Thresholds): VitalFlag[] {
  const flags: VitalFlag[] = [];

  for (const [param, band] of Object.entries(thresholds) as Array<
    [VitalName | 'bmi', Band | undefined]
  >) {
    const value = reading[param];
    if (value === null || value === undefined || !band) continue;

    const label = param === 'bmi' ? 'Body mass index' : SPOKEN[param].label;
    const asText = (n: number) => (param === 'bmi' ? (n / 10).toFixed(1) : show(param, n));

    if (band.criticalLow !== undefined && value < band.criticalLow) {
      flags.push({ param, level: 'CRITICAL', value, threshold: `below ${asText(band.criticalLow)}`, label });
      continue;
    }
    if (band.criticalHigh !== undefined && value > band.criticalHigh) {
      flags.push({ param, level: 'CRITICAL', value, threshold: `above ${asText(band.criticalHigh)}`, label });
      continue;
    }
    if (band.low !== undefined && value < band.low) {
      flags.push({ param, level: 'ABNORMAL', value, threshold: `below ${asText(band.low)}`, label });
      continue;
    }
    if (band.high !== undefined && value > band.high) {
      flags.push({ param, level: 'ABNORMAL', value, threshold: `above ${asText(band.high)}`, label });
    }
  }

  return flags;
}

export function maxLevel(flags: VitalFlag[]): FlagLevel {
  if (flags.some((flag) => flag.level === 'CRITICAL')) return FlagLevel.CRITICAL;
  if (flags.length > 0) return FlagLevel.ABNORMAL;
  return FlagLevel.NONE;
}

/** A blood pressure pair has to make sense as a pair. */
export function assertBloodPressure(systolic: number | null, diastolic: number | null): void {
  if (systolic !== null && diastolic !== null && systolic <= diastolic) {
    throw new InvariantViolationError(
      'implausible_vital',
      `A blood pressure of ${systolic}/${diastolic} has the systolic at or below the diastolic, ` +
        'which is not a reading. Check the two numbers are the right way round.',
    );
  }
}
