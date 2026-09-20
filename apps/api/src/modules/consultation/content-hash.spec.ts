import { describe, expect, it } from 'vitest';
import { canonicalise, hashContent, type SignableContent } from './content-hash.js';

const base: SignableContent = {
  chiefComplaint: 'Cough for three days',
  hpi: 'Dry, worse at night. No fever.',
  history: null,
  examination: 'Chest clear.',
  planText: 'Rest, fluids, review if worse.',
  followUpDue: null,
  followUpNote: null,
  diagnoses: [
    { rank: 'PRIMARY', description: 'Upper respiratory tract infection', icd10Code: 'J06.9', certainty: 'CONFIRMED' },
  ],
};

describe('The signed content hash (CON-R-02)', () => {
  it('is stable for the same content', () => {
    expect(hashContent(base)).toBe(hashContent({ ...base }));
    expect(hashContent(base)).toHaveLength(64);
  });

  it('changes when any clinical word changes', () => {
    const before = hashContent(base);
    expect(hashContent({ ...base, hpi: 'Dry, worse at night. Fever.' })).not.toBe(before);
    expect(hashContent({ ...base, examination: 'Chest clear. Throat red.' })).not.toBe(before);
    expect(hashContent({ ...base, chiefComplaint: 'Cough for four days' })).not.toBe(before);
  });

  it('changes when a diagnosis changes, is added or is removed', () => {
    const before = hashContent(base);
    expect(
      hashContent({
        ...base,
        diagnoses: [{ ...base.diagnoses[0]!, certainty: 'PROVISIONAL' }],
      }),
    ).not.toBe(before);
    expect(
      hashContent({
        ...base,
        diagnoses: [...base.diagnoses, { rank: 'SECONDARY', description: 'Allergic rhinitis', icd10Code: null, certainty: 'PROVISIONAL' }],
      }),
    ).not.toBe(before);
    expect(hashContent({ ...base, diagnoses: [] })).not.toBe(before);
  });

  it('does not depend on the order diagnoses came back in', () => {
    // The set is what was concluded; the row order is an accident of the
    // query, and a hash that depended on it would report false tampering.
    const second = { rank: 'SECONDARY', description: 'Allergic rhinitis', icd10Code: null, certainty: 'PROVISIONAL' };
    const oneWay = hashContent({ ...base, diagnoses: [base.diagnoses[0]!, second] });
    const other = hashContent({ ...base, diagnoses: [second, base.diagnoses[0]!] });
    expect(oneWay).toBe(other);
  });

  it('ignores line endings and surrounding whitespace', () => {
    // A record copied between machines must not read as altered.
    expect(hashContent({ ...base, hpi: '  Dry, worse at night. No fever.  ' })).toBe(
      hashContent(base),
    );
    expect(hashContent({ ...base, examination: 'Chest clear.\r\n' })).toBe(
      hashContent({ ...base, examination: 'Chest clear.\n' }),
    );
  });

  it('treats an absent field and an empty one as the same', () => {
    expect(hashContent({ ...base, history: '' })).toBe(hashContent({ ...base, history: null }));
  });

  it('covers every clinical field, so none can be changed unnoticed', () => {
    // If a field is added to the record and not to the hash, a change to it
    // would be invisible to the integrity job. This is the reminder.
    const canonical = canonicalise(base);
    for (const field of ['chiefComplaint', 'hpi', 'examination', 'planText'] as const) {
      const changed = { ...base, [field]: 'something entirely different' };
      expect(canonicalise(changed), field).not.toBe(canonical);
    }
    expect(canonicalise({ ...base, followUpDue: '2026-10-01' })).not.toBe(canonical);
    expect(canonicalise({ ...base, followUpNote: 'BP review' })).not.toBe(canonical);
  });
});
