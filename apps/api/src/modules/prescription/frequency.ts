/**
 * How often a medicine is taken.
 *
 * Doctors write TDS, not "three times a day", and a free-text frequency
 * cannot be turned into a quantity or a label. So the codes are a closed
 * list with a number attached, and anything outside it is CUSTOM with the
 * number stated explicitly.
 *
 * The numbers are doses per day. Q4H is six because a day has six
 * four-hour intervals — which is not the same as "four", and getting it
 * backwards would dispense two thirds of a course.
 */
export const FREQUENCY_CODES = {
  OD: { perDay: 1, ms: 'sekali sehari', en: 'once a day' },
  BD: { perDay: 2, ms: '2 kali sehari', en: 'twice a day' },
  TDS: { perDay: 3, ms: '3 kali sehari', en: 'three times a day' },
  QID: { perDay: 4, ms: '4 kali sehari', en: 'four times a day' },
  Q4H: { perDay: 6, ms: 'setiap 4 jam', en: 'every 4 hours' },
  Q6H: { perDay: 4, ms: 'setiap 6 jam', en: 'every 6 hours' },
  Q8H: { perDay: 3, ms: 'setiap 8 jam', en: 'every 8 hours' },
  ON: { perDay: 1, ms: 'sekali sebelum tidur', en: 'at night' },
  OM: { perDay: 1, ms: 'sekali pada waktu pagi', en: 'in the morning' },
  STAT: { perDay: 1, ms: 'sekali sahaja, sekarang', en: 'once only, now' },
  WEEKLY: { perDay: 1 / 7, ms: 'sekali seminggu', en: 'once a week' },
  /**
   * When required. Deliberately has no rate: a PRN quantity cannot be
   * calculated, because how often the patient needs it is the thing
   * nobody knows. The doctor states the quantity.
   */
  PRN: { perDay: null, ms: 'bila perlu', en: 'when required' },
} as const;

export type FrequencyCode = keyof typeof FREQUENCY_CODES | 'CUSTOM';

export function isFrequencyCode(value: string): value is FrequencyCode {
  return value === 'CUSTOM' || value in FREQUENCY_CODES;
}

/**
 * Doses per day for a code. CUSTOM has to be told, because that is what
 * makes it custom; a CUSTOM without a number is a validation error the
 * caller reports, not a silent zero.
 */
export function perDay(code: FrequencyCode, custom?: number | null): number | null {
  if (code === 'CUSTOM') return custom ?? null;
  return FREQUENCY_CODES[code].perDay;
}

/** STAT is a single dose whatever the duration field says. */
export function isSingleDose(code: FrequencyCode): boolean {
  return code === 'STAT';
}
