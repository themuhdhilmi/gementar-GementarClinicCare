import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { DocumentIntegrityJob } from '../src/modules/documents/integrity.job.js';
import { withOverlay } from '../src/modules/documents/templates.js';

const API = '/api/v1';

async function signIn(harness: Harness, email: string): Promise<string> {
  const response = await request(harness.server)
    .post(`${API}/auth/login`)
    .send({ email, password: DEFAULT_PASSWORD })
    .expect(200);
  return (response.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('cc_session='),
  )!;
}

async function signInAdmin(harness: Harness, email: string): Promise<string> {
  const cookie = await signIn(harness, email);
  const enrol = await request(harness.server)
    .post(`${API}/auth/me/mfa/enrol`)
    .set('Cookie', cookie)
    .expect(200);
  await request(harness.server)
    .post(`${API}/auth/me/mfa/confirm`)
    .set('Cookie', cookie)
    .send({ code: totpFor(enrol.body.secret) })
    .expect(200);
  return cookie;
}

function today(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function isoDay(offsetDays: number): string {
  return new Date(today().getTime() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A one-by-one-pixel PNG, which is enough to be a real image. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('DOC — documents', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let nurse: string;
  let branch: string;

  let seq = 0;

  /** A patient seen, with a consultation left unsigned. */
  async function visit(): Promise<{
    patientId: string;
    encounterId: string;
    consultationId: string;
  }> {
    seq += 1;
    const day = String((seq % 28) + 1).padStart(2, '0');
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Doc Patient ${seq}`,
        idType: 'MYKAD',
        idNumber: `8501${day}-10-${String(4000 + seq).slice(0, 4)}`,
        gender: 'FEMALE',
        dateOfBirth: `1985-01-${day}`,
        phone: `019-${String(30_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    const patientId = patient.body.patient.id as string;
    await request(harness.server)
      .put(`${API}/patients/${patientId}/nkda`)
      .set('Cookie', doctor)
      .send({ nkda: true })
      .expect(200);

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', reception)
      .send({ patientId })
      .expect(201);
    const encounterId = encounter.body.encounter.id as string;

    for (const to of [
      'TRIAGE_IN_PROGRESS',
      'DOCTOR_WAITING',
      'IN_CONSULTATION',
    ]) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to })
        .expect(200);
    }

    const created = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/consultations`)
      .set('Cookie', doctor)
      .send({})
      .expect(201);
    const consultationId = created.body.id as string;
    await request(harness.server)
      .patch(`${API}/consultations/${consultationId}`)
      .set('Cookie', doctor)
      .send({
        chiefComplaint: 'Demam dan batuk',
        examination: 'Throat mildly inflamed',
      })
      .expect(200);
    await request(harness.server)
      .put(`${API}/consultations/${consultationId}/diagnoses`)
      .set('Cookie', doctor)
      .send({
        diagnoses: [
          {
            rank: 'PRIMARY',
            description: 'Acute pharyngitis',
            certainty: 'CONFIRMED',
          },
        ],
      })
      .expect(200);

    return { patientId, encounterId, consultationId };
  }

  async function signedVisit() {
    const made = await visit();
    await request(harness.server)
      .post(`${API}/consultations/${made.consultationId}/sign`)
      .set('Cookie', doctor)
      .send({})
      .expect(200);
    return made;
  }

  async function issueMc(
    consultationId: string,
    body: Record<string, unknown> = {},
  ) {
    const response = await request(harness.server)
      .post(`${API}/consultations/${consultationId}/documents/mc`)
      .set('Cookie', doctor)
      .send({ days: 2, ...body })
      .expect(201);
    return response.body as {
      id: string;
      documentNo: string;
      status: string;
      type: string;
      contentHash: string;
      printCount: number;
    };
  }

  function fileOf(id: string, cookie = doctor, query = '') {
    return request(harness.server)
      .get(`${API}/documents/${id}/file${query}`)
      .set('Cookie', cookie);
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('documents');
    branch = fx.branchAId;

    const nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Siti',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    [doctor, reception, nurse] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
      signIn(harness, nurseUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------- issuing

  describe('Issuing from the record (DOC-R-01)', () => {
    it('DOC-T-01: refuses a certificate from an unsigned consultation', async () => {
      const { consultationId } = await visit();
      const response = await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/mc`)
        .set('Cookie', doctor)
        .send({ days: 2 })
        .expect(409);
      expect(response.body.code).toBe('consultation_not_signed');

      // And nothing was written on the way to refusing.
      const documents = await request(harness.server)
        .get(`${API}/consultations/${consultationId}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(documents.body.consultation.status).toBe('DRAFT');
    });

    it('DOC-F-06: refuses a referral from an unsigned consultation too', async () => {
      const { consultationId } = await visit();
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/referral`)
        .set('Cookie', doctor)
        .send({ to: 'Hospital Sungai Buloh', reason: 'Needs an ENT opinion' })
        .expect(409);
    });

    it('DOC-R-05: another doctor cannot issue on the signing doctor’s name', async () => {
      const other = await harness.addUser(fx, {
        name: 'Dr Faridah',
        roles: [{ branchId: fx.branchAId, role: Role.DOCTOR }],
      });
      const otherCookie = await signIn(harness, other.email);
      const { consultationId } = await signedVisit();

      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/mc`)
        .set('Cookie', otherCookie)
        .send({ days: 1 })
        .expect(403);
    });

    it('a role without document.issue is refused (DOC §16)', async () => {
      const { consultationId } = await signedVisit();
      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/mc`)
        .set('Cookie', nurse)
        .send({ days: 1 })
        .expect(403);
    });
  });

  describe('DOC-T-02: a certificate, end to end', () => {
    it('numbers it, stores it, dates it, and bills it', async () => {
      // A clinic that charges for a certificate.
      await request(harness.server)
        .post(`${API}/billable-items`)
        .set('Cookie', admin)
        .send({
          code: 'DOC_MC',
          name: 'Sijil Cuti Sakit',
          defaultPrice: 5,
          taxCode: 'NONE',
        })
        .expect(201);

      const { consultationId, encounterId, patientId } = await signedVisit();
      const mc = await issueMc(consultationId, {
        days: 2,
        fromDate: isoDay(0),
      });

      expect(mc.status).toBe('ISSUED');
      expect(mc.type).toBe('MC');
      // BRANCH-MC-YYYY-000001
      expect(mc.documentNo).toMatch(/^[A-Z0-9]+-MC-\d{4}-\d{6}$/);
      expect(mc.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // to = from + (days - 1): a two-day certificate covers today and
      // tomorrow, not today and the two days after it.
      const detail = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.mcDetail.findFirstOrThrow({ where: { documentId: mc.id } }),
      );
      expect(detail.days).toBe(2);
      expect(detail.fromDate.toISOString().slice(0, 10)).toBe(isoDay(0));
      expect(detail.toDate.toISOString().slice(0, 10)).toBe(isoDay(1));

      // The stored file is real, and says what it should.
      const served = await fileOf(mc.id).expect(200);
      expect(served.headers['content-type']).toMatch(/text\/html/);
      expect(served.headers['cache-control']).toBe('no-store');
      expect(served.text).toContain('Doc Patient');
      // The number is stamped on the way out, not baked in at render
      // time — but it is on the paper the patient carries away.
      expect(served.text).toContain(mc.documentNo);
      expect(served.text).toContain(fx.doctor.name);

      // DOC-F-11: the fee reached the bill.
      const invoice = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/invoice`)
        .set('Cookie', admin)
        .send({})
        .expect(201);
      const line = invoice.body.lines.find(
        (l: { lineType: string; description: string }) =>
          l.lineType === 'DOCUMENT',
      );
      expect(line).toBeDefined();
      expect(line.description).toBe('Sijil Cuti Sakit');
      expect(line.lineTotalSen).toBe(500);

      // And it is on the patient's record and the visit's.
      const onPatient = await request(harness.server)
        .get(`${API}/patients/${patientId}/issued-documents`)
        .set('Cookie', doctor)
        .expect(200);
      expect(onPatient.body.items.map((d: { id: string }) => d.id)).toContain(
        mc.id,
      );

      const onEncounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/documents`)
        .set('Cookie', doctor)
        .expect(200);
      expect(onEncounter.body.items.map((d: { id: string }) => d.id)).toContain(
        mc.id,
      );
    });

    it('DOC §14: backdating is allowed, bounded, and never silent', async () => {
      const { consultationId } = await signedVisit();

      const silent = await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/mc`)
        .set('Cookie', doctor)
        .send({ days: 1, fromDate: isoDay(-2) })
        .expect(400);
      expect(silent.body.code).toBe('backdate_reason_required');

      await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/mc`)
        .set('Cookie', doctor)
        .send({
          days: 1,
          fromDate: isoDay(-30),
          backdateReason: 'Seen at home on the day',
        })
        .expect(400);

      const ok = await issueMc(consultationId, {
        days: 1,
        fromDate: isoDay(-2),
        backdateReason: 'Patient was seen on the day and the system was down',
      });
      expect(ok.documentNo).toBeTruthy();

      const entry = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({
          where: {
            entityType: 'document',
            entityId: ok.id,
            action: 'document.issued',
          },
        }),
      );
      expect((entry.after as { backdatedBy: number }).backdatedBy).toBe(2);
      expect(
        (entry.after as { backdateReason: string }).backdateReason,
      ).toContain('system was down');
    });

    it('DOC-R-08: a certificate carries the full identity number, a referral does not', async () => {
      const { consultationId } = await signedVisit();
      const mc = await issueMc(consultationId, { days: 1 });
      const referral = await request(harness.server)
        .post(`${API}/consultations/${consultationId}/documents/referral`)
        .set('Cookie', doctor)
        .send({
          to: 'Hospital Kuala Lumpur',
          reason: 'Persistent sore throat, for ENT review',
        })
        .expect(201);

      const mcHtml = (await fileOf(mc.id).expect(200)).text;
      const referralHtml = (await fileOf(referral.body.id).expect(200)).text;

      const patient = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.consultation
          .findFirstOrThrow({ where: { id: consultationId } })
          .then((c) =>
            tx.patient.findFirstOrThrow({ where: { id: c.patientId } }),
          ),
      );
      expect(mcHtml).toContain(patient.idNumber!);
      expect(referralHtml).not.toContain(patient.idNumber!);
      expect(referralHtml).toContain(patient.idNumber!.slice(-4));
    });

    it('the diagnosis is left off unless it is asked for', async () => {
      const { consultationId } = await signedVisit();
      const quiet = await issueMc(consultationId, { days: 1 });
      const stated = await issueMc(consultationId, {
        days: 1,
        includeDiagnosis: true,
      });

      expect((await fileOf(quiet.id).expect(200)).text).not.toContain(
        'Acute pharyngitis',
      );
      expect((await fileOf(stated.id).expect(200)).text).toContain(
        'Acute pharyngitis',
      );
    });
  });

  // ------------------------------------------------ reprints and numbers

  describe('DOC-T-03: a reprint is the same document', () => {
    it('serves the stored bytes, and adds the COPY overlay at print time', async () => {
      const { consultationId } = await signedVisit();
      const mc = await issueMc(consultationId, { days: 3 });

      const first = await fileOf(mc.id, doctor, '?copy=false').expect(200);
      await request(harness.server)
        .post(`${API}/documents/${mc.id}/print`)
        .set('Cookie', doctor)
        .expect(200);

      // The stored file is untouched by printing...
      const again = await fileOf(mc.id, doctor, '?copy=false').expect(200);
      expect(again.text).toBe(first.text);

      // ...and the overlay is added on the way out, not baked in.
      const copy = await fileOf(mc.id).expect(200);
      expect(copy.text).not.toBe(first.text);
      expect(copy.text).toContain('COPY');
      // Exactly the stored bytes, plus the overlay — nothing else moved.
      expect(copy.text).toBe(withOverlay(first.text, 'COPY'));

      // The hash still describes what is on disk.
      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.document.findFirstOrThrow({ where: { id: mc.id } }),
      );
      expect(row.printCount).toBe(1);
      const service = harness.app.get(DocumentIntegrityJob);
      expect(service).toBeDefined();
    });

    it('DOC-F-18: the first print is not a reprint; the second is audited', async () => {
      const { consultationId } = await signedVisit();
      const mc = await issueMc(consultationId, { days: 1 });

      await request(harness.server)
        .post(`${API}/documents/${mc.id}/print`)
        .set('Cookie', doctor)
        .expect(200);
      const reprints = () =>
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.auditLog.count({
            where: {
              entityType: 'document',
              entityId: mc.id,
              action: 'document.reprinted',
            },
          }),
        );
      expect(await reprints()).toBe(0);

      const second = await request(harness.server)
        .post(`${API}/documents/${mc.id}/print`)
        .set('Cookie', doctor)
        .expect(200);
      expect(second.body.printCount).toBe(2);
      expect(await reprints()).toBe(1);
    });
  });

  it('DOC-T-04: twenty at once get twenty consecutive numbers', async () => {
    const { consultationId } = await signedVisit();

    const issued = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(harness.server)
          .post(`${API}/consultations/${consultationId}/documents/mc`)
          .set('Cookie', doctor)
          .send({ days: 1 }),
      ),
    );
    expect(issued.map((r) => r.status)).toEqual(Array(20).fill(201));

    const numbers = issued
      .map((r) => r.body.documentNo as string)
      .map((no) => Number(no.slice(no.lastIndexOf('-') + 1)))
      .sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(20);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]! - numbers[i - 1]!).toBe(1);
    }
  });

  // ------------------------------------------------ cancel and replace

  it('DOC-T-05: a cancelled certificate keeps its number and prints as cancelled', async () => {
    const { consultationId } = await signedVisit();
    const wrong = await issueMc(consultationId, { days: 5 });

    const cancelled = await request(harness.server)
      .post(`${API}/documents/${wrong.id}/cancel`)
      .set('Cookie', doctor)
      .send({
        reason: 'Wrong number of days; the patient needs three, not five',
      })
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    // DOC-R-04: the number is spent, not returned.
    expect(cancelled.body.documentNo).toBe(wrong.documentNo);

    const replacement = await issueMc(consultationId, { days: 3 });
    await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.document.update({
        where: { id: wrong.id },
        data: { replacedById: replacement.id },
      }),
    );

    const back = await request(harness.server)
      .get(`${API}/documents/${wrong.id}`)
      .set('Cookie', doctor)
      .expect(200);
    expect(back.body.replacedById).toBe(replacement.id);

    const served = await fileOf(wrong.id).expect(200);
    expect(served.text).toContain('CANCELLED');
    expect(served.text).not.toContain('>COPY<');

    await request(harness.server)
      .post(`${API}/documents/${wrong.id}/cancel`)
      .set('Cookie', doctor)
      .send({ reason: 'Cancelling it a second time should not work' })
      .expect(409);
  });

  it('a cancellation needs a reason somebody can read later', async () => {
    const { consultationId } = await signedVisit();
    const mc = await issueMc(consultationId, { days: 1 });
    await request(harness.server)
      .post(`${API}/documents/${mc.id}/cancel`)
      .set('Cookie', doctor)
      .send({ reason: 'oops' })
      .expect(400);
  });

  // --------------------------------------------------------- who may read

  it('DOC-T-07: the front desk cannot read a referral; the doctor can', async () => {
    const { consultationId } = await signedVisit();
    const referral = await request(harness.server)
      .post(`${API}/consultations/${consultationId}/documents/referral`)
      .set('Cookie', doctor)
      .send({ to: 'Klinik Pakar Mata', reason: 'Blurred vision for two weeks' })
      .expect(201);

    await request(harness.server)
      .get(`${API}/documents/${referral.body.id}`)
      .set('Cookie', reception)
      .expect(403);
    await fileOf(referral.body.id, reception).expect(403);

    await request(harness.server)
      .get(`${API}/documents/${referral.body.id}`)
      .set('Cookie', doctor)
      .expect(200);

    // And it does not appear in the front desk's list of the patient's
    // documents either — a title is a disclosure too.
    const consultation = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.consultation.findFirstOrThrow({ where: { id: consultationId } }),
    );
    const listed = await request(harness.server)
      .get(`${API}/patients/${consultation.patientId}/issued-documents`)
      .set('Cookie', reception)
      .expect(200);
    expect(listed.body.items.map((d: { id: string }) => d.id)).not.toContain(
      referral.body.id,
    );
  });

  // ---------------------------------------------------------- integrity

  it('DOC-T-08: the nightly run notices a stored document that changed', async () => {
    const { consultationId } = await signedVisit();
    const mc = await issueMc(consultationId, { days: 1 });

    const job = harness.app.get(DocumentIntegrityJob);
    const clean = await job.run();
    expect(clean.checked).toBeGreaterThan(0);

    const row = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.document.findFirstOrThrow({ where: { id: mc.id } }),
    );
    const path = join(process.env['STORAGE_ROOT']!, row.storageKey);
    const original = await readFile(path);
    try {
      // Sixty days off work instead of one, edited on disk, around the
      // database entirely. Nothing in Postgres can see this.
      await writeFile(
        path,
        original
          .toString('utf8')
          .replace('</body>', '<p>60 days / 60 hari</p></body>'),
      );
      const dirty = await job.run();
      expect(dirty.mismatched).toBeGreaterThan(0);
    } finally {
      await writeFile(path, original);
    }

    expect((await job.run()).mismatched).toBe(0);
  });

  // ---------------------------------------------------------- letterhead

  it('TEN-F-10: the branch letterhead and its logo reach the paper', async () => {
    await request(harness.server)
      .patch(`${API}/branches/${branch}/letterhead`)
      .set('Cookie', admin)
      .send({
        headerText: 'Klinik Ujian Sdn Bhd · 202301234567',
        footerText: 'Lesen KKM 12345 · Terima kasih',
      })
      .expect(200);
    await request(harness.server)
      .put(`${API}/branches/${branch}/letterhead/logo`)
      .set('Cookie', admin)
      .attach('logo', TINY_PNG, {
        filename: 'logo.png',
        contentType: 'image/png',
      })
      .expect(200);

    const { consultationId } = await signedVisit();
    const mc = await issueMc(consultationId, { days: 1 });
    const html = (await fileOf(mc.id, doctor, '?copy=false').expect(200)).text;

    expect(html).toContain('Klinik Ujian Sdn Bhd');
    expect(html).toContain('Lesen KKM 12345');
    // Inlined, not linked: a document stored today has to render in five
    // years without reaching back for a branch that may be closed.
    expect(html).toContain(
      `data:image/png;base64,${TINY_PNG.toString('base64')}`,
    );
  });

  // ---------------------------------------------------------- signature

  describe('The doctor’s signature (DOC-F-16)', () => {
    it('falls back to a typed block when there is no image', async () => {
      const { consultationId } = await signedVisit();
      const mc = await issueMc(consultationId, { days: 1 });
      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.document.findFirstOrThrow({ where: { id: mc.id } }),
      );
      expect(row.signatureKind).toBe('TYPED');
    });

    it('refuses anything that is not really an image', async () => {
      const response = await request(harness.server)
        .put(`${API}/me/signature`)
        .set('Cookie', doctor)
        .attach('file', Buffer.from('<svg onload="alert(1)"></svg>'), {
          filename: 'signature.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(response.body.code).toBe('unsupported_image');
    });

    it('uses the uploaded image once it is there, and embeds it in the document', async () => {
      await request(harness.server)
        .put(`${API}/me/signature`)
        .set('Cookie', doctor)
        .attach('file', TINY_PNG, {
          filename: 'signature.png',
          contentType: 'image/png',
        })
        .expect(200);

      const mine = await request(harness.server)
        .get(`${API}/me/signature`)
        .set('Cookie', doctor)
        .expect(200);
      expect(mine.body.present).toBe(true);
      expect(mine.body.mime).toBe('image/png');

      const { consultationId } = await signedVisit();
      const mc = await issueMc(consultationId, { days: 1 });
      const html = (await fileOf(mc.id, doctor, '?copy=false').expect(200))
        .text;
      expect(html).toContain('data:image/png;base64,');

      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.document.findFirstOrThrow({ where: { id: mc.id } }),
      );
      expect(row.signatureKind).toBe('IMAGE');
    });
  });

  // ----------------------------------------------------- immutability

  it('DOC-R-02: an issued document cannot be edited or deleted', async () => {
    const { consultationId } = await signedVisit();
    const mc = await issueMc(consultationId, { days: 1 });

    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE document SET content_hash = repeat('0', 64) WHERE id = $1::uuid`,
          mc.id,
        ),
      ),
    ).rejects.toThrow(/immutable|cannot/i);

    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM document WHERE id = $1::uuid`, mc.id),
      ),
    ).rejects.toThrow(/A document is kept/i);

    await expect(
      harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE mc_detail SET days = 90 WHERE document_id = $1::uuid`,
          mc.id,
        ),
      ),
    ).rejects.toThrow(/immutable|cannot/i);
  });
});
