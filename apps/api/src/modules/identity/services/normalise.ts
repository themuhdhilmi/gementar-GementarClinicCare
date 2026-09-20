import { BadRequestError } from '../../../shared/errors/domain-errors.js';

/** Lower-cased and trimmed, so `A@x.com` and `a@x.com` are the same person. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function assertEmail(email: string): string {
  const normalised = normaliseEmail(email);
  if (normalised.length > 254 || !EMAIL_RE.test(normalised)) {
    throw new BadRequestError('That email address does not look right.', 'invalid_email');
  }
  return normalised;
}

/**
 * Malaysian numbers are typed as `012-3456789`; everything is stored as E.164.
 * A number from anywhere else is accepted as long as it already carries a `+`.
 */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const trimmed = phone.trim();
  if (trimmed === '') return null;

  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    if (!/^\+\d{7,15}$/.test(digits)) {
      throw new BadRequestError('Enter the phone number in international format.', 'invalid_phone');
    }
    return digits;
  }
  if (digits.startsWith('60')) return `+${digits}`;
  if (digits.startsWith('0')) return `+60${digits.slice(1)}`;
  throw new BadRequestError(
    'Enter a Malaysian number starting 0, or an international number starting +.',
    'invalid_phone',
  );
}

export function normaliseName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1 || trimmed.length > 120) {
    throw new BadRequestError('Name must be between 1 and 120 characters.', 'invalid_name');
  }
  return trimmed;
}
