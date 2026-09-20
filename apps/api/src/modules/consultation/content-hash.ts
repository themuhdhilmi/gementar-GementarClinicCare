import { createHash } from 'node:crypto';

/**
 * CON-R-02: a fingerprint of what was signed.
 *
 * The immutability trigger stops a change coming through PostgreSQL's
 * ordinary path. This catches the cases it cannot: a superuser, a restore
 * from a doctored backup, a bug in a future migration, disk corruption. The
 * nightly job recomputes this over every signed record and reports anything
 * that no longer matches.
 *
 * **The canonical form is the whole point.** Two records with the same
 * clinical content must hash identically whatever order their fields
 * happened to be written in, and any difference in that content must change
 * the hash. So the input is built here explicitly rather than by
 * stringifying a row: a column added later is not silently included, and a
 * column that is not clinical content, like `last_autosave_at`, cannot make
 * a record look altered when it is not.
 */
export type SignableContent = {
  chiefComplaint: string | null;
  hpi: string | null;
  history: string | null;
  examination: string | null;
  planText: string | null;
  followUpDue: string | null;
  followUpNote: string | null;
  diagnoses: Array<{
    rank: string;
    description: string;
    icd10Code: string | null;
    certainty: string;
  }>;
};

/** Normalised so trivial differences do not read as tampering. */
function text(value: string | null | undefined): string {
  return (value ?? '').replaceAll('\r\n', '\n').trim();
}

export function canonicalise(content: SignableContent): string {
  // Diagnoses are sorted, because the set is what was concluded and the
  // order rows came back in is not part of the clinical record.
  const diagnoses = [...content.diagnoses]
    .map((d) => ({
      rank: d.rank,
      description: text(d.description),
      icd10Code: d.icd10Code ?? null,
      certainty: d.certainty,
    }))
    .sort((a, b) =>
      `${a.rank}|${a.description}|${a.icd10Code}`.localeCompare(
        `${b.rank}|${b.description}|${b.icd10Code}`,
      ),
    );

  // Field order is fixed here, not taken from the object, so the hash does
  // not depend on how the object was constructed.
  return JSON.stringify([
    text(content.chiefComplaint),
    text(content.hpi),
    text(content.history),
    text(content.examination),
    text(content.planText),
    content.followUpDue ?? null,
    text(content.followUpNote),
    diagnoses,
  ]);
}

export function hashContent(content: SignableContent): string {
  return createHash('sha256').update(canonicalise(content), 'utf8').digest('hex');
}
