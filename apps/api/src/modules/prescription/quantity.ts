import { FREQUENCY_CODES, isSingleDose, perDay, type FrequencyCode } from './frequency.js';

/**
 * How much to hand over (RX-F-03).
 *
 * The arithmetic is units-per-dose × doses-per-day × days. The part worth
 * care is units-per-dose, because a doctor writes the dose in milligrams
 * and the pharmacy hands over tablets. 500 mg of a 250 mg tablet is two
 * tablets, and getting that division backwards is a fourfold error in
 * either direction.
 *
 * So the conversion only happens when the strength is actually known, and
 * every case that cannot be computed returns null rather than a guess. An
 * empty quantity field asks the doctor to fill it in; a confidently wrong
 * one does not get checked.
 */

/** Units you cannot hand over a fraction of. */
const DISCRETE_UNITS = new Set([
  'tab', 'cap', 'sachet', 'pcs', 'vial', 'ampoule', 'patch', 'bottle', 'tube', 'unit',
]);

/**
 * Scale to a base unit, within one dimension. Cross-dimension conversion
 * is absent on purpose: milligrams to millilitres needs a concentration,
 * and assuming one is how you get a tenfold paediatric overdose.
 */
const SCALE: Record<string, { dimension: string; factor: number }> = {
  mcg: { dimension: 'mass', factor: 0.001 },
  mg: { dimension: 'mass', factor: 1 },
  g: { dimension: 'mass', factor: 1000 },
  ml: { dimension: 'volume', factor: 1 },
  l: { dimension: 'volume', factor: 1000 },
};

export type QuantityInput = {
  doseValue: number;
  /** The unit the dose is written in: 1 tab, 500 mg, 5 ml. */
  doseUnit: string;
  frequencyCode: FrequencyCode;
  frequencyPerDay?: number | null;
  durationDays?: number | null;
  untilFinished: boolean;
  /** What the product is handed over in. Null for an external item. */
  dispenseUnit?: string | null;
  /** How much of the substance is in one dispensing unit. */
  strengthValue?: number | null;
  strengthUnit?: string | null;
};

export type QuantityResult = {
  quantity: number;
  unit: string;
  /** Shown beside the field so the doctor can check the arithmetic. */
  formula: string;
};

export function calculateQuantity(input: QuantityInput): QuantityResult | null {
  const unit = input.dispenseUnit ?? input.doseUnit;

  const perDose = unitsPerDose(input, unit);
  if (perDose === null) return null;

  // A single dose is one dose, whatever else is filled in.
  if (isSingleDose(input.frequencyCode)) {
    return {
      quantity: roundFor(unit, perDose),
      unit,
      formula: `${fmt(perDose)} ${unit} × 1 (STAT) = ${fmt(roundFor(unit, perDose))} ${unit}`,
    };
  }

  // Nothing to multiply by: PRN has no rate, "until finished" has no end.
  const rate = perDay(input.frequencyCode, input.frequencyPerDay);
  if (rate === null || rate <= 0) return null;
  if (input.untilFinished) return null;
  if (!input.durationDays || input.durationDays <= 0) return null;

  const raw = perDose * rate * input.durationDays;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const rateLabel = input.frequencyCode === 'CUSTOM'
    ? `${fmt(rate)}/day`
    : `${input.frequencyCode} (${fmt(FREQUENCY_CODES[input.frequencyCode].perDay ?? rate)}/day)`;
  const days = `${input.durationDays} day${input.durationDays === 1 ? '' : 's'}`;
  const total = roundFor(unit, raw);

  return {
    quantity: total,
    unit,
    formula: `${fmt(perDose)} ${unit} × ${rateLabel} × ${days} = ${fmt(total)} ${unit}`,
  };
}

/**
 * How many dispensing units make up one dose.
 *
 * Exported because the label needs it too: a patient reads "take one
 * capsule", not "take 500 mg", and works out the rest themselves only if
 * we make them.
 *
 * Three cases, in order of how sure we are: the dose is already written
 * in the dispensing unit; the dose is in the same dimension as the
 * product's strength and can be divided by it; or we do not know.
 */
export function unitsPerDose(input: QuantityInput, unit: string): number | null {
  if (input.doseValue <= 0) return null;
  if (input.doseUnit === unit) return input.doseValue;

  const { strengthValue, strengthUnit } = input;
  if (!strengthValue || strengthValue <= 0 || !strengthUnit) return null;

  const dose = SCALE[input.doseUnit.toLowerCase()];
  const strength = SCALE[strengthUnit.toLowerCase()];
  if (!dose || !strength || dose.dimension !== strength.dimension) return null;

  return (input.doseValue * dose.factor) / (strengthValue * strength.factor);
}

function roundFor(unit: string, value: number): number {
  // A course cut short because the arithmetic left 0.4 of a tablet is a
  // course not completed, so discrete units always round up.
  if (DISCRETE_UNITS.has(unit)) return Math.ceil(round3(value));
  // Three decimals is what the column holds, and finer than any pharmacy
  // can measure out.
  return round3(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round3(value));
}

export function isDiscreteUnit(unit: string): boolean {
  return DISCRETE_UNITS.has(unit);
}
