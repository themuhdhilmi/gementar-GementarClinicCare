import { BadRequestError } from '../../shared/errors/domain-errors.js';

/** §12: two to eight capitals or digits, and it ends up in document numbers. */
const CODE = /^[A-Z0-9]{2,8}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const POSTCODE = /^\d{5}$/;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type OperatingHours = Partial<Record<(typeof DAYS)[number], Array<[string, string]>>>;

export function assertBranchCode(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!CODE.test(upper)) {
    throw new BadRequestError(
      'A branch code is two to eight letters or digits, such as KL01. It appears in invoice numbers, so keep it short.',
      'invalid_branch_code',
    );
  }
  return upper;
}

export function assertPostcode(postcode: string | null | undefined): string | null {
  if (postcode === null || postcode === undefined || postcode.trim() === '') return null;
  const trimmed = postcode.trim();
  if (!POSTCODE.test(trimmed)) {
    throw new BadRequestError('A Malaysian postcode is five digits.', 'invalid_postcode');
  }
  return trimmed;
}

/**
 * §12: `HH:MM` on a 24-hour clock, and the ranges within a day may not
 * overlap. A clinic that closes for lunch has two ranges; one that does not
 * has one.
 */
export function assertOperatingHours(hours: unknown): OperatingHours {
  if (hours === null || hours === undefined) return {};
  if (typeof hours !== 'object' || Array.isArray(hours)) {
    throw new BadRequestError('Operating hours must be given per day.', 'invalid_operating_hours');
  }

  const out: OperatingHours = {};
  for (const [day, ranges] of Object.entries(hours as Record<string, unknown>)) {
    if (!DAYS.includes(day as (typeof DAYS)[number])) {
      throw new BadRequestError(
        `"${day}" is not a day. Use ${DAYS.join(', ')}.`,
        'invalid_operating_hours',
      );
    }
    if (!Array.isArray(ranges)) {
      throw new BadRequestError(
        `Opening times for ${day} must be a list of ranges.`,
        'invalid_operating_hours',
      );
    }

    const parsed: Array<[string, string]> = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every((t) => typeof t === 'string' && TIME.test(t))) {
        throw new BadRequestError(
          `Opening times for ${day} must be pairs like ["09:00","13:00"].`,
          'invalid_operating_hours',
        );
      }
      const [from, to] = range as [string, string];
      if (from >= to) {
        throw new BadRequestError(
          `On ${day}, ${from} to ${to} does not go forwards. A range that crosses midnight has to be split.`,
          'invalid_operating_hours',
        );
      }
      parsed.push([from, to]);
    }

    parsed.sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < parsed.length; i += 1) {
      if (parsed[i]![0] < parsed[i - 1]![1]) {
        throw new BadRequestError(
          `On ${day}, ${parsed[i - 1]![0]}–${parsed[i - 1]![1]} and ${parsed[i]![0]}–${parsed[i]![1]} overlap.`,
          'invalid_operating_hours',
        );
      }
    }
    if (parsed.length > 0) out[day as (typeof DAYS)[number]] = parsed;
  }
  return out;
}
