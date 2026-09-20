import { z } from 'zod';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { patchGroup } from './settings/tenant-settings.js';

/**
 * TEN-F-10: what a printed document carries at the top and the bottom.
 *
 * `DOC` (v0-13) renders these; tenancy only stores them. The text is kept
 * separate from the logo because most clinics will set the text once and never
 * upload anything, and because an image should not be dragged along by every
 * read of a branch.
 */
export const letterheadSchema = z
  .object({
    headerText: z
      .string()
      .max(500)
      .default('')
      .describe('Printed under the logo: the clinic name, registration number, address.'),
    footerText: z
      .string()
      .max(500)
      .default('')
      .describe('Printed at the foot of every page, such as the licence and a thank-you line.'),
  })
  .strict();

export type Letterhead = z.infer<typeof letterheadSchema>;

export const DEFAULT_LETTERHEAD: Letterhead = letterheadSchema.parse({});

/**
 * A change to one field only. The defaults have to be stripped, not merely
 * made optional: `.partial()` leaves each field a `ZodDefault`, so setting the
 * footer alone would quietly blank the header.
 */
export const letterheadPatchSchema = patchGroup(letterheadSchema);

export function resolveLetterhead(stored: unknown): Letterhead {
  const parsed = letterheadSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DEFAULT_LETTERHEAD;
}

/** Small enough to be embedded in a PDF without thought. */
export const MAX_LOGO_BYTES = 512 * 1024;

const ALLOWED = new Map<string, string>([
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/svg+xml', 'SVG'],
]);

const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/svg+xml',
    test: (b) => {
      const head = b.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
      return head.startsWith('<svg') || head.startsWith('<?xml');
    },
  },
];

/**
 * Checks the bytes, not the declared type.
 *
 * A browser will happily send `image/png` for anything, and this file is
 * served back to other people's browsers, so what it actually is decides what
 * it is stored as. An SVG is a document that can carry script, so it is served
 * with a content-disposition and a restrictive policy by the route, not here.
 */
export function assertLogo(file: { buffer: Buffer; mimetype?: string } | undefined): {
  buffer: Buffer;
  mime: string;
} {
  if (!file?.buffer?.length) {
    throw new BadRequestError('No image was uploaded.', 'letterhead_missing');
  }
  if (file.buffer.length > MAX_LOGO_BYTES) {
    throw new BadRequestError(
      `That image is ${Math.round(file.buffer.length / 1024)} KB. The limit is 512 KB — a logo ` +
        'for a printed page does not need more.',
      'letterhead_too_large',
    );
  }

  const detected = MAGIC.find((candidate) => candidate.test(file.buffer))?.mime;
  if (!detected || !ALLOWED.has(detected)) {
    throw new BadRequestError(
      `That file is not an image this can print. Use ${[...ALLOWED.values()].join(', ')}.`,
      'letterhead_wrong_type',
    );
  }
  return { buffer: file.buffer, mime: detected };
}
