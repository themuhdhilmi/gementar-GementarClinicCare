import { describe, expect, it } from 'vitest';
import { buildLabel } from './label.js';

const amoxicillin = {
  displayName: 'Amoxicillin',
  strength: '500 mg',
  doseValue: 1,
  doseUnit: 'tab',
  route: 'PO',
  frequencyCode: 'TDS' as const,
  frequencyPerDay: null,
  isPrn: false,
  prnIndication: null,
  durationDays: 5,
  untilFinished: false,
  instructions: 'selepas makan',
};

describe('RX-F-07 / RX-N-03 — label text', () => {
  it('RX-T-10: reads as Malay for a Malay-speaking patient', () => {
    const label = buildLabel(amoxicillin, 'MS');
    expect(label).toBe('Amoxicillin 500 mg. Ambil 1 biji, 3 kali sehari. Selama 5 hari. selepas makan.');
  });

  it('reads as English for an English-speaking patient', () => {
    const label = buildLabel({ ...amoxicillin, instructions: 'after food' }, 'EN');
    expect(label).toBe('Amoxicillin 500 mg. Take 1 tablet, three times a day. For 5 days. after food.');
  });

  it('is deterministic', () => {
    expect(buildLabel(amoxicillin, 'MS')).toBe(buildLabel(amoxicillin, 'MS'));
  });

  it('writes a half tablet in words', () => {
    expect(buildLabel({ ...amoxicillin, doseValue: 0.5 }, 'MS')).toContain('Ambil setengah biji');
    expect(buildLabel({ ...amoxicillin, doseValue: 0.5 }, 'EN')).toContain('Take half a tablet');
    expect(buildLabel({ ...amoxicillin, doseValue: 0.25 }, 'EN')).toContain('a quarter of a tablet');
  });

  it('pluralises in English and does not try to in Malay', () => {
    expect(buildLabel({ ...amoxicillin, doseValue: 2 }, 'EN')).toContain('Take 2 tablets');
    expect(buildLabel({ ...amoxicillin, doseValue: 2 }, 'MS')).toContain('Ambil 2 biji');
  });

  it('uses the verb for the route', () => {
    const cream = { ...amoxicillin, route: 'TOP', doseUnit: 'application', instructions: null };
    expect(buildLabel(cream, 'MS')).toContain('Sapu 1 sapuan');
    expect(buildLabel(cream, 'EN')).toContain('Apply 1 application');

    const inhaler = { ...amoxicillin, route: 'INH', doseUnit: 'puff', doseValue: 2 };
    expect(buildLabel(inhaler, 'EN')).toContain('Inhale 2 puffs');
  });

  it('says what a PRN dose is for', () => {
    const prn = {
      ...amoxicillin,
      displayName: 'Paracetamol',
      isPrn: true,
      prnIndication: 'demam',
      frequencyCode: 'PRN' as const,
      instructions: null,
    };
    expect(buildLabel(prn, 'MS')).toContain('bila perlu untuk demam');
    expect(buildLabel({ ...prn, prnIndication: 'fever' }, 'EN')).toContain('when required for fever');
  });

  it('says "until finished" rather than inventing a duration', () => {
    const label = buildLabel(
      { ...amoxicillin, durationDays: null, untilFinished: true, instructions: null },
      'MS',
    );
    expect(label).toContain('Sehingga habis');
    expect(label).not.toContain('Selama');
  });

  it('omits the duration for a single dose', () => {
    const label = buildLabel(
      { ...amoxicillin, frequencyCode: 'STAT', durationDays: 1, instructions: null },
      'EN',
    );
    expect(label).toContain('once only, now');
    expect(label).not.toContain('For 1 day');
  });

  it('spells out a custom frequency', () => {
    const label = buildLabel(
      { ...amoxicillin, frequencyCode: 'CUSTOM', frequencyPerDay: 5, instructions: null },
      'MS',
    );
    expect(label).toContain('5 kali sehari');
  });

  it('copes with a product that has no strength recorded', () => {
    const label = buildLabel({ ...amoxicillin, strength: null, instructions: null }, 'EN');
    expect(label.startsWith('Amoxicillin. Take 1 tablet')).toBe(true);
  });
});
