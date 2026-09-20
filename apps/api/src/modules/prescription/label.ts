import { FREQUENCY_CODES, type FrequencyCode } from './frequency.js';

/**
 * What goes on the bag (RX-F-07, RX-N-03).
 *
 * This is the only part of the prescription the patient reads. It is
 * generated once, stored on the item, and printed from there — so the
 * label in the patient's hand and the label in the record are the same
 * string, and a change to this file next year does not silently rewrite
 * what somebody was told last year.
 *
 * Malay is the default because it is what the pilot clinic's patients
 * read, and a Malay label built by translating an English sentence word
 * by word reads like nothing anybody says. Each language has its own
 * sentence shape.
 */

export type Language = 'MS' | 'EN';

export type LabelInput = {
  displayName: string;
  strength?: string | null;
  doseValue: number;
  doseUnit: string;
  route: string;
  frequencyCode: FrequencyCode;
  frequencyPerDay?: number | null;
  isPrn: boolean;
  prnIndication?: string | null;
  durationDays?: number | null;
  untilFinished: boolean;
  instructions?: string | null;
};

/** The verb depends on what you do with it, not on what it is. */
const VERBS: Record<string, { ms: string; en: string }> = {
  PO: { ms: 'Ambil', en: 'Take' },
  SL: { ms: 'Letak di bawah lidah', en: 'Place under the tongue' },
  TOP: { ms: 'Sapu', en: 'Apply' },
  INH: { ms: 'Sedut', en: 'Inhale' },
  OPH: { ms: 'Titiskan pada mata', en: 'Instil into the eye' },
  OTIC: { ms: 'Titiskan pada telinga', en: 'Instil into the ear' },
  NASAL: { ms: 'Semburkan ke hidung', en: 'Spray into the nose' },
  PR: { ms: 'Masukkan ke dubur', en: 'Insert rectally' },
  PV: { ms: 'Masukkan ke faraj', en: 'Insert vaginally' },
  SC: { ms: 'Suntik di bawah kulit', en: 'Inject under the skin' },
  IM: { ms: 'Suntik ke dalam otot', en: 'Inject into the muscle' },
  IV: { ms: 'Suntik ke dalam vena', en: 'Inject into the vein' },
};

/**
 * How a patient counts the thing. "1 biji" is what a Malaysian patient
 * hears at the counter; "1 tab" is what a pharmacist writes.
 */
const UNIT_WORDS: Record<string, { ms: string; en: string; enPlural?: string }> = {
  tab: { ms: 'biji', en: 'tablet', enPlural: 'tablets' },
  cap: { ms: 'biji', en: 'capsule', enPlural: 'capsules' },
  ml: { ms: 'ml', en: 'ml' },
  mg: { ms: 'mg', en: 'mg' },
  g: { ms: 'g', en: 'g' },
  mcg: { ms: 'mcg', en: 'mcg' },
  sachet: { ms: 'paket', en: 'sachet', enPlural: 'sachets' },
  drop: { ms: 'titis', en: 'drop', enPlural: 'drops' },
  puff: { ms: 'sedutan', en: 'puff', enPlural: 'puffs' },
  application: { ms: 'sapuan', en: 'application', enPlural: 'applications' },
  unit: { ms: 'unit', en: 'unit', enPlural: 'units' },
  patch: { ms: 'kepingan', en: 'patch', enPlural: 'patches' },
  vial: { ms: 'vial', en: 'vial', enPlural: 'vials' },
  ampoule: { ms: 'ampul', en: 'ampoule', enPlural: 'ampoules' },
};

export function buildLabel(input: LabelInput, language: Language): string {
  const parts: string[] = [];

  const head = [input.displayName, input.strength?.trim()].filter(Boolean).join(' ');
  parts.push(head);

  const verb = VERBS[input.route]?.[language === 'MS' ? 'ms' : 'en']
    ?? (language === 'MS' ? 'Guna' : 'Use');

  const amount = amountPhrase(input.doseValue, input.doseUnit, language);
  const how = language === 'MS' ? `${verb} ${amount}` : `${verb} ${amount}`;

  const when = input.isPrn
    ? prnPhrase(input.prnIndication, language)
    : frequencyPhrase(input.frequencyCode, input.frequencyPerDay, language);

  const sentence = [how, when].filter(Boolean).join(', ');
  parts.push(sentence);

  const duration = durationPhrase(input, language);
  if (duration) parts.push(duration);

  const instructions = input.instructions?.trim();
  if (instructions) parts.push(instructions);

  return parts.join('. ').replace(/\s+/g, ' ').trim() + '.';
}

/**
 * "0.5 tab" on a label is a number the patient has to interpret at the
 * moment they are least able to. Halves and quarters get words.
 */
function amountPhrase(value: number, unit: string, language: Language): string {
  const words = UNIT_WORDS[unit] ?? { ms: unit, en: unit };

  if (language === 'MS') {
    if (value === 0.5) return `setengah ${words.ms}`;
    if (value === 0.25) return `suku ${words.ms}`;
    return `${number(value)} ${words.ms}`;
  }

  const singular = words.en;
  const plural = words.enPlural ?? words.en;
  if (value === 0.5) return `half a ${singular}`;
  if (value === 0.25) return `a quarter of a ${singular}`;
  return `${number(value)} ${value === 1 ? singular : plural}`;
}

function frequencyPhrase(
  code: FrequencyCode,
  custom: number | null | undefined,
  language: Language,
): string {
  if (code === 'CUSTOM') {
    const times = custom ?? 0;
    if (times <= 0) return '';
    return language === 'MS'
      ? `${number(times)} kali sehari`
      : `${number(times)} times a day`;
  }
  return FREQUENCY_CODES[code][language === 'MS' ? 'ms' : 'en'];
}

function prnPhrase(indication: string | null | undefined, language: Language): string {
  const base = language === 'MS' ? 'bila perlu' : 'when required';
  const reason = indication?.trim();
  if (!reason) return base;
  return language === 'MS' ? `${base} untuk ${reason}` : `${base} for ${reason}`;
}

function durationPhrase(input: LabelInput, language: Language): string {
  if (input.frequencyCode === 'STAT') return '';
  if (input.untilFinished) {
    return language === 'MS' ? 'Sehingga habis' : 'Until finished';
  }
  const days = input.durationDays;
  if (!days || days <= 0) return '';
  return language === 'MS'
    ? `Selama ${days} hari`
    : `For ${days} day${days === 1 ? '' : 's'}`;
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
