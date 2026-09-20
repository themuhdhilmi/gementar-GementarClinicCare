import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/prisma/db.service.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { IdType, type Gender, type PatientStatus } from '../../generated/prisma/enums.js';
import { describeAge, normalisePhone } from './patient.validation.js';
import { maskIdNumber } from './identity.js';

export type SearchHit = {
  id: string;
  mrn: string;
  name: string;
  idType: IdType;
  idNumberMasked: string | null;
  gender: Gender;
  age: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  lastVisitAt: string | null;
  status: PatientStatus;
  /** What the header badge shows without a second query (PAT-N-03). */
  allergyState: 'NOT_RECORDED' | 'NKDA' | 'SOME' | 'SEVERE';
  allergyCount: number;
  /** Why this row is here, so the screen can group and explain the results. */
  matchedOn: 'mrn' | 'id' | 'phone' | 'name';
};

type Row = {
  id: string;
  mrn: string;
  name: string;
  id_type: IdType;
  id_number: string | null;
  gender: Gender;
  date_of_birth: Date | null;
  phone: string | null;
  last_visit_at: Date | null;
  status: PatientStatus;
  nkda_recorded: boolean | null;
  allergy_count: number | string;
  severe_count: number | string;
  rank: number;
};

const LIMIT = 20;

/**
 * The search box on the reception screen, and the reason this module has a
 * service of its own.
 *
 * A receptionist runs this several hundred times a day with a patient stood
 * in front of them, so it is the one query in V0 written as SQL rather than
 * through the ORM. Three reasons, all of which the ORM would cost us:
 *
 *   1. **One round trip.** Name, identity, phone and the allergy badge come
 *      back together (PAT-N-03). A separate allergy query per result would
 *      be twenty round trips for one keystroke.
 *   2. **Ranking in the database.** An exact identity match must come first
 *      even when a name match scores higher on similarity, and sorting
 *      twenty rows in JavaScript after fetching hundreds is the wrong shape.
 *   3. **The trigram index.** `name_normalised LIKE '%ali%'` uses the GIN
 *      index; the ORM's `contains` generates the same thing, but the ranking
 *      expression has to sit beside it to be one statement.
 *
 * Row-level security still applies, because it is enforced by PostgreSQL and
 * not by the ORM. The tenant is also named explicitly, so this is filtered
 * twice and would return nothing rather than everything if a policy were
 * ever dropped.
 */
