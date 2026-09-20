import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, type SeededUser, DEFAULT_PASSWORD } from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { ConsultationIntegrityJob } from '../src/modules/consultation/integrity.job.js';
import { ConsultationService } from '../src/modules/consultation/consultation.service.js';

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

describe('CON — the clinical record', () => {
  const harness = new Harness();
  let fx: Fixture;
  let reception: string;
  let doctor: string;
  let otherDoctor: string;
  let nurse: string;
  let admin: string;
  let branch: string;
  let otherDoctorUser: SeededUser;

  let seq = 0;

  /** A patient with the doctor, ready for a consultation to be written. */
  async function withDoctor() {
    seq += 1;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Consult Patient ${seq}`,
        idType: 'NONE',
        gender: 'MALE',
        dateOfBirth: `1979-0${(seq % 9) + 1}-${String((seq % 27) + 1).padStart(2, '0')}`,
        notes: 'Test patient',
        phone: `011-${String(40_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', reception)
      .send({ patientId: patient.body.patient.id })
      .expect(201);
    const encounterId = encounter.body.encounter.id as string;

    for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to })
        .expect(200);
    }
    return { encounterId, patientId: patient.body.patient.id as string };
  }

  /** A draft with the minimum needed to sign. */
  async function readyToSign(cookie = doctor) {
    const { encounterId, patientId } = await withDoctor();
    const created = await request(harness.server)
      .post(`${API}/encounters/${encounterId}/consultations`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);
    const id = created.body.id as string;

    await request(harness.server)
      .patch(`${API}/consultations/${id}`)
      .set('Cookie', cookie)
      .send({ chiefComplaint: 'Cough for three days', hpi: 'Dry, worse at night.' })
      .expect(200);
    await request(harness.server)
      .put(`${API}/consultations/${id}/diagnoses`)
      .set('Cookie', cookie)
      .send({
        diagnoses: [
          { rank: 'PRIMARY', description: 'Upper respiratory tract infection', certainty: 'CONFIRMED' },
        ],
      })
      .expect(200);

    return { id, encounterId, patientId };
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('consultation');
    branch = fx.branchAId;
    otherDoctorUser = await harness.addUser(fx, {
      name: 'Dr Second',
      roles: [{ branchId: fx.branchAId, role: Role.DOCTOR }],
    });
    const nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Mei',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    [reception, doctor, otherDoctor, nurse] = await Promise.all([
      signIn(harness, fx.frontdesk.email),
      signIn(harness, fx.doctor.email),
      signIn(harness, otherDoctorUser.email),
      signIn(harness, nurseUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 120_000);

  afterAll(async () => {
    await harness.stop();
  });

  // --------------------------------------------------------- drafting

  describe('Writing (CON-F-01, CON-F-12, CON-F-13)', () => {
    it('will not start one until the patient is actually with the doctor', async () => {
      seq += 1;
      const patient = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', reception)
        .send({
          name: `Not Called ${seq}`,
          idType: 'NONE',
          gender: 'MALE',
          dateOfBirth: '1991-02-03',
          notes: 'x',
          phone: `011-${String(41_000_000 + seq).slice(0, 8)}`,
        })
        .expect(201);
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId: patient.body.patient.id })
        .expect(201);

      const refused = await request(harness.server)
        .post(`${API}/encounters/${encounter.body.encounter.id}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(400);
      expect(refused.body.code).toBe('not_in_consultation');
    });

    it('CON-T-01: autosaves, and the saved time moves', async () => {
      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      const id = created.body.id;
      expect(created.body.lastAutosaveAt).toBeNull();

      const first = await request(harness.server)
        .patch(`${API}/consultations/${id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Cough' })
        .expect(200);
      expect(first.body.chiefComplaint).toBe('Cough');
      expect(first.body.lastAutosaveAt).not.toBeNull();

      const second = await request(harness.server)
        .patch(`${API}/consultations/${id}`)
        .set('Cookie', doctor)
        .send({ hpi: 'Three days, dry.' })
        .expect(200);
      // Partial: the earlier section is untouched.
      expect(second.body.chiefComplaint).toBe('Cough');
      expect(second.body.hpi).toBe('Three days, dry.');
      expect(new Date(second.body.lastAutosaveAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.body.lastAutosaveAt).getTime(),
      );
    });

    it('refuses a second draft for the same doctor and visit', async () => {
      const { encounterId } = await withDoctor();
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      const again = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(409);
      expect(again.body.code).toBe('draft_exists');
    });

    it('allows a second doctor to write their own, as sequence 2', async () => {
      const { encounterId } = await withDoctor();
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      const second = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', otherDoctor)
        .send({})
        .expect(201);
      expect(second.body.sequence).toBe(2);
    });

    it('two doctors opening the same visit at once get two consultations', async () => {
      const { encounterId } = await withDoctor();
      const [first, second] = await Promise.all([
        request(harness.server)
          .post(`${API}/encounters/${encounterId}/consultations`)
          .set('Cookie', doctor)
          .send({}),
        request(harness.server)
          .post(`${API}/encounters/${encounterId}/consultations`)
          .set('Cookie', otherDoctor)
          .send({}),
      ]);

      // Neither may fail with an internal error: the sequence is worked
      // out under a lock on the visit.
      expect([first.status, second.status].sort()).toEqual([201, 201]);
      expect(
        [first.body.sequence, second.body.sequence].sort(),
        'two different sequence numbers',
      ).toEqual([1, 2]);
    });

    it('CON-T-06: another doctor cannot see a draft; an administrator can', async () => {
      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      // Not found rather than forbidden: half-written clinical thinking is
      // not a record, and its existence is not a colleague's business.
      await request(harness.server)
        .get(`${API}/consultations/${created.body.id}`)
        .set('Cookie', otherDoctor)
        .expect(404);

      // An administrator may, because somebody has to reassign it when a
      // locum goes home. That is break-glass and is recorded.
      await request(harness.server)
        .get(`${API}/consultations/${created.body.id}`)
        .set('Cookie', admin)
        .expect(200);

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'clinical.viewed' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('a nurse may read a signed record and may not write one', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);
      await request(harness.server)
        .get(`${API}/consultations/${id}`)
        .set('Cookie', nurse)
        .expect(200);
      await request(harness.server)
        .patch(`${API}/consultations/${id}`)
        .set('Cookie', nurse)
        .send({ hpi: 'no' })
        .expect(403);
    });

    it('lists a doctor’s own unsigned drafts', async () => {
      const { encounterId } = await withDoctor();
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      const drafts = await request(harness.server)
        .get(`${API}/me/drafts`)
        .set('Cookie', doctor)
        .expect(200);
      expect(drafts.body.items.length).toBeGreaterThan(0);
      expect(drafts.body.items[0].patient.name).toBeTruthy();
      expect(drafts.body.items[0]).toHaveProperty('stale', false);
    });
  });

  // ---------------------------------------------------------- signing

  describe('Signing (CON-F-14)', () => {
    it('CON-T-02: refuses without the minimum, and says what is missing', async () => {
      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      const refused = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', doctor)
        .expect(422);
      expect(refused.body.code).toBe('sign_minimum_not_met');
      expect(refused.body.detail).toContain('what brought the patient in');
      expect(refused.body.detail).toContain('at least one diagnosis');

      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Cough' })
        .expect(200);
      const stillRefused = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', doctor)
        .expect(422);
      expect(stillRefused.body.errors.missing).toEqual(['at least one diagnosis']);
    });

    it('CON-R-03: only the doctor who wrote it may sign it', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', otherDoctor)
        .expect(403);
      // Nor an administrator, who can reassign but never sign.
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', admin)
        .expect(403);
    });

    it('records who, when and from where, and fingerprints the content', async () => {
      const { id } = await readyToSign();
      const signed = await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      expect(signed.body.status).toBe('SIGNED');
      expect(signed.body.signedAt).toBeTruthy();
      expect(signed.body.signedBy).toBe(fx.doctor.id);
      expect(signed.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('locks the vitals it was based on', async () => {
      const { encounterId } = await withDoctor();
      const vitals = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', doctor)
        .send({ systolic: 124, diastolic: 78, advance: false })
        .expect(201);
      expect(vitals.body.locked).toBe(false);

      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Headache' })
        .expect(200);
      await request(harness.server)
        .put(`${API}/consultations/${created.body.id}/diagnoses`)
        .set('Cookie', doctor)
        .send({ diagnoses: [{ description: 'Tension headache' }] })
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      // TRI-F-10: the vitals are part of what was signed.
      const after = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', doctor)
        .expect(200);
      expect(after.body.records[0].locked).toBe(true);
      await request(harness.server)
        .patch(`${API}/triage/${vitals.body.id}`)
        .set('Cookie', doctor)
        .send({ systolic: 130, diastolic: 80 })
        .expect(409);
    });

    it('CON-T-08: sends the patient on, and the encounter decides where', async () => {
      const { id, encounterId } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', doctor)
        .expect(200);
      // No prescriptions exist yet, so everybody goes to pay.
      expect(encounter.body.encounter.status).toBe('PAYMENT_WAITING');
      const routed = encounter.body.timeline.at(-1);
      expect(routed.note).toContain('consultation was signed');
    });

    it('adds a chronic diagnosis to the patient’s conditions', async () => {
      const { encounterId, patientId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Routine review' })
        .expect(200);
      await request(harness.server)
        .put(`${API}/consultations/${created.body.id}/diagnoses`)
        .set('Cookie', doctor)
        .send({
          diagnoses: [
            { description: 'Type 2 diabetes mellitus', icd10Code: 'E11', isChronic: true, certainty: 'CONFIRMED' },
          ],
        })
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const clinical = await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      expect(
        clinical.body.conditions.map((c: { condition: string }) => c.condition),
      ).toContain('Type 2 diabetes mellitus');
    });

    it('CON-T-09: an unsigned draft stops the visit being finished', async () => {
      const { encounterId } = await withDoctor();
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', doctor)
        .send({ to: 'PAYMENT_WAITING' })
        .expect(200);

      const refused = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/transition`)
        .set('Cookie', reception)
        .send({ to: 'COMPLETED' })
        .expect(422);
      expect(refused.body.code).toBe('completion_blocked');
      expect(refused.body.detail).toContain('not been signed');
    });
  });

  // -------------------------------------------------------- immutable

  describe('A signed record is immutable (CON-R-01)', () => {
    it('CON-T-03: refuses an edit, and the database refuses one made around it', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const refused = await request(harness.server)
        .patch(`${API}/consultations/${id}`)
        .set('Cookie', doctor)
        .send({ hpi: 'Something different' })
        .expect(409);
      expect(refused.body.code).toBe('consultation_signed');

      // CON-N-05: proved by direct SQL, not only through the API.
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE consultation SET hpi = 'edited in the database' WHERE id = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(/cannot be changed/);
    });

    it('the diagnoses are locked with it', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      await request(harness.server)
        .put(`${API}/consultations/${id}/diagnoses`)
        .set('Cookie', doctor)
        .send({ diagnoses: [{ description: 'Something else' }] })
        .expect(409);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE diagnosis SET description = 'rewritten' WHERE consultation_id = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(/has been signed/);
    });

    it('CON-T-04: a correction keeps the original and records both', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const amended = await request(harness.server)
        .post(`${API}/consultations/${id}/amend`)
        .set('Cookie', doctor)
        .send({
          type: 'CORRECTION',
          field: 'hpi',
          current: 'Dry cough, worse at night, no fever. Corrected from notes.',
          reason: 'Transcription error: I wrote the wrong duration at the time.',
        })
        .expect(200);

      // The record itself is untouched.
      expect(amended.body.consultation.hpi).toBe('Dry, worse at night.');
      expect(amended.body.amendments).toHaveLength(1);
      expect(amended.body.amendments[0].type).toBe('CORRECTION');
      expect(amended.body.amendments[0].field).toBe('hpi');
      expect(amended.body.amendments[0].previous.hpi).toBe('Dry, worse at night.');
      expect(amended.body.amendments[0].current.text).toContain('Corrected from notes');
    });

    it('an addendum adds without superseding anything', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const amended = await request(harness.server)
        .post(`${API}/consultations/${id}/amend`)
        .set('Cookie', doctor)
        .send({
          type: 'ADDENDUM',
          current: 'Patient telephoned later to say the cough had settled.',
          reason: 'Telephone call from the patient after the consultation.',
        })
        .expect(200);
      expect(amended.body.amendments[0].field).toBeNull();
      expect(amended.body.amendments[0].previous).toBeNull();
    });

    it('CON-R-04: an amendment needs a real reason', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      // "typo" explains nothing to somebody reading this in two years.
      await request(harness.server)
        .post(`${API}/consultations/${id}/amend`)
        .set('Cookie', doctor)
        .send({ type: 'ADDENDUM', current: 'x', reason: 'typo' })
        .expect(400);
    });

    it('an amendment cannot itself be tidied away', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${id}/amend`)
        .set('Cookie', doctor)
        .send({ type: 'ADDENDUM', current: 'Later note.', reason: 'Adding something I left out.' })
        .expect(200);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM consultation_amendment WHERE consultation_id = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  // -------------------------------------------------------- integrity

  describe('Integrity (CON-R-02, CON-N-04)', () => {
    it('verifies a signed record against its own fingerprint', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      // This clinic's own records. The nightly job sweeps every clinic on
      // the server, which on a shared development database would include
      // whatever another test run left behind.
      const service = harness.app.get(ConsultationService);
      const clean = await harness.db.withTenant(fx.tenantId, (tx) =>
        service.verifyIntegrity(tx),
      );
      expect(clean.checked).toBeGreaterThan(0);
      expect(clean.mismatched).toEqual([]);
    });

    it('CON-T-05: reports a record changed around every other control', async () => {
      const { id } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      // The trigger is the thing that normally stops this. Disabling it is
      // exactly the scenario the hash exists for: a privileged role, a
      // restore from a doctored backup, a migration that meant well.
      await harness.db.withPlatform('simulate tampering for the test', async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE consultation DISABLE TRIGGER consultation_signed_is_immutable_trigger',
        );
      });
      try {
        await harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE consultation SET hpi = 'quietly altered' WHERE id = $1::uuid`,
            id,
          ),
        );
      } finally {
        await harness.db.withPlatform('restore the trigger', async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE consultation ENABLE TRIGGER consultation_signed_is_immutable_trigger',
          );
        });
      }

      const service = harness.app.get(ConsultationService);
      const result = await harness.db.withTenant(fx.tenantId, (tx) =>
        service.verifyIntegrity(tx),
      );
      expect(result.mismatched.map((m) => m.id)).toContain(id);

      // And the nightly job across every clinic finds it too.
      const job = harness.app.get(ConsultationIntegrityJob);
      expect((await job.run()).mismatched).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------- cancelling, reassigning

  describe('Drafts that do not become records', () => {
    it('CON-F-18: a cancelled draft is kept, not deleted', async () => {
      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      const cancelled = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/cancel`)
        .set('Cookie', doctor)
        .send({ reason: 'Wrong patient chart opened' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.cancelReason).toContain('Wrong patient');

      // Still there, and no longer blocking the visit.
      await request(harness.server)
        .get(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .expect(200);
    });

    it('§14: an administrator hands a locum’s draft to another doctor', async () => {
      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);

      await request(harness.server)
        .post(`${API}/auth/reauth`)
        .set('Cookie', admin)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      const moved = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/reassign`)
        .set('Cookie', admin)
        .send({ toDoctorId: otherDoctorUser.id, reason: 'Dr Farid has left for the day' })
        .expect(200);
      expect(moved.body.doctorId).toBe(otherDoctorUser.id);

      // And now the other doctor can finish it.
      await request(harness.server)
        .get(`${API}/consultations/${created.body.id}`)
        .set('Cookie', otherDoctor)
        .expect(200);
    });
  });

  // -------------------------------------------------------- templates

  describe('Templates and copy-forward (CON-F-06, CON-F-07)', () => {
    it('fills empty sections and never overwrites what the doctor wrote', async () => {
      const template = await request(harness.server)
        .post(`${API}/clinical-templates`)
        .set('Cookie', doctor)
        .send({
          name: 'URTI',
          keywords: ['urti', 'cough'],
          content: {
            chiefComplaint: 'Cough and cold',
            examination: 'Throat mildly injected. Chest clear.',
            planText: 'Symptomatic relief. Return if worse.',
          },
        })
        .expect(201);

      const { encounterId } = await withDoctor();
      const created = await request(harness.server)
        .post(`${API}/encounters/${encounterId}/consultations`)
        .set('Cookie', doctor)
        .send({})
        .expect(201);
      await request(harness.server)
        .patch(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .send({ chiefComplaint: 'Cough for five days, own words' })
        .expect(200);

      const applied = await request(harness.server)
        .post(`${API}/consultations/${created.body.id}/apply-template/${template.body.id}`)
        .set('Cookie', doctor)
        .expect(200);

      expect(applied.body.filled).toEqual(['examination', 'planText']);
      // The single most infuriating thing this screen could do.
      expect(applied.body.skipped).toEqual(['chiefComplaint']);

      const after = await request(harness.server)
        .get(`${API}/consultations/${created.body.id}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(after.body.consultation.chiefComplaint).toBe('Cough for five days, own words');
      expect(after.body.consultation.examination).toContain('Throat mildly injected');
    });

    it('a doctor cannot edit another doctor’s template', async () => {
      const mine = await request(harness.server)
        .post(`${API}/clinical-templates`)
        .set('Cookie', doctor)
        .send({ name: 'Mine', content: { hpi: 'x' } })
        .expect(201);
      await request(harness.server)
        .patch(`${API}/clinical-templates/${mine.body.id}`)
        .set('Cookie', otherDoctor)
        .send({ name: 'Theirs now' })
        .expect(403);
    });

    it('only an administrator makes one for the whole clinic', async () => {
      await request(harness.server)
        .post(`${API}/clinical-templates`)
        .set('Cookie', doctor)
        .send({ name: 'Clinic wide', scope: 'TENANT', content: { hpi: 'x' } })
        .expect(403);
      await request(harness.server)
        .post(`${API}/clinical-templates`)
        .set('Cookie', admin)
        .send({ name: 'Clinic wide', scope: 'TENANT', content: { hpi: 'x' } })
        .expect(201);
    });

    it('CON-R-08: copy-forward brings history across and says where from', async () => {
      const { id, patientId } = await readyToSign();
      await request(harness.server)
        .patch(`${API}/consultations/${id}`)
        .set('Cookie', doctor)
        .send({ history: 'Hypertension, on amlodipine 5 mg.', examination: 'Nil of note.' })
        .expect(200);
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      // Their visit has to finish before they can come back: one open
      // encounter per patient per branch (ENC-R-06).
      await request(harness.server)
        .post(`${API}/encounters/${(await request(harness.server)
          .get(`${API}/consultations/${id}`)
          .set('Cookie', doctor)
          .expect(200)).body.consultation.encounterId}/transition`)
        .set('Cookie', reception)
        .send({ to: 'COMPLETED' })
        .expect(200);

      // The same patient comes back.
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);
      const next = encounter.body.encounter.id;
      for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
        await request(harness.server)
          .post(`${API}/encounters/${next}/transition`)
          .set('Cookie', doctor)
          .send({ to })
          .expect(200);
      }

      const copied = await request(harness.server)
        .post(`${API}/encounters/${next}/consultations`)
        .set('Cookie', doctor)
        .send({ copyFromId: id })
        .expect(201);

      expect(copied.body.history).toContain('amlodipine');
      // Marked, so a stale account is never mistaken for today's.
      expect(copied.body.copiedFromId).toBe(id);
      // Never the complaint or the plan: those were about a visit that is
      // over, and a plan copied forward is how the wrong treatment carries on.
      expect(copied.body.chiefComplaint).toBeNull();
      expect(copied.body.planText).toBeNull();
    });

    it('lists what this patient was seen for before', async () => {
      const { id, patientId } = await readyToSign();
      await request(harness.server)
        .post(`${API}/consultations/${id}/sign`)
        .set('Cookie', doctor)
        .expect(200);

      const history = await request(harness.server)
        .get(`${API}/patients/${patientId}/consultations`)
        .set('Cookie', doctor)
        .expect(200);
      expect(history.body.items[0].primaryDiagnosis).toBe('Upper respiratory tract infection');
      expect(history.body.items[0].signedAt).toBeTruthy();
    });
  });

  // ----------------------------------------------------- quick phrases

  describe('Quick phrases (CON-F-08)', () => {
    it('keeps a doctor’s own shortcuts', async () => {
      const added = await request(harness.server)
        .post(`${API}/me/quick-phrases`)
        .set('Cookie', doctor)
        .send({ trigger: 'nad', expansion: 'No abnormality detected' })
        .expect(201);
      // A leading dot whether or not it was typed.
      expect(added.body.items.some((p: { trigger: string }) => p.trigger === '.nad')).toBe(true);

      const theirs = await request(harness.server)
        .get(`${API}/me/quick-phrases`)
        .set('Cookie', otherDoctor)
        .expect(200);
      expect(theirs.body.items).toHaveLength(0);
    });
  });
});
