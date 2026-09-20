import { BadRequestError } from '../../shared/errors/domain-errors.js';

/**
 * §12 of the patient specification, in one place.
 *
 * These run on the way in, before anything is stored, so the database only
 * ever holds values in one shape. Search depends on that: a phone number
 * written four ways is a patient nobody can find.
 */

const POSTCODE = /^\d{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A name, tidied. Double spaces inside a name are a paste, not a choice. */
export function assertName(raw: string): string {
  const name = raw.trim().replaceAll(/\s+/g, ' ');
  if (name.length < 2 || name.length > 150) {
    throw new BadRequestError(
      'A name is between two and a hundred and fifty characters.',
      'invalid_name',
    );
  }
  return name;
}

/**
 * Malaysian numbers to E.164.
 *
 * Reception will type `012-345 6789`, `0123456789` and `+60123456789` for the
 * same person on different days. All three have to become one stored value or
 * searching by phone finds nothing.
 *
 * Numbers that are clearly not Malaysian are kept as given with a leading
 * plus, because a foreign worker's home number is still worth having.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;

  const digits = value.replaceAll(/[^\d+]/g, '');
  if (digits === '' || digits === '+') return null;

  if (digits.startsWith('+')) {
    const rest = digits.slice(1);
    if (!/^\d{7,15}$/.test(rest)) {
      throw new BadRequestError('That telephone number is not a usable length.', 'invalid_phone');
    }
    return `+${rest}`;
  }

  // A local number: 0 then the national number.
  if (digits.startsWith('0')) {
    const national = digits.slice(1);
    if (!/^\d{8,11}$/.test(national)) {
      throw new BadRequestError(
        'A Malaysian number is like 012-345 6789 or 03-1234 5678.',
        'invalid_phone',
      );
    }
    return `+60${national}`;
  }

  if (digits.startsWith('60') && /^\d{10,13}$/.test(digits)) return `+${digits}`;

  throw new BadRequestError(
    'Telephone numbers start with 0 for a Malaysian number, or + and the country code.',
    'invalid_phone',
  );
}

/** How a stored E.164 number is shown back to a Malaysian reader. */
export function displayPhone(e164: string | null): string | null {
  if (!e164) return null;
  if (!e164.startsWith('+60')) return e164;
  const national = e164.slice(3);
  // Mobile numbers are 1x, and are read in two groups after the prefix.
  if (national.startsWith('1') && national.length >= 9) {
    return `0${national.slice(0, 2)}-${national.slice(2, 5)} ${national.slice(5)}`;
  }
  return `0${national.slice(0, 1)}-${national.slice(1, 5)} ${national.slice(5)}`;
}

export function assertPostcode(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  if (!POSTCODE.test(value)) {
    throw new BadRequestError('A Malaysian postcode is five digits.', 'invalid_postcode');
  }
  return value;
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return null;
  if (value.length > 254 || !EMAIL.test(value)) {
    throw new BadRequestError('That email address does not look right.', 'invalid_email');
  }
  return value;
}

/**
 * A date of birth that could belong to a living patient.
 *
 * The future is rejected outright. So is anything past a hundred and twenty
 * years, which is beyond the oldest person who has ever lived and is
 * therefore a typing error rather than a remarkable patient.
 */
export function assertDateOfBirth(
  raw: string | Date | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const date = raw instanceof Date ? raw : new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError('That date of birth is not a date.', 'invalid_dob');
  }
  if (date.getTime() > now.getTime()) {
    throw new BadRequestError('A date of birth cannot be in the future.', 'invalid_dob');
  }
  const years = (now.getTime() - date.getTime()) / (365.2425 * 24 * 3600 * 1000);
  if (years > 120) {
    throw new BadRequestError(
      'That date of birth is more than a hundred and twenty years ago. Check the year.',
      'invalid_dob',
    );
  }
  return date;
}

/** Whole years, which is how a clinic says an age. */
export function ageInYears(dateOfBirth: Date | null, now: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const month = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (month < 0 || (month === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;
  return Math.max(0, age);
}

/**
 * How an age is said out loud. A four-day-old and a four-year-old are both
 * "4" to arithmetic and are not remotely the same patient.
 */
export function describeAge(dateOfBirth: Date | null, now: Date = new Date()): string | null {
  if (!dateOfBirth) return null;
  const days = Math.floor((now.getTime() - dateOfBirth.getTime()) / (24 * 3600 * 1000));
  if (days < 0) return null;
  if (days < 31) return `${days} d`;
  const months = Math.max(1, Math.floor(days / 30.44));
  if (months < 24) return `${months} mo`;
  return `${ageInYears(dateOfBirth, now)} y`;
}

export function assertAllergySubstance(raw: string): string {
  const substance = raw.trim().replaceAll(/\s+/g, ' ');
  if (substance.length < 2 || substance.length > 120) {
    throw new BadRequestError(
      'Name the substance, between two and a hundred and twenty characters.',
      'invalid_substance',
    );
  }
  return substance;
}
