import type { AllergySeverity, AllergyStatus } from '../../generated/prisma/enums.js';

/**
 * The safety checks (RX-F-12 … F-16).
 *
 * The matching is pure so it can be tested exhaustively, because the
 * failure that matters here is not a crash — it is a warning that does
 * not fire. A missed penicillin allergy looks exactly like a patient
 * with no allergies, right up until it doesn't.
 *
 * The opposite failure is real too. A banner that appears on every item
 * gets clicked through, and then the one that mattered gets clicked
 * through with it. So there are four kinds of warning and no more, each
 * one says what to do about it, and none of them fire twice for the same
 * reason.
 */

export type WarningType = 'ALLERGY' | 'DUPLICATE' | 'NO_ALLERGY_RECORD' | 'MAX_DOSE' | 'OUT_OF_STOCK';

/**
 * EXACT is the same substance. CLASS is a relative of it. UNLINKED means
 * the patient has an allergy written in words that was never tied to
 * anything in the catalogue, so no computer can tell whether this is it
 * — which is itself worth saying, every time (RX-N-02).
 */
export type AllergyMatchLevel = 'EXACT' | 'CLASS' | 'UNLINKED';

export type Warning =
  | {
      type: 'ALLERGY';
      level: AllergyMatchLevel;
      severity: AllergySeverity | null;
      status: AllergyStatus;
      allergyId: string;
      substance: string;
      reaction: string | null;
      message: string;
    }
  | {
      type: 'DUPLICATE';
      itemId: string;
      genericName: string;
      prescribedAt: string;
      doctorName: string | null;
      branchName: string | null;
      sameVisit: boolean;
      message: string;
    }
  | { type: 'NO_ALLERGY_RECORD'; message: string }
  | { type: 'MAX_DOSE'; dailyDose: number; maxDailyDose: number; unit: string; message: string }
  | { type: 'OUT_OF_STOCK'; onHand: number; message: string };

/** What the item is, as far as an allergy check is concerned. */
export type ItemSubstance = {
  productId: string | null;
  genericName: string;
  drugClass: string | null;
  displayName: string;
};

export type AllergyRecord = {
  id: string;
  productId: string | null;
  substance: string;
  drugClass: string | null;
  reaction: string | null;
  severity: AllergySeverity | null;
  status: AllergyStatus;
};

/**
 * RX-F-12. Refuted allergies are the caller's job to exclude; everything
 * passed in is treated as live.
 *
 * One warning per allergy record, at the strongest level that matches, so
 * a patient allergic to both "Amoxicillin" and "Penicillin" gets two
 * warnings rather than four.
 */
export function matchAllergies(item: ItemSubstance, allergies: readonly AllergyRecord[]): Warning[] {
  const out: Warning[] = [];

  for (const allergy of allergies) {
    const level = levelFor(item, allergy);
    if (!level) continue;
    out.push({
      type: 'ALLERGY',
      level,
      severity: allergy.severity,
      status: allergy.status,
      allergyId: allergy.id,
      substance: allergy.substance,
      reaction: allergy.reaction,
      message: messageFor(item, allergy, level),
    });
  }

  return out;
}

function levelFor(item: ItemSubstance, allergy: AllergyRecord): AllergyMatchLevel | null {
  if (allergy.productId && item.productId && allergy.productId === item.productId) return 'EXACT';

  const substance = normalise(allergy.substance);
  if (substance && substance === normalise(item.genericName)) return 'EXACT';
  if (substance && substance === normalise(item.displayName)) return 'EXACT';

  if (allergy.drugClass && item.drugClass && normalise(allergy.drugClass) === normalise(item.drugClass)) {
    return 'CLASS';
  }

  // The allergy was typed in as words and never linked to a product or a
  // class. It could be this drug and nothing here can tell. Saying so is
  // the only honest answer (RX-N-02) — silence would read as "checked,
  // nothing found", which is not what happened.
  if (!allergy.productId && !allergy.drugClass) return 'UNLINKED';

  return null;
}

function messageFor(item: ItemSubstance, allergy: AllergyRecord, level: AllergyMatchLevel): string {
  const severity = allergy.severity ? `${titleCase(allergy.severity)}, ` : '';
  const status = titleCase(allergy.status);
  const reaction = allergy.reaction ? ` — ${allergy.reaction}` : '';

  switch (level) {
    case 'EXACT':
      return `Allergy to ${allergy.substance} (${severity}${status})${reaction}. ${item.displayName} is the same substance.`;
    case 'CLASS':
      return `Allergy to ${allergy.substance} (${severity}${status})${reaction}. ${item.displayName} is in the same class (${item.drugClass}).`;
    case 'UNLINKED':
      return `Patient has a recorded allergy to "${allergy.substance}" that is not linked to the catalogue. Check by hand whether it applies to ${item.displayName}.`;
  }
}

/**
 * RX-R-04: the one warning that stops a signature rather than informing
 * it. Narrow on purpose — it is only worth blocking on the case where
 * proceeding could kill someone, and only where the match is certain.
 */
export function needsSignConfirmation(warnings: readonly Warning[]): boolean {
  return warnings.some(
    (w) =>
      w.type === 'ALLERGY' &&
      w.level === 'EXACT' &&
      (w.severity === 'SEVERE' || w.severity === 'LIFE_THREATENING'),
  );
}

/** Whether anything here needs a reason before the item can be prescribed. */
export function needsOverride(warnings: readonly Warning[]): boolean {
  return warnings.some((w) => w.type === 'ALLERGY' && w.level !== 'UNLINKED');
}

export function maxDoseWarning(
  dailyDose: number,
  maxDailyDose: number,
  unit: string,
): Warning | null {
  if (!(dailyDose > maxDailyDose)) return null;
  return {
    type: 'MAX_DOSE',
    dailyDose: round3(dailyDose),
    maxDailyDose: round3(maxDailyDose),
    unit,
    message: `This works out at ${round3(dailyDose)} ${unit} a day, above the recorded maximum of ${round3(maxDailyDose)} ${unit}.`,
  };
}

/**
 * RX-F-04: the shelf cannot cover this.
 *
 * Amber, never blocking. A doctor prescribing something the clinic has
 * run out of is making a clinical decision that is still correct — the
 * pharmacy substitutes it, or the patient gets it elsewhere. What would
 * be wrong is letting them find out at the counter.
 */
export function outOfStockWarning(
  displayName: string,
  needed: number,
  onHand: number,
  unit: string,
): Warning | null {
  if (onHand >= needed) return null;
  return {
    type: 'OUT_OF_STOCK',
    onHand,
    message:
      onHand <= 0
        ? `There is no ${displayName} on the shelf at this branch. It can still be prescribed; the pharmacy will substitute it or send the patient elsewhere.`
        : `Only ${onHand} ${unit} of ${displayName} on the shelf, and this needs ${needed}.`,
  };
}

export const NO_ALLERGY_RECORD: Warning = {
  type: 'NO_ALLERGY_RECORD',
  message:
    'Nobody has recorded whether this patient has allergies. Record them, or record "no known drug allergies", before prescribing.',
};

function normalise(value: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
