import { Gender, IdType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';

/**
 * Malaysian identity documents, and what can be read off them.
 *
 * A MyKad number is not an opaque string. `YYMMDD-PB-###G` carries the date
 * of birth, the place of birth and the sex of the holder, which is why
 * registration can fill in three fields from one (PAT-F-02). Every derived
 * value is a suggestion the receptionist can overrule, because the card in
 * front of them is the authority and this is arithmetic.
 */

const MYKAD = /^(\d{6})-?(\d{2})-?(\d{4})$/;
const PASSPORT = /^[A-Z0-9]{5,20}$/;

export type DerivedIdentity = {
  /** The number with punctuation removed, which is how it is stored. */
  idNumber: string;
  dateOfBirth?: Date;
  gender?: Gender;
  /** Shown beside a prefilled field, so nobody trusts it silently. */
  warnings: string[];
};

/** `900101145678` becomes `900101-14-5678`, which is how a card reads. */
export function formatMyKad(digits: string): string {
  if (digits.length !== 12) return digits;
  return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

/**
 * The century a two-digit year means.
 *
 * A MyKad does not record it. Treating the year as this century unless that
 * would put the birth in the future is right for everyone under about a
 * hundred, and wrong for a centenarian, who will be registered as a newborn.
 * There is no cleverer rule that is also correct: the place-of-birth code
 * hints at an era but was reissued. So it is a prefill with a warning, and
 * the receptionist looking at the card corrects it.
 */
function resolveCentury(yy: number, mm: number, dd: number, today: Date): Date {
  const thisCentury = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (thisCentury.getTime() <= today.getTime()) return thisCentury;
  return new Date(Date.UTC(1900 + yy, mm - 1, dd));
}

function isRealDate(date: Date, yy: number, mm: number, dd: number): boolean {
  return (
    date.getUTCFullYear() % 100 === yy &&
    date.getUTCMonth() === mm - 1 &&
    date.getUTCDate() === dd
  );
}

/**
 * Reads what a MyKad or MyKid number says about its holder.
 *
 * The date portion is validated as a real calendar date, which catches the
 * commonest typing error by far: a transposition that produces the 31st of
 * February or a thirteenth month.
 */
export function deriveFromMyKad(raw: string, now: Date = new Date()): DerivedIdentity {
  const cleaned = raw.trim().toUpperCase();
  const match = MYKAD.exec(cleaned);
  if (!match) {
    throw new BadRequestError(
      'A MyKad number is twelve digits, written 900101-14-5678.',
      'invalid_mykad',
    );
  }

  const [, datePart, , serial] = match as unknown as [string, string, string, string];
  const yy = Number(datePart.slice(0, 2));
  const mm = Number(datePart.slice(2, 4));
  const dd = Number(datePart.slice(4, 6));

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    throw new BadRequestError(
      `The first six digits of a MyKad are a date, and ${datePart} is not one.`,
      'invalid_mykad',
    );
  }

  const dateOfBirth = resolveCentury(yy, mm, dd, now);
  if (!isRealDate(dateOfBirth, yy, mm, dd)) {
    throw new BadRequestError(
      `${dd}/${mm} is not a real date, so ${datePart} cannot be the start of a MyKad number.`,
      'invalid_mykad',
    );
  }

  const warnings: string[] = [];
  const age = (now.getTime() - dateOfBirth.getTime()) / (365.2425 * 24 * 3600 * 1000);
  if (age > 95) {
    warnings.push(
      'The year on this card could be either century. Check the date of birth against the card.',
    );
  }

  // The last digit: odd is male, even is female. There is no third value on
  // the card, so a patient who is neither is recorded from what they say
  // rather than from this.
  const gender = Number(serial.slice(-1)) % 2 === 1 ? Gender.MALE : Gender.FEMALE;

  return { idNumber: datePart + match[2] + serial, dateOfBirth, gender, warnings };
}

/** Checks and canonicalises an identity document of any supported kind. */
export function normaliseIdentity(
  idType: IdType,
  raw: string | null | undefined,
  options: { passportCountry?: string | null; now?: Date } = {},
): DerivedIdentity {
  const value = (raw ?? '').trim();

  if (idType === IdType.NONE) {
    if (value !== '') {
      throw new BadRequestError(
        'This patient is recorded as having no identity document, so there is no number to store.',
        'invalid_identity',
      );
    }
    return { idNumber: '', warnings: [] };
  }

  if (value === '') {
    throw new BadRequestError(
      'An identity number is needed. Choose "No document" if the patient has none.',
      'invalid_identity',
    );
  }

  if (idType === IdType.MYKAD || idType === IdType.MYKID) {
    return deriveFromMyKad(value, options.now);
  }

  if (idType === IdType.PASSPORT) {
    const passport = value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
    if (!PASSPORT.test(passport)) {
      throw new BadRequestError(
        'A passport number is five to twenty letters and digits.',
        'invalid_passport',
      );
    }
    if (!options.passportCountry || !/^[A-Z]{2}$/.test(options.passportCountry.toUpperCase())) {
      // Two countries issue the same number to different people, and the
      // uniqueness rule is on the pair (PAT §14).
      throw new BadRequestError(
        'A passport needs its issuing country, as a two-letter code such as ID or BD.',
        'invalid_passport',
      );
    }
    return { idNumber: passport, warnings: [] };
  }

  const other = value.toUpperCase().replaceAll(/\s+/g, '');
  if (other.length < 3 || other.length > 40) {
    throw new BadRequestError('That identity number is not a usable length.', 'invalid_identity');
  }
  return { idNumber: other, warnings: [] };
}

/** The last four digits, which is what the counter searches on. */
export function lastFour(idNumber: string): string | null {
  const digits = idNumber.replaceAll(/[^A-Za-z0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4).toUpperCase() : null;
}

/**
 * PAT-F-24: what a screen shows unless someone asks to see the whole thing.
 *
 * The last four stay visible because that is how a patient confirms who they
 * are at the counter. Everything before them is hidden, and the grouping is
 * kept so the number still looks like the card it came from.
 */
export function maskIdNumber(idType: IdType, idNumber: string | null): string | null {
  if (!idNumber) return null;
  if (idType === IdType.MYKAD || idType === IdType.MYKID) {
    const tail = idNumber.slice(-4);
    return `••••••-••-${tail}`;
  }
  if (idNumber.length <= 4) return '•'.repeat(idNumber.length);
  return '•'.repeat(idNumber.length - 4) + idNumber.slice(-4);
}

/** How a full number is shown once someone has asked and been audited. */
export function displayIdNumber(idType: IdType, idNumber: string | null): string | null {
  if (!idNumber) return null;
  if (idType === IdType.MYKAD || idType === IdType.MYKID) return formatMyKad(idNumber);
  return idNumber;
}
