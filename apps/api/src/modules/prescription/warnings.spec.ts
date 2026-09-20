import { describe, expect, it } from 'vitest';
import {
  matchAllergies,
  maxDoseWarning,
  needsOverride,
  needsSignConfirmation,
  type AllergyRecord,
  type ItemSubstance,
} from './warnings.js';

const ampicillin: ItemSubstance = {
  productId: 'p-ampicillin',
  genericName: 'Ampicillin',
  drugClass: 'PENICILLIN',
  displayName: 'Ampicillin 250 mg cap',
};

function allergy(over: Partial<AllergyRecord>): AllergyRecord {
  return {
    id: 'a1',
    productId: null,
    substance: 'Penicillin',
    drugClass: null,
    reaction: null,
    severity: 'MODERATE',
    status: 'VERIFIED',
    ...over,
  };
}

describe('RX-F-12 — allergy matching', () => {
  it('RX-T-01: matches the same linked product exactly', () => {
    const warnings = matchAllergies(ampicillin, [
      allergy({ productId: 'p-ampicillin', substance: 'Ampicillin', severity: 'SEVERE' }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'ALLERGY', level: 'EXACT', severity: 'SEVERE' });
  });

  it('matches the same generic name even when nothing was linked', () => {
    const warnings = matchAllergies(ampicillin, [allergy({ substance: 'ampicillin' })]);
    expect(warnings[0]).toMatchObject({ level: 'EXACT' });
  });

  it('RX-T-02: matches the drug class', () => {
    const warnings = matchAllergies(ampicillin, [
      allergy({ substance: 'Penicillin', drugClass: 'PENICILLIN' }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'CLASS' });
    expect(warnings[0]?.type === 'ALLERGY' && warnings[0].message).toContain('same class');
  });

  it('RX-T-03: never stays silent about a free-text allergy', () => {
    const warnings = matchAllergies(ampicillin, [allergy({ substance: 'some antibiotic' })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'UNLINKED' });
    expect(warnings[0]?.type === 'ALLERGY' && warnings[0].message).toContain('by hand');
  });

  it('does not warn on a different linked class', () => {
    const warnings = matchAllergies(ampicillin, [
      allergy({ productId: 'p-aspirin', substance: 'Aspirin', drugClass: 'NSAID' }),
    ]);
    expect(warnings).toEqual([]);
  });

  it('raises one warning per allergy, at the strongest level', () => {
    const warnings = matchAllergies(ampicillin, [
      allergy({ id: 'a1', substance: 'Ampicillin', drugClass: 'PENICILLIN' }),
      allergy({ id: 'a2', substance: 'Penicillin', drugClass: 'PENICILLIN' }),
    ]);
    expect(warnings.map((w) => w.type === 'ALLERGY' && w.level)).toEqual(['EXACT', 'CLASS']);
  });

  it('ignores whitespace and case', () => {
    const warnings = matchAllergies(ampicillin, [allergy({ substance: '  AMPICILLIN  ' })]);
    expect(warnings[0]).toMatchObject({ level: 'EXACT' });
  });

  it('matches an item with no class against a class allergy only by name', () => {
    const external: ItemSubstance = {
      productId: null,
      genericName: 'Cetirizine',
      drugClass: null,
      displayName: 'Cetirizine 10 mg',
    };
    expect(matchAllergies(external, [allergy({ drugClass: 'PENICILLIN' })])).toEqual([]);
  });
});

describe('RX-R-04 — when a warning stops a signature', () => {
  const exact = (severity: AllergyRecord['severity']) =>
    matchAllergies(ampicillin, [allergy({ substance: 'Ampicillin', severity })]);

  it('blocks on a severe exact match', () => {
    expect(needsSignConfirmation(exact('SEVERE'))).toBe(true);
    expect(needsSignConfirmation(exact('LIFE_THREATENING'))).toBe(true);
  });

  it('does not block on a milder one', () => {
    expect(needsSignConfirmation(exact('MILD'))).toBe(false);
    expect(needsSignConfirmation(exact('MODERATE'))).toBe(false);
    expect(needsSignConfirmation(exact(null))).toBe(false);
  });

  it('does not block on a severe class match', () => {
    const warnings = matchAllergies(ampicillin, [
      allergy({ substance: 'Penicillin', drugClass: 'PENICILLIN', severity: 'SEVERE' }),
    ]);
    expect(needsSignConfirmation(warnings)).toBe(false);
  });

  it('asks for a reason on any real match, but not on an unlinked one', () => {
    expect(needsOverride(exact('MILD'))).toBe(true);
    expect(needsOverride(matchAllergies(ampicillin, [allergy({ substance: 'something' })]))).toBe(false);
  });
});

describe('RX-F-16 — max daily dose', () => {
  it('warns above the maximum and stays quiet at it', () => {
    expect(maxDoseWarning(5000, 4000, 'mg')).toMatchObject({ type: 'MAX_DOSE' });
    expect(maxDoseWarning(4000, 4000, 'mg')).toBeNull();
    expect(maxDoseWarning(3000, 4000, 'mg')).toBeNull();
  });
});