@Injectable()
export class PatientSearchService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * What the typed text could be.
   *
   * A receptionist does not tell the system which field they are typing, so
   * the query has to guess from the shape and try the plausible readings at
   * once. Digits could be the last four of an identity card, a phone number
   * or a patient number, and all three are checked.
   */
  private interpret(raw: string) {
    const query = raw.trim();
    const digits = query.replaceAll(/[^\d]/g, '');
    const alnum = query.replaceAll(/[^A-Za-z0-9]/g, '').toUpperCase();

    // Whether this could be a number at all. A card or telephone number is
    // digits and separators; anything with a word in it is a name, and its
    // digits are part of the name rather than a fragment of a document.
    // Without this, "Muthu Devi 50000" matches whoever's card ends 0000.
    const looksNumeric = /^[\d\s+()./-]+$/.test(query);
    // A passport is letters and digits with no spaces, so it is a document
    // only when the whole query is one token.
    const looksLikeDocument = /^[A-Za-z0-9][A-Za-z0-9\s-]*$/.test(query) && !query.includes(' ');

    let phone: string | null = null;
    if (looksNumeric && digits.length >= 7) {
      try {
        phone = normalisePhone(query);
      } catch {
        // Not a telephone number. The other readings still stand.
        phone = null;
      }
    }

    // The longest word is the one the trigram index is asked about, because
    // a three-letter word matches half the clinic and a long one narrows it.
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2)
      .sort((a, b) => b.length - a.length);

    return {
      query,
      // As typed, for a patient number read straight off a label.
      mrnTyped: query.length >= 2 && !query.includes(' ') ? query.toUpperCase() : null,
      digitsOnly: /^\d{1,10}$/.test(query) ? query : null,
      idFull: looksLikeDocument && alnum.length >= 6 ? alnum : null,
      idLast4: looksNumeric && digits.length >= 4 ? digits.slice(-4) : null,
      phone,
      name: query.length >= 2 ? query : null,
      nameAnchor: words[0] ?? null,
    };
  }

  async search(raw: string): Promise<SearchHit[]> {
    const q = this.interpret(raw);
    if (!q.query) return [];

    const tenantId = requireTenantId();
    const tx = this.db.tx();

    // A patient number as it is printed. Reception usually types the whole
    // thing off a label, but "123" should still find "P-000123", so the
    // clinic's own prefix and padding are used to reconstruct it.
    let mrnGuess: string | null = null;
    if (q.digitsOnly) {
      const { mrnPrefix, mrnDigits } = await this.settings.group('', 'patient');
      const padded = q.digitsOnly.padStart(mrnDigits, '0');
      mrnGuess = mrnPrefix ? `${mrnPrefix}-${padded}` : padded;
    }

    // One indexed lookup per way of reading what was typed, unioned.
    //
    // The obvious shape — rank every row in a subquery, then keep the ones
    // that scored — reads the whole table on every keystroke. Measured at a
    // hundred thousand patients it was a sequential scan taking 40 ms in the
    // database and 220 ms end to end, against 0.05 ms for the same lookup
    // through an index. Each branch below can use one.
    //
    // A null parameter needs no guard: `column = NULL` is never true, so a
    // branch whose reading does not apply returns nothing and still plans as
    // an index scan.
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `
      WITH hit AS (
        (SELECT id, 100::float AS rank FROM patient
          WHERE tenant_id = $1::uuid AND status IN ('ACTIVE', 'DECEASED')
            AND (mrn = $2::text OR mrn = $3::text)
          LIMIT 20)

        UNION ALL
        (SELECT id, 95::float FROM patient
          WHERE tenant_id = $1::uuid AND status IN ('ACTIVE', 'DECEASED')
            AND id_number = $4::text
          LIMIT 20)

        UNION ALL
        (SELECT id, 80::float FROM patient
          WHERE tenant_id = $1::uuid AND status IN ('ACTIVE', 'DECEASED')
            AND phone = $5::text
          LIMIT 20)

        UNION ALL
        (SELECT id, 60::float FROM patient
          WHERE tenant_id = $1::uuid AND status IN ('ACTIVE', 'DECEASED')
            AND id_number_last4 = $6::text
          LIMIT 20)

        UNION ALL
        -- The trigram index answers the LIKE. Every other word typed is
        -- then checked against the row, so word order does not matter:
        -- "hassan zulkifli" finds "Zulkifli bin Hassan".
        (SELECT id, 40 + (similarity(name_normalised, patient_normalise_name($7::text)) * 10)
           FROM patient
          WHERE tenant_id = $1::uuid AND status IN ('ACTIVE', 'DECEASED')
            AND name_normalised LIKE '%' || $8::text || '%'
            AND (SELECT bool_and(name_normalised LIKE '%' || word || '%')
                   FROM unnest(string_to_array(patient_normalise_name($7::text), ' ')) AS word
                  WHERE word <> '')
          ORDER BY similarity(name_normalised, patient_normalise_name($7::text)) DESC
          LIMIT 40)
      ),
      best AS (
        SELECT id, max(rank) AS rank FROM hit GROUP BY id
      )
      SELECT p.id, p.mrn, p.name, p.id_type, p.id_number, p.gender, p.date_of_birth,
             p.phone, p.last_visit_at, p.status, p.nkda_recorded, best.rank,
             COALESCE(a.allergy_count, 0) AS allergy_count,
             COALESCE(a.severe_count, 0)  AS severe_count
        FROM best
        JOIN patient p ON p.id = best.id AND p.tenant_id = $1::uuid
        -- Joined after the candidates are known, so the allergy badge costs
        -- one pass over at most twenty rows rather than over the table.
        LEFT JOIN LATERAL (
          SELECT count(*) AS allergy_count,
                 count(*) FILTER (
                   WHERE severity IN ('SEVERE', 'LIFE_THREATENING')
                 ) AS severe_count
            FROM patient_allergy pa
           WHERE pa.patient_id = p.id
             AND pa.tenant_id = p.tenant_id
             AND pa.status <> 'REFUTED'
        ) a ON true
       ORDER BY best.rank DESC, p.last_visit_at DESC NULLS LAST, p.name ASC
       LIMIT ${LIMIT}
      `,
      tenantId,
      q.mrnTyped,
      mrnGuess,
      q.idFull,
      q.phone,
      q.idLast4,
      q.name,
      q.nameAnchor,
    );

    return rows.map((row) => this.toHit(row));
  }

  /**
   * PAT-F-19: what the box shows before anything is typed.
   *
   * Its own small table rather than a query over the audit trail. A plain
   * demographic read is not an audited event and should not become one:
   * recording every name a receptionist glances at would bury the entries
   * that matter, and the retention problem is already real (IAM-OPEN-17).
   */
  async remember(userId: string, branchId: string, patientId: string): Promise<void> {
    const tenantId = requireTenantId();
    await this.db.tx().$executeRawUnsafe(
      `INSERT INTO patient_recent (tenant_id, user_id, branch_id, patient_id, opened_at)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now())
       ON CONFLICT (tenant_id, user_id, branch_id, patient_id)
       DO UPDATE SET opened_at = now()`,
      tenantId,
      userId,
      branchId,
      patientId,
    );
  }

  async recent(userId: string, branchId: string, limit = 20): Promise<SearchHit[]> {
    const tenantId = requireTenantId();
    const tx = this.db.tx();

    const rows = await tx.$queryRawUnsafe<Row[]>(
      `
      SELECT p.id, p.mrn, p.name, p.id_type, p.id_number, p.gender, p.date_of_birth,
             p.phone, p.last_visit_at, p.status, p.nkda_recorded,
             0::float AS rank,
             COALESCE(a.allergy_count, 0) AS allergy_count,
             COALESCE(a.severe_count, 0)  AS severe_count
        FROM patient_recent r
        JOIN patient p ON p.id = r.patient_id AND p.tenant_id = r.tenant_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS allergy_count,
                 count(*) FILTER (
                   WHERE severity IN ('SEVERE', 'LIFE_THREATENING')
                 ) AS severe_count
            FROM patient_allergy pa
           WHERE pa.patient_id = p.id
             AND pa.tenant_id = p.tenant_id
             AND pa.status <> 'REFUTED'
        ) a ON true
       WHERE r.tenant_id = $1::uuid AND r.user_id = $2::uuid AND r.branch_id = $3::uuid
         AND p.status IN ('ACTIVE', 'DECEASED')
       ORDER BY r.opened_at DESC
       LIMIT ${Math.min(Math.max(limit, 1), 50)}
      `,
      tenantId,
      userId,
      branchId,
    );

    return rows.map((row) => ({ ...this.toHit(row), matchedOn: 'name' as const }));
  }

  /**
   * Keeps the list short. Twenty is what the screen shows; a few more are
   * kept so that the list survives a patient being merged away.
   */
  async pruneRecent(userId: string, branchId: string, keep = 30): Promise<void> {
    await this.db.tx().$executeRawUnsafe(
      `DELETE FROM patient_recent
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND branch_id = $3::uuid
          AND opened_at < (
            SELECT min(opened_at) FROM (
              SELECT opened_at FROM patient_recent
               WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND branch_id = $3::uuid
               ORDER BY opened_at DESC LIMIT ${keep}
            ) AS kept
          )`,
      requireTenantId(),
      userId,
      branchId,
    );
  }

  private toHit(row: Row): SearchHit {
    const allergyCount = Number(row.allergy_count);
    const severeCount = Number(row.severe_count);

    // PAT-F-12: three states, not two. "Nobody asked" is the one that matters
    // clinically and it is the one a boolean would lose.
    const allergyState =
      severeCount > 0
        ? 'SEVERE'
        : allergyCount > 0
          ? 'SOME'
          : row.nkda_recorded === true
            ? 'NKDA'
            : 'NOT_RECORDED';

    const rank = Number(row.rank);
    const matchedOn =
      rank >= 100 ? 'mrn' : rank >= 95 ? 'id' : rank >= 70 ? 'phone' : rank >= 60 ? 'id' : 'name';

    return {
      id: row.id,
      mrn: row.mrn,
      name: row.name,
      idType: row.id_type,
      idNumberMasked: maskIdNumber(row.id_type, row.id_number),
      gender: row.gender,
      age: describeAge(row.date_of_birth),
      dateOfBirth: row.date_of_birth ? row.date_of_birth.toISOString().slice(0, 10) : null,
      phone: row.phone,
      lastVisitAt: row.last_visit_at ? row.last_visit_at.toISOString() : null,
      status: row.status,
      allergyState,
      allergyCount,
      matchedOn,
    };
  }
}
