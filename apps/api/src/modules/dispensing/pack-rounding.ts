/**
 * DSP-F-06: some things are handed over whole.
 *
 * A prescription for 37.5 ml of a syrup that comes in 60 ml bottles is a
 * prescription for one bottle. The rounding is upward — a patient sent
 * home with less than the course is a patient who does not finish it —
 * and it is always shown, because the difference between what was
 * prescribed and what was billed has to be visible on the bill.
 */
export type PackRounding = {
  quantity: number;
  packRounded: boolean;
  /** Shown beside the quantity so nobody has to work out why it changed. */
  note: string | null;
};

export function roundToPacks(
  prescribed: number,
  options: { isPackDispensed: boolean; packSize: number; dispenseUnit: string },
): PackRounding {
  if (!options.isPackDispensed || options.packSize <= 1) {
    return { quantity: round3(prescribed), packRounded: false, note: null };
  }

  const packs = Math.ceil(round3(prescribed / options.packSize));
  const quantity = round3(packs * options.packSize);

  if (quantity === round3(prescribed)) {
    return { quantity, packRounded: false, note: null };
  }

  return {
    quantity,
    packRounded: true,
    note:
      `Prescribed ${fmt(prescribed)}; handed over as ${packs} ` +
      `pack${packs === 1 ? '' : 's'} of ${options.packSize} ` +
      `(${fmt(quantity)} ${options.dispenseUnit}).`,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round3(value));
}
