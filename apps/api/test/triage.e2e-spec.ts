import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Harness, totpFor, type Fixture, DEFAULT_PASSWORD } from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';

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

describe('TRI — triage and vitals', () => {
  const harness = new Harness();
  let fx: Fixture;
  let reception: string;
  let doctor: string;
  let nurse: string;
  let admin: string;
  let branch: string;

  let seq = 0;

  /**
   * A patient, checked in and standing at the triage station.
   *
   * Each one gets a distinct birthday. The year is what the caller asked
   * for, because some of these tests are about a child being judged
   * differently from an adult; only the day moves. Sharing a birthday with
   * a similar name is what the duplicate check is for, and it is right to
   * fire.
   */
  async function atTriage(options: { born?: string } = {}) {
    seq += 1;
    // The year is what the caller asked for, because some of these tests
    // are about a child being judged differently from an adult. The month
    // and day come from the counter, which gives 336 distinct birthdays
    // before any repeat: sharing one with a similar name is what the
    // duplicate check is for, and it is right to fire.
    const [year] = (options.born ?? '1986-05-04').split('-');
    const born =
      `${year}-${String((seq % 12) + 1).padStart(2, '0')}` +
      `-${String((seq % 28) + 1).padStart(2, '0')}`;
    const patient = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Triage Patient ${seq}`,
        idType: 'NONE',
        gender: 'FEMALE',
        dateOfBirth: born,
        notes: 'Test patient',
        phone: `011-${String(30_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);

    const encounter = await request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', reception)
      .send({ patientId: patient.body.patient.id })
      .expect(201);

    const id = encounter.body.encounter.id as string;
    await request(harness.server)
      .post(`${API}/encounters/${id}/transition`)
      .set('Cookie', nurse)
      .send({ to: 'TRIAGE_IN_PROGRESS' })
      .expect(200);

    return { encounterId: id, patientId: patient.body.patient.id as string };
  }

  function record(encounterId: string, body: Record<string, unknown>, cookie = nurse) {
    return request(harness.server)
      .post(`${API}/encounters/${encounterId}/triage`)
      .set('Cookie', cookie)
      .send(body);
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('triage');
    branch = fx.branchAId;
    const nurseUser = await harness.addUser(fx, {
      name: 'Jururawat Mei',
      roles: [{ branchId: fx.branchAId, role: Role.NURSE }],
    });
    [reception, doctor, nurse] = await Promise.all([
      signIn(harness, fx.frontdesk.email),
      signIn(harness, fx.doctor.email),
      signIn(harness, nurseUser.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ------------------------------------------------------------ recording

  describe('Recording vitals (TRI-F-01, TRI-R-01, TRI-R-02)', () => {
    it('TRI-T-01: works out the body mass index and gives it back readable', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, {
        weightKg: 70,
        heightCm: 175,
        systolic: 120,
        diastolic: 80,
      }).expect(201);

      expect(saved.body.bmi).toBe(22.9);
      expect(saved.body.weightKg).toBe(70);
      expect(saved.body.heightCm).toBe(175);
      expect(saved.body.maxFlagLevel).toBe('NONE');
    });

    it('stores in fixed units and reads back in the ones a nurse types', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, {
        temperature: 37.2,
        glucose: 5.6,
        weightKg: 62.4,
      }).expect(201);

      expect(saved.body.temperature).toBe(37.2);
      expect(saved.body.glucose).toBe(5.6);
      expect(saved.body.weightKg).toBe(62.4);

      // Integers underneath: deci-degrees, grams, mmol/L times ten.
      const row = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.triage.findFirst({ where: { id: saved.body.id } }),
      );
      expect(row?.temperatureDc).toBe(372);
      expect(row?.weightG).toBe(62_400);
      expect(row?.glucoseX10).toBe(56);
    });

    it('refuses to save nothing at all, and accepts a note as something', async () => {
      const { encounterId } = await atTriage();
      const refused = await record(encounterId, {}).expect(400);
      expect(refused.body.code).toBe('nothing_recorded');

      // §14: a patient who refuses to be measured is a thing that happened.
      await record(encounterId, { notes: 'Patient declined all observations.' }).expect(201);
    });

    it('TRI-R-02: will not take a body mass index from the client at all', async () => {
      const { encounterId } = await atTriage();
      // Refused outright rather than quietly ignored, which is stronger:
      // a client sending it has misunderstood, and should be told.
      await record(encounterId, { weightKg: 70, heightCm: 175, bmi: 99 }).expect(400);

      const saved = await record(encounterId, { weightKg: 70, heightCm: 175 }).expect(201);
      expect(saved.body.bmi).toBe(22.9);
    });

    it('two people recording at once get two records, not a collision', async () => {
      const { encounterId } = await atTriage();
      const [first, second] = await Promise.all([
        record(encounterId, { spo2: 97, notes: 'One' }),
        record(encounterId, { spo2: 96, notes: 'Two' }, doctor),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 201]);
      expect([first.body.sequence, second.body.sequence].sort()).toEqual([1, 2]);
    });

    it('TRI-F-06: a second set of readings is a new record, not an edit', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { spo2: 94, notes: 'Before nebuliser' }, nurse).expect(201);
      const second = await record(encounterId, { spo2: 98, notes: 'After nebuliser' }).expect(201);
      expect(second.body.sequence).toBe(2);

      const all = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', doctor)
        .expect(200);
      expect(all.body.records).toHaveLength(2);
      expect(all.body.records.map((r: { sequence: number }) => r.sequence)).toEqual([1, 2]);
    });
  });

  // ----------------------------------------------------------- implausible

  describe('Implausible is not abnormal (§12)', () => {
    it('TRI-T-03: refuses a blood pressure that cannot be real', async () => {
      const { encounterId } = await atTriage();
      // 422, not 400: the request is well formed and the value is wrong.
      const refused = await record(encounterId, { systolic: 1200, diastolic: 80 }).expect(422);
      expect(refused.body.code).toBe('implausible_vital');
      // The message has to tell a nurse what to do, not name a schema.
      expect(refused.body.detail).toContain('Check what was typed');
    });

    it('refuses a blood pressure the wrong way round', async () => {
      const { encounterId } = await atTriage();
      const refused = await record(encounterId, { systolic: 80, diastolic: 120 }).expect(422);
      expect(refused.body.detail).toContain('right way round');
    });

    it('accepts a reading that is alarming but real', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { spo2: 86, systolic: 85, diastolic: 50 }).expect(201);
      expect(saved.body.maxFlagLevel).toBe('CRITICAL');
    });
  });

  // ---------------------------------------------------------------- flags

  describe('Flagging (TRI-F-03, TRI-R-03)', () => {
    it('TRI-T-02: oxygen saturation of 86 is critical, and says why', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { spo2: 86 }).expect(201);

      expect(saved.body.maxFlagLevel).toBe('CRITICAL');
      const flag = saved.body.flags.find((f: { param: string }) => f.param === 'spo2');
      expect(flag).toMatchObject({ level: 'CRITICAL', value: 86 });
      expect(flag.threshold).toContain('below 90');
      expect(flag.label).toBe('Oxygen saturation');
    });

    it('a flag never stops the nurse saving', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { spo2: 84, heartRate: 140, systolic: 85, diastolic: 45 }).expect(
        201,
      );
    });

    it('judges a child against paediatric numbers', async () => {
      const { encounterId } = await atTriage({ born: '2022-05-04' });
      const saved = await record(encounterId, { heartRate: 120 }).expect(201);
      // Unremarkable in a toddler; would be noted in an adult.
      expect(saved.body.maxFlagLevel).toBe('NONE');

      const { encounterId: adult } = await atTriage({ born: '1980-05-04' });
      const grown = await record(adult, { heartRate: 120 }).expect(201);
      expect(grown.body.maxFlagLevel).toBe('ABNORMAL');
    });

    it('TRI-T-07: changing a threshold does not rewrite what was recorded', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { spo2: 93 }).expect(201);
      expect(saved.body.maxFlagLevel).toBe('ABNORMAL');

      // The clinic decides 93 is fine after all.
      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { vitals: { spo2Low: 90 } } })
        .expect(200);

      try {
        const reread = await request(harness.server)
          .get(`${API}/encounters/${encounterId}/triage`)
          .set('Cookie', doctor)
          .expect(200);
        // What the nurse saw and acted on is unchanged.
        expect(reread.body.records[0].maxFlagLevel).toBe('ABNORMAL');
        expect(reread.body.records[0].flags).toHaveLength(1);

        // A new reading is judged against the new number.
        const { encounterId: later } = await atTriage();
        const fresh = await record(later, { spo2: 93 }).expect(201);
        expect(fresh.body.maxFlagLevel).toBe('NONE');
      } finally {
        await request(harness.server)
          .patch(`${API}/branches/${branch}/settings`)
          .set('Cookie', admin)
          .send({ settings: { vitals: { spo2Low: null } } })
          .expect(200);
      }
    });
  });

  // ------------------------------------------------------ the queue and allergies

  describe('What saving does (TRI-F-05, TRI-F-07, TRI-F-08)', () => {
    it('TRI-T-05: sends the patient on to the doctor', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { systolic: 120, diastolic: 80, advance: true }).expect(201);

      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', nurse)
        .expect(200);
      expect(encounter.body.encounter.status).toBe('DOCTOR_WAITING');
    });

    it('keeps them at triage when a second reading is coming', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { spo2: 91, notes: 'Nebuliser given', advance: false }).expect(201);

      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', nurse)
        .expect(200);
      expect(encounter.body.encounter.status).toBe('TRIAGE_IN_PROGRESS');
    });

    it('TRI-F-08: a critical reading can move them to the front of the queue', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { spo2: 85, escalate: true }).expect(201);

      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', nurse)
        .expect(200);
      expect(encounter.body.encounter.priority).toBe('EMERGENCY');
      expect(encounter.body.encounter.priorityReason).toContain('Oxygen saturation');
    });

    it('does not escalate on its own', async () => {
      // The nurse is looking at the patient; the system is looking at a
      // number. It prompts, it does not decide.
      const { encounterId } = await atTriage();
      await record(encounterId, { spo2: 85 }).expect(201);
      const encounter = await request(harness.server)
        .get(`${API}/encounters/${encounterId}`)
        .set('Cookie', nurse)
        .expect(200);
      expect(encounter.body.encounter.priority).toBe('NORMAL');
    });

    it('TRI-T-04: asks about allergies when nobody has, and stops asking once told', async () => {
      const { encounterId, patientId } = await atTriage();

      const form = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', nurse)
        .expect(200);
      expect(form.body.allergyPromptNeeded).toBe(true);

      await request(harness.server)
        .put(`${API}/patients/${patientId}/nkda`)
        .set('Cookie', nurse)
        .send({ nkda: true })
        .expect(200);

      const again = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', nurse)
        .expect(200);
      expect(again.body.allergyPromptNeeded).toBe(false);
    });

    it('will not record vitals against a finished visit', async () => {
      const { encounterId } = await atTriage();
      await request(harness.server)
        .post(`${API}/encounters/${encounterId}/cancel`)
        .set('Cookie', reception)
        .send({ reason: 'Patient left before being seen' })
        .expect(200);

      const refused = await record(encounterId, { spo2: 98 }).expect(400);
      expect(refused.body.code).toBe('encounter_closed');
    });
  });

  // --------------------------------------------------- editing and amending

  describe('Editing, and after the consultation is signed (TRI-F-10)', () => {
    it('can be corrected while the visit is still open', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);

      const fixed = await request(harness.server)
        .patch(`${API}/triage/${saved.body.id}`)
        .set('Cookie', nurse)
        .send({ systolic: 130, diastolic: 85 })
        .expect(200);
      expect(fixed.body.systolic).toBe(130);
      expect(fixed.body.locked).toBe(false);
    });

    it('TRI-T-06: once locked it is history, and changes are amendments', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);
      const triageId = saved.body.id as string;

      // Consultation does not exist yet, so the lock it will apply is
      // applied here. What is under test is the rule, not who calls it.
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.triage.updateMany({ where: { id: triageId }, data: { lockedAt: new Date() } }),
      );

      const refused = await request(harness.server)
        .patch(`${API}/triage/${triageId}`)
        .set('Cookie', nurse)
        .send({ systolic: 130, diastolic: 85 })
        .expect(409);
      expect(refused.body.code).toBe('triage_locked');

      const amended = await request(harness.server)
        .post(`${API}/triage/${triageId}/amend`)
        .set('Cookie', doctor)
        .send({ systolic: 130, diastolic: 85, reason: 'Cuff was too small; repeated on a large cuff' })
        .expect(200);

      // The original values are still the record.
      expect(amended.body.triage.systolic).toBe(120);
      expect(amended.body.amendments).toHaveLength(1);
      expect(amended.body.amendments[0].reason).toContain('large cuff');
      expect(amended.body.amendments[0].previous.systolic).toBe(120);
      expect(amended.body.amendments[0].current.systolic).toBe(130);
    });

    it('an amendment needs a reason, and cannot be tidied away', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.triage.updateMany({ where: { id: saved.body.id }, data: { lockedAt: new Date() } }),
      );

      await request(harness.server)
        .post(`${API}/triage/${saved.body.id}/amend`)
        .set('Cookie', doctor)
        .send({ systolic: 130, reason: '' })
        .expect(400);

      await request(harness.server)
        .post(`${API}/triage/${saved.body.id}/amend`)
        .set('Cookie', doctor)
        .send({ systolic: 130, reason: 'Corrected on review' })
        .expect(200);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM triage_amendment WHERE triage_id = $1::uuid`,
            saved.body.id,
          ),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('the database refuses an edit to a locked record', async () => {
      const { encounterId } = await atTriage();
      const saved = await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);
      await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.triage.updateMany({ where: { id: saved.body.id }, data: { lockedAt: new Date() } }),
      );

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE triage SET systolic = 200 WHERE id = $1::uuid`,
            saved.body.id,
          ),
        ),
      ).rejects.toThrow(/locked/);
    });
  });

  // -------------------------------------------------------- reading it back

  describe('Reading vitals (§15)', () => {
    it('the front desk cannot see them', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);
      await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', reception)
        .expect(403);
    });

    it('a doctor reading them is recorded', async () => {
      const { encounterId } = await atTriage();
      await record(encounterId, { systolic: 120, diastolic: 80 }).expect(201);
      await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', doctor)
        .expect(200);

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'clinical.viewed' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('TRI-F-09: draws a trend across visits', async () => {
      const { encounterId, patientId } = await atTriage();
      await record(encounterId, { systolic: 128, diastolic: 82 }).expect(201);

      const trend = await request(harness.server)
        .get(`${API}/patients/${patientId}/vitals-trend`)
        .set('Cookie', doctor)
        .query({ param: 'systolic' })
        .expect(200);
      expect(trend.body.points.at(-1)).toMatchObject({ value: 128 });

      const refused = await request(harness.server)
        .get(`${API}/patients/${patientId}/vitals-trend`)
        .set('Cookie', doctor)
        .query({ param: 'mood' })
        .expect(400);
      expect(refused.body.code).toBe('unknown_vital');
    });

    it('TRI-F-04: offers the last height, and only hints at the weight', async () => {
      const { encounterId, patientId } = await atTriage();
      await record(encounterId, { heightCm: 168, weightKg: 61 }).expect(201);

      const second = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(409);
      // Already open here, which is the point: reuse the same visit.
      expect(second.body.code).toBe('encounter_already_open');

      const form = await request(harness.server)
        .get(`${API}/encounters/${encounterId}/triage`)
        .set('Cookie', nurse)
        .expect(200);
      expect(form.body.prefill.heightCm).toBe(168);
      // Weight comes back as part of the last reading, for the nurse to
      // look at, and is never filled into the field.
      expect(form.body.prefill.lastReading.weightKg).toBe(61);
    });
  });
});
