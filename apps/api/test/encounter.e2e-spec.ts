import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  type SeededUser,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { EncounterCompletionRegistry } from '../src/modules/encounter/encounter.service.js';

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

describe('ENC — encounters and the queue', () => {
  const harness = new Harness();
  let fx: Fixture;
  let reception: string;
  let doctor: string;
  let nurse: string;
  let admin: string;
  let doctorUser: SeededUser;
  let branch: string;

  /** A patient to check in, since every test needs one. */
  let seq = 0;
  async function newPatient(name = 'Queue Patient'): Promise<string> {
    seq += 1;
    const created = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `${name} ${seq}`,
        idType: 'NONE',
        gender: 'MALE',
        // Distinct per patient. Sharing a birthday with a similar name is
        // exactly what the duplicate check is for, and it is right to fire.
        dateOfBirth: new Date(
          Date.UTC(1960 + (seq % 50), seq % 12, (seq % 27) + 1),
        )
          .toISOString()
          .slice(0, 10),
        notes: 'Test patient for the queue',
        phone: `011-${String(20_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    return created.body.patient.id;
  }

  // Not async: these return supertest's chainable request so that callers
  // can keep writing `.expect(201)` on the end of them.
  function checkIn(body: Record<string, unknown>, cookie = reception) {
    return request(harness.server)
      .post(`${API}/branches/${branch}/encounters`)
      .set('Cookie', cookie)
      .send(body);
  }

  /**
   * A visit walked forward to a given status, through the states it
   * would really pass through.
   */
  async function reach(target: string): Promise<string> {
    const created = await checkIn({ patientId: await newPatient() }).expect(
      201,
    );
    const id = created.body.encounter.id as string;
    const route = [
      'TRIAGE_IN_PROGRESS',
      'DOCTOR_WAITING',
      'IN_CONSULTATION',
      target,
    ];
    for (const to of route) {
      if (to === created.body.encounter.status) continue;
      await move(id, to, to === 'IN_CONSULTATION' ? doctor : reception).expect(
        200,
      );
      if (to === target) break;
    }
    return id;
  }

  function move(id: string, to: string, cookie = reception, note?: string) {
    return request(harness.server)
      .post(`${API}/encounters/${id}/transition`)
      .set('Cookie', cookie)
      .send({ to, note });
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('encounter');
    branch = fx.branchAId;
    doctorUser = fx.doctor;
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

  // ------------------------------------------------------------- check in

  describe('Checking in (ENC-F-01 … F-13)', () => {
    it('ENC-T-01: joins the triage queue with a number, and leaves a timeline', async () => {
      const patientId = await newPatient('First Today');
      const created = await checkIn({ patientId }).expect(201);

      const encounter = created.body.encounter;
      expect(encounter.status).toBe('TRIAGE_WAITING');
      expect(encounter.queueNo).toMatch(/^A-\d{3}$/);
      expect(encounter.encounterNo).toMatch(/^TA-\d{8}-\d{3}$/);

      const events = await request(harness.server)
        .get(`${API}/encounters/${encounter.id}/events`)
        .set('Cookie', reception)
        .expect(200);
      // One for arriving, one for joining the queue.
      expect(events.body.items).toHaveLength(2);
      expect(events.body.items[0].toStatus).toBe('REGISTERED');
      expect(events.body.items[1].toStatus).toBe('TRIAGE_WAITING');
      expect(events.body.items[0].actorName).toBeTruthy();
    });

    it('ENC-T-05: refuses a second open visit at the same branch', async () => {
      const patientId = await newPatient('Twice');
      await checkIn({ patientId }).expect(201);
      const again = await checkIn({ patientId }).expect(409);
      expect(again.body.code).toBe('encounter_already_open');
      expect(again.body.errors.queueNo).toMatch(/^A-/);
    });

    it('allows the same patient at another branch, and says so', async () => {
      const patientId = await newPatient('Two Branches');
      await checkIn({ patientId }).expect(201);
      const elsewhere = await request(harness.server)
        .post(`${API}/branches/${fx.branchBId}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);
      expect(elsewhere.body.warnings[0]).toContain('another branch');
    });

    it('ENC-T-04: fifty at once get fifty different numbers', async () => {
      const patients = await Promise.all(
        Array.from({ length: 50 }, (_, i) => newPatient(`Rush ${i}`)),
      );
      const results = await Promise.all(
        patients.map((patientId) => checkIn({ patientId })),
      );

      const numbers = results
        .filter((r) => r.status === 201)
        .map((r) => r.body.encounter.queueNo as string);
      expect(numbers.length).toBe(50);
      expect(new Set(numbers).size, 'every queue number is different').toBe(50);

      // And sequential, with no gaps: they came from one counter.
      const values = numbers
        .map((n) => Number(n.split('-')[1]))
        .sort((a, b) => a - b);
      expect(values.at(-1)! - values[0]!).toBe(49);
    }, 60_000);

    it('an emergency gets its own series and jumps the queue', async () => {
      const patientId = await newPatient('Emergency');
      const created = await checkIn({
        patientId,
        type: 'EMERGENCY',
        priorityReason: 'Chest pain, diaphoretic',
      }).expect(201);
      expect(created.body.encounter.queueNo).toMatch(/^E-/);
      expect(created.body.encounter.priority).toBe('EMERGENCY');
    });

    it('will not move a patient up the queue without a reason', async () => {
      const patientId = await newPatient('No Reason');
      const refused = await checkIn({ patientId, priority: 'URGENT' }).expect(
        400,
      );
      expect(refused.body.code).toBe('priority_reason_required');
    });
  });

  // ----------------------------------------------------------- the boards

  describe('Queues (ENC-F-15 … F-18)', () => {
    it('ENC-T-03: urgent comes before normal, whoever arrived first', async () => {
      const normalId = await newPatient('Normal Arrival');
      const urgentId = await newPatient('Urgent Arrival');

      const normal = await checkIn({ patientId: normalId }).expect(201);
      // Ten minutes later in the clinic's day, and still seen first.
      const urgent = await checkIn({
        patientId: urgentId,
        priority: 'URGENT',
        priorityReason: 'Elderly, unsteady on her feet',
      }).expect(201);

      const board = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/triage`)
        .set('Cookie', nurse)
        .expect(200);

      const ids = board.body.items.map((row: { id: string }) => row.id);
      expect(ids.indexOf(urgent.body.encounter.id)).toBeLessThan(
        ids.indexOf(normal.body.encounter.id),
      );
    });

    it('calling next takes whoever is at the head of the board', async () => {
      const patientId = await newPatient('Called');
      await checkIn({ patientId }).expect(201);

      // Read the board, then call: the contract is "the head of this
      // queue", and asserting against a specific patient would only be
      // testing what else the suite happens to have left waiting.
      const board = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/triage`)
        .set('Cookie', nurse)
        .expect(200);
      const head = board.body.items[0];
      expect(head, 'somebody is waiting').toBeTruthy();

      const called = await request(harness.server)
        .post(`${API}/branches/${branch}/queues/triage/call-next`)
        .set('Cookie', nurse)
        .expect(200);

      expect(called.body.encounter.id).toBe(head.id);
      expect(called.body.encounter.status).toBe('TRIAGE_IN_PROGRESS');
      expect(called.body.encounter.callCount).toBe(head.callCount + 1);
    });

    it('two people calling at once get different patients', async () => {
      const ids = await Promise.all([
        newPatient('Race A'),
        newPatient('Race B'),
      ]);
      for (const patientId of ids) await checkIn({ patientId }).expect(201);

      const [first, second] = await Promise.all([
        request(harness.server)
          .post(`${API}/branches/${branch}/queues/triage/call-next`)
          .set('Cookie', nurse),
        request(harness.server)
          .post(`${API}/branches/${branch}/queues/triage/call-next`)
          .set('Cookie', doctor),
      ]);

      const called = [first, second].filter((r) => r.status === 200);
      if (called.length === 2) {
        expect(called[0]!.body.encounter.id).not.toBe(
          called[1]!.body.encounter.id,
        );
      }
    });

    it('ENC-F-18: skipping sends them to the back, not out of the queue', async () => {
      const patientId = await newPatient('Skipped');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      const skipped = await request(harness.server)
        .post(`${API}/encounters/${id}/skip`)
        .set('Cookie', nurse)
        .expect(200);

      expect(skipped.body.encounter.status).toBe('TRIAGE_WAITING');
      expect(skipped.body.encounter.skipCount).toBe(1);

      const board = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/triage`)
        .set('Cookie', nurse)
        .expect(200);
      const normals = board.body.items.filter(
        (row: { priority: string }) => row.priority === 'NORMAL',
      );
      expect(normals.at(-1)?.id, 'the skipped patient is last').toBe(id);
    });

    it('asks about a no-show after enough unanswered calls', async () => {
      const patientId = await newPatient('Absent');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      let last;
      for (let i = 0; i < 3; i += 1) {
        last = await request(harness.server)
          .post(`${API}/encounters/${id}/call`)
          .set('Cookie', nurse)
          .expect(200);
      }
      expect(last!.body.suggestNoShow).toBe(true);
      // Suggested, never done automatically: they may be in the toilet.
      expect(last!.body.encounter.status).toBe('TRIAGE_WAITING');
    });

    it('shows the board with the patient and how long they have waited', async () => {
      const board = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/reception`)
        .set('Cookie', reception)
        .expect(200);
      const row = board.body.items[0];
      expect(row.patient.name).toBeTruthy();
      expect(row.waitingMinutes).toBeGreaterThanOrEqual(0);
      expect(['normal', 'amber', 'red']).toContain(row.waitTone);
    });

    it('counts what is happening today', async () => {
      const stats = await request(harness.server)
        .get(`${API}/branches/${branch}/queues-stats`)
        .set('Cookie', reception)
        .expect(200);
      expect(stats.body.waiting).toBeGreaterThan(0);
      expect(stats.body).toHaveProperty('longestWaitMinutes');
      expect(stats.body).toHaveProperty('noShows');
    });
  });

  // ------------------------------------------------------- the transitions

  describe('The state machine (ENC-R-01, ENC-R-09)', () => {
    it('ENC-T-02: refuses an impossible move and says what is possible', async () => {
      const patientId = await newPatient('Impossible');
      const created = await checkIn({ patientId }).expect(201);
      const refused = await move(created.body.encounter.id, 'COMPLETED').expect(
        422,
      );

      expect(refused.body.code).toBe('invalid_transition');
      expect(refused.body.detail).toContain('triage waiting');
      expect(refused.body.errors.allowed).toContain('TRIAGE_IN_PROGRESS');
    });

    it('will not cancel a consultation that has started', async () => {
      const patientId = await newPatient('Mid Consult');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      await move(id, 'DOCTOR_WAITING', nurse).expect(200);
      await move(id, 'IN_CONSULTATION', doctor).expect(200);

      const refused = await request(harness.server)
        .post(`${API}/encounters/${id}/cancel`)
        .set('Cookie', reception)
        .send({ reason: 'Patient changed their mind' })
        .expect(422);
      expect(refused.body.code).toBe('invalid_transition');
    });

    it('returns a patient called by mistake without losing their place', async () => {
      const patientId = await newPatient('Wrong Patient');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      await move(id, 'DOCTOR_WAITING', nurse).expect(200);
      const before = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', doctor)
        .expect(200);

      await move(id, 'IN_CONSULTATION', doctor).expect(200);
      const back = await move(id, 'DOCTOR_WAITING', doctor).expect(200);

      expect(back.body.status).toBe('DOCTOR_WAITING');
      // Their place in the queue is kept, which is the whole point.
      const drift =
        new Date(back.body.statusSince).getTime() -
        new Date(before.body.encounter.statusSince).getTime();
      expect(drift).toBeLessThan(1000);
    });

    it('ENC-T-11: the pharmacy can send a patient back to the doctor', async () => {
      // The complaint this answers: a pharmacist reading a dose that
      // cannot be right, with nothing on the screen but "send to pay"
      // and "finish".
      const id = await reach('PHARMACY_WAITING');

      const chart = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', doctor)
        .expect(200);
      const back = chart.body.encounter.allowedNext.find(
        (option: { to: string }) => option.to === 'DOCTOR_WAITING',
      );
      expect(back, 'the pharmacy has no way back to the doctor').toBeTruthy();
      expect(back.back).toBe(true);
      expect(back.requiresReason).toBe(true);

      const moved = await move(
        id,
        'DOCTOR_WAITING',
        doctor,
        'Amoxicillin 500mg three times a day for a 9kg child — please confirm',
      ).expect(200);
      expect(moved.body.status).toBe('DOCTOR_WAITING');

      // The reason is on the timeline, because this is the move somebody
      // asks about afterwards.
      const timeline = await request(harness.server)
        .get(`${API}/encounters/${id}/events`)
        .set('Cookie', doctor)
        .expect(200);
      expect(
        timeline.body.items.at(-1).note,
        'the reason was not kept',
      ).toContain('please confirm');
    });

    it('ENC-T-12: refuses to send a patient back without saying why', async () => {
      const id = await reach('PHARMACY_WAITING');

      const refused = await move(id, 'DOCTOR_WAITING', doctor).expect(422);
      expect(refused.body.code).toBe('reason_required');

      // Still where it was. A refused move must not half-happen.
      const after = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', doctor)
        .expect(200);
      expect(after.body.encounter.status).toBe('PHARMACY_WAITING');
    });

    it('ENC-T-13: sending somebody back gives them their place in the queue', async () => {
      const id = await reach('DOCTOR_WAITING');
      const waiting = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', doctor)
        .expect(200);
      const joinedTheQueue = waiting.body.encounter.statusSince;

      // All the way to the pharmacy, then back again.
      await move(id, 'IN_CONSULTATION', doctor).expect(200);
      await move(id, 'PHARMACY_WAITING', doctor).expect(200);
      await move(id, 'DOCTOR_WAITING', doctor, 'Dose query').expect(200);

      const back = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', doctor)
        .expect(200);

      // Not "waiting since now" — they have been waiting since they first
      // joined this line, and the board has to order them accordingly or
      // they go behind everyone who arrived while they were at the counter.
      expect(back.body.encounter.statusSince).toBe(joinedTheQueue);
    });

    it('a correction inside one station needs no explanation', async () => {
      // Calling the wrong name is a slip, not a claim that somebody
      // else's work was wrong. Demanding a paragraph for it would mean
      // nobody uses the button.
      const id = await reach('PHARMACY_WAITING');
      await move(id, 'DISPENSING', doctor).expect(200);
      const moved = await move(id, 'PHARMACY_WAITING', doctor).expect(200);
      expect(moved.body.status).toBe('PHARMACY_WAITING');
    });

    it('ENC-T-09: a patient marked absent can come back the same day', async () => {
      const patientId = await newPatient('Returned');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      await move(id, 'DOCTOR_WAITING', nurse).expect(200);
      await request(harness.server)
        .post(`${API}/encounters/${id}/no-show`)
        .set('Cookie', reception)
        .send({ reason: 'Called three times, not present' })
        .expect(200);

      const back = await request(harness.server)
        .post(`${API}/encounters/${id}/revert-no-show`)
        .set('Cookie', reception)
        .expect(200);
      expect(back.body.status).toBe('DOCTOR_WAITING');

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'encounter.status_changed' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
    });

    it('ENC-T-10: the database refuses a status change made around the service', async () => {
      const patientId = await newPatient('Direct SQL');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      // Exactly the thing ENC-R-01 exists to stop, done from a psql prompt:
      // a patient in the triage queue who is suddenly at the pharmacy,
      // having skipped the consultation entirely.
      //
      // Note this is a move no rule allows, not merely one no screen
      // offers. An administrator closing a stuck visit is a recovery
      // transition and the trigger does permit it, because the service is
      // the thing that decides who may and demands a reason.
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE encounter SET status = 'DISPENSING', status_since = now() WHERE id = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(/cannot go from/);
    });

    it('the database also refuses a status change that leaves the clock behind', async () => {
      const patientId = await newPatient('Frozen Clock');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE encounter SET status = 'TRIAGE_IN_PROGRESS' WHERE id = $1::uuid`,
            id,
          ),
        ),
      ).rejects.toThrow(/status_since must move/);
    });

    it('the timeline cannot be rewritten', async () => {
      const patientId = await newPatient('Timeline');
      const created = await checkIn({ patientId }).expect(201);
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM encounter_event WHERE encounter_id = $1::uuid`,
            created.body.encounter.id,
          ),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('an administrator can force a stuck visit, and it is recorded loudly', async () => {
      const patientId = await newPatient('Stuck');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      // Needs a fresh password, because it steps around the state machine.
      await request(harness.server)
        .post(`${API}/auth/reauth`)
        .set('Cookie', admin)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      const forced = await request(harness.server)
        .post(`${API}/encounters/${id}/force-transition`)
        .set('Cookie', admin)
        .send({ to: 'COMPLETED', reason: 'Recorded in error, clinic closed' })
        .expect(200);
      expect(forced.body.status).toBe('COMPLETED');

      const trail = await request(harness.server)
        .get(`${API}/audit/events`)
        .set('Cookie', admin)
        .query({ action: 'encounter.force_transition' })
        .expect(200);
      expect(trail.body.items.length).toBeGreaterThan(0);
      expect(trail.body.items[0].reason).toContain('Recorded in error');
    });

    it('nobody but an administrator can force one', async () => {
      const patientId = await newPatient('Not Allowed');
      const created = await checkIn({ patientId }).expect(201);
      await request(harness.server)
        .post(`${API}/encounters/${created.body.encounter.id}/force-transition`)
        .set('Cookie', doctor)
        .send({ to: 'COMPLETED', reason: 'I would like to' })
        .expect(403);
    });
  });

  // -------------------------------------------------- finishing the visit

  describe('Finishing (ENC-F-10)', () => {
    it('ENC-T-06: refuses while another module says there is work outstanding', async () => {
      const patientId = await newPatient('Unsigned');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      await move(id, 'DOCTOR_WAITING', nurse).expect(200);
      await move(id, 'IN_CONSULTATION', doctor).expect(200);

      // Consultation does not exist yet, so the check it will register is
      // registered here. What is under test is the guard, not the counting.
      const registry = harness.app.get(EncounterCompletionRegistry);
      registry.add('consultation', async (_tx, encounterId) =>
        encounterId === id
          ? {
              reason: 'unsigned',
              detail: 'the consultation has not been signed',
            }
          : null,
      );

      try {
        const refused = await move(id, 'COMPLETED', doctor).expect(422);
        expect(refused.body.code).toBe('completion_blocked');
        expect(refused.body.detail).toContain('not been signed');

        const chart = await request(harness.server)
          .get(`${API}/encounters/${id}`)
          .set('Cookie', doctor)
          .expect(200);
        expect(chart.body.completionBlockers).toHaveLength(1);
      } finally {
        registry.remove('consultation');
      }

      // With nothing outstanding, the same move is allowed.
      await move(id, 'COMPLETED', doctor).expect(200);
    });

    it('lets the branch turn a guard off', async () => {
      const patientId = await newPatient('Unpaid');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;
      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      await move(id, 'DOCTOR_WAITING', nurse).expect(200);
      await move(id, 'IN_CONSULTATION', doctor).expect(200);
      await move(id, 'PAYMENT_WAITING', doctor).expect(200);

      const registry = harness.app.get(EncounterCompletionRegistry);
      registry.add('billing', async () => ({
        reason: 'unpaid',
        detail: 'there is RM 35.00 still to pay',
      }));

      try {
        await move(id, 'COMPLETED', reception).expect(422);

        // A clinic that lets people settle up later turns this off.
        await request(harness.server)
          .patch(`${API}/branches/${branch}/settings`)
          .set('Cookie', admin)
          .send({
            settings: { queue: { requirePaymentBeforeComplete: false } },
          })
          .expect(200);

        await move(id, 'COMPLETED', reception).expect(200);
      } finally {
        registry.remove('billing');
        await request(harness.server)
          .patch(`${API}/branches/${branch}/settings`)
          .set('Cookie', admin)
          .send({ settings: { queue: { requirePaymentBeforeComplete: null } } })
          .expect(200);
      }
    });
  });

  // ------------------------------------------------- the clinic's own flow

  /**
   * ENC-F-05. A small clinic sends people from the counter straight to
   * the doctor, and this is the setting that says so. It was
   * implemented and never tested, which is the state a setting is in
   * just before somebody changes it and nothing happens.
   */
  describe('Whether triage happens at all (ENC-F-05)', () => {
    async function setTriage(value: string | null) {
      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { triageRequired: value } } })
        .expect(200);
    }

    it('NEVER sends a patient straight to the doctor at check-in', async () => {
      const patientId = await newPatient();
      await setTriage('NEVER');
      try {
        const created = await checkIn({ patientId }).expect(201);
        expect(created.body.encounter.status).toBe('DOCTOR_WAITING');

        // And the visit runs from there without anybody having to step
        // back through a station the clinic does not have.
        await move(created.body.encounter.id, 'IN_CONSULTATION', doctor).expect(
          200,
        );
      } finally {
        await setTriage(null);
      }
    });

    it('ALWAYS and OPTIONAL both start at triage', async () => {
      for (const setting of ['ALWAYS', 'OPTIONAL']) {
        const patientId = await newPatient();
        await setTriage(setting);
        try {
          const created = await checkIn({ patientId }).expect(201);
          expect(created.body.encounter.status).toBe('TRIAGE_WAITING');
        } finally {
          await setTriage(null);
        }
      }
    });

    it('is a branch decision, not a clinic-wide one', async () => {
      // Branch A skips triage; branch B keeps it. Both are the same
      // clinic, which is the case a growing practice actually hits.
      await setTriage('NEVER');
      try {
        const a = await checkIn({ patientId: await newPatient() }).expect(201);
        expect(a.body.encounter.status).toBe('DOCTOR_WAITING');

        const b = await request(harness.server)
          .post(`${API}/branches/${fx.branchBId}/encounters`)
          .set('Cookie', reception)
          .send({ patientId: await newPatient() });
        // Reception may not be rostered at branch B; either it is
        // refused for that reason, or it starts at triage. What must
        // not happen is branch B inheriting branch A's override.
        if (b.status === 201)
          expect(b.body.encounter.status).toBe('TRIAGE_WAITING');
        else expect([403, 400]).toContain(b.status);
      } finally {
        await setTriage(null);
      }
    });
  });

  /**
   * ENC-F-15. Most small clinics in Malaysia send the patient from the
   * doctor's room to **one** window for medicine and the bill together.
   * The statuses underneath do not change — what changes is that the
   * board stops pretending it is two people.
   */
  describe('One counter for medicine and money (ENC-F-15)', () => {
    async function setCounter(value: boolean | null) {
      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { combinedCounter: value } } })
        .expect(200);
    }

    it('the board is one queue rather than two halves of one job', async () => {
      const before = await request(harness.server)
        .get(`${API}/branches/${branch}/queues-stats`)
        .set('Cookie', reception)
        .expect(200);
      expect(before.body.stations).toContain('pharmacy');
      expect(before.body.stations).toContain('cashier');
      expect(before.body.stations).not.toContain('counter');

      await setCounter(true);
      try {
        const after = await request(harness.server)
          .get(`${API}/branches/${branch}/queues-stats`)
          .set('Cookie', reception)
          .expect(200);
        expect(after.body.stations).toContain('counter');
        expect(after.body.stations).not.toContain('pharmacy');
        expect(after.body.stations).not.toContain('cashier');
      } finally {
        await setCounter(null);
      }
    });

    it('the one queue holds both lines', async () => {
      // Somebody waiting for medicine, and somebody waiting to pay.
      const waitingForMedicine = await reach('PHARMACY_WAITING');
      const waitingToPay = await reach('PAYMENT_WAITING');

      const counter = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/counter`)
        .set('Cookie', reception)
        .expect(200);
      const ids = counter.body.items.map((row: { id: string }) => row.id);
      expect(ids).toContain(waitingForMedicine);
      expect(ids).toContain(waitingToPay);
    });

    it('calling next moves each of them the right way', async () => {
      // Both lines have somebody in them. Which one the counter calls
      // next is the queue's business — what matters is that whoever it
      // calls is moved correctly for the line they were in.
      await reach('PHARMACY_WAITING');
      await reach('PAYMENT_WAITING');

      const queue = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/counter`)
        .set('Cookie', reception)
        .expect(200);
      const head = queue.body.items[0] as { id: string; status: string };
      expect(head).toBeTruthy();

      const called = await request(harness.server)
        .post(`${API}/branches/${branch}/queues/counter/call-next`)
        .set('Cookie', reception)
        .expect(200);

      expect(called.body.encounter.id).toBe(head.id);
      if (head.status === 'PHARMACY_WAITING') {
        // Waiting for medicine: called *into* dispensing.
        expect(called.body.encounter.status).toBe('DISPENSING');
      } else {
        // Only waiting to pay: there is no "being paid" state, and
        // inventing one would put a step in the record that did not
        // happen. So they are announced and nothing else moves.
        expect(called.body.encounter.status).toBe(head.status);
        expect(called.body.encounter.callCount).toBeGreaterThan(0);
      }
    });

    it('somebody who is only waiting to pay is called, not moved', async () => {
      // The half of the rule the queue order might never exercise above.
      const id = await reach('PAYMENT_WAITING');
      const before = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', reception)
        .expect(200);

      const called = await request(harness.server)
        .post(`${API}/encounters/${id}/call`)
        .set('Cookie', reception)
        .expect(200);

      expect(called.body.encounter.status).toBe('PAYMENT_WAITING');
      expect(called.body.encounter.callCount).toBe(
        before.body.encounter.callCount + 1,
      );
    });

    it('a visit still runs from the counter to the door', async () => {
      // The point of the whole thing: one person, one window, and the
      // patient goes straight out. `DISPENSING → COMPLETED` was always a
      // legal move; nothing new had to be invented for it.
      const id = await reach('PHARMACY_WAITING');
      await move(id, 'DISPENSING', reception).expect(200);
      await move(id, 'COMPLETED', reception).expect(200);
    });
  });

  /**
   * ENC-F-11. The strip at the top of a chart: where this visit has got
   * to, which is the first question anybody opening it has.
   */
  describe('Where this visit has got to', () => {
    async function flowOf(id: string) {
      const chart = await request(harness.server)
        .get(`${API}/encounters/${id}`)
        .set('Cookie', reception)
        .expect(200);
      return chart.body.flow as Array<{ key: string; label: string; state: string }>;
    }

    it('marks what is done, where they are, and what is still to come', async () => {
      const created = await checkIn({ patientId: await newPatient() }).expect(201);
      const id = created.body.encounter.id as string;

      const atStart = await flowOf(id);
      expect(atStart.find((s) => s.key === 'triage')?.state).toBe('current');
      expect(atStart.find((s) => s.key === 'doctor')?.state).toBe('upcoming');
      expect(atStart.find((s) => s.key === 'done')?.state).toBe('upcoming');

      await move(id, 'TRIAGE_IN_PROGRESS').expect(200);
      await move(id, 'DOCTOR_WAITING').expect(200);

      const atDoctor = await flowOf(id);
      // Triage is behind them now, and stays behind them.
      expect(atDoctor.find((s) => s.key === 'triage')?.state).toBe('done');
      expect(atDoctor.find((s) => s.key === 'doctor')?.state).toBe('current');
    });

    it('does not show a step this clinic does not have', async () => {
      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { triageRequired: 'NEVER' } } })
        .expect(200);
      try {
        const created = await checkIn({ patientId: await newPatient() }).expect(201);
        const flow = await flowOf(created.body.encounter.id);
        expect(flow.find((s) => s.key === 'triage')?.state).toBe('skipped');
        expect(flow.find((s) => s.key === 'doctor')?.state).toBe('current');
      } finally {
        await request(harness.server)
          .patch(`${API}/branches/${branch}/settings`)
          .set('Cookie', admin)
          .send({ settings: { queue: { triageRequired: null } } })
          .expect(200);
      }
    });

    it('shows one counter or two, as the clinic is set up', async () => {
      const id = await reach('PHARMACY_WAITING');

      const split = await flowOf(id);
      expect(split.map((s) => s.key)).toContain('pharmacy');
      expect(split.map((s) => s.key)).toContain('payment');
      expect(split.map((s) => s.key)).not.toContain('counter');

      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { combinedCounter: true } } })
        .expect(200);
      try {
        const joined = await flowOf(id);
        expect(joined.map((s) => s.key)).toContain('counter');
        expect(joined.map((s) => s.key)).not.toContain('pharmacy');
        expect(joined.find((s) => s.key === 'counter')?.state).toBe('current');
      } finally {
        await request(harness.server)
          .patch(`${API}/branches/${branch}/settings`)
          .set('Cookie', admin)
          .send({ settings: { queue: { combinedCounter: null } } })
          .expect(200);
      }
    });

    it('only mentions a procedure once one has been ordered', async () => {
      const plain = await reach('PAYMENT_WAITING');
      expect((await flowOf(plain)).map((s) => s.key)).not.toContain('procedure');

      const created = await checkIn({ patientId: await newPatient() }).expect(201);
      const id = created.body.encounter.id as string;
      for (const to of ['TRIAGE_IN_PROGRESS', 'DOCTOR_WAITING', 'IN_CONSULTATION']) {
        await move(id, to, to === 'IN_CONSULTATION' ? doctor : reception).expect(200);
      }
      await move(id, 'PROCEDURE_WAITING', doctor).expect(200);
      expect((await flowOf(id)).find((s) => s.key === 'procedure')?.state).toBe('current');
    });

    it('says how it ended when it did not end well', async () => {
      const created = await checkIn({ patientId: await newPatient() }).expect(201);
      const id = created.body.encounter.id as string;
      await request(harness.server)
        .post(`${API}/encounters/${id}/cancel`)
        .set('Cookie', reception)
        .send({ reason: 'Patient left before being seen' })
        .expect(200);

      const flow = await flowOf(id);
      const end = flow[flow.length - 1]!;
      expect(end.label).toBe('Cancelled');
      expect(end.state).toBe('current');
      expect(flow.map((s) => s.key)).not.toContain('done');
    });
  });

  // ---------------------------------------------------- doctor and rooms

  describe('Assignment (ENC-F-06, ENC-F-07)', () => {
    it('refuses somebody who is not a doctor here', async () => {
      const patientId = await newPatient('Assigned');
      const created = await checkIn({ patientId }).expect(201);
      const refused = await request(harness.server)
        .patch(`${API}/encounters/${created.body.encounter.id}/assignment`)
        .set('Cookie', reception)
        .send({ attendingDoctorId: fx.frontdesk.id })
        .expect(400);
      expect(refused.body.code).toBe('not_a_doctor_here');
    });

    it('assigns a doctor, and asks for a reason only when changing one', async () => {
      const patientId = await newPatient('Reassigned');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      // First assignment: just doing the job.
      await request(harness.server)
        .patch(`${API}/encounters/${id}/assignment`)
        .set('Cookie', reception)
        .send({ attendingDoctorId: doctorUser.id })
        .expect(200);

      const other = await harness.addUser(fx, {
        name: 'Dr Second',
        roles: [{ branchId: branch, role: Role.DOCTOR }],
      });
      // Changing it: somebody was expecting this patient.
      const refused = await request(harness.server)
        .patch(`${API}/encounters/${id}/assignment`)
        .set('Cookie', reception)
        .send({ attendingDoctorId: other.id })
        .expect(400);
      expect(refused.body.code).toBe('reason_required');

      await request(harness.server)
        .patch(`${API}/encounters/${id}/assignment`)
        .set('Cookie', reception)
        .send({ attendingDoctorId: other.id, reason: 'Dr Farid called away' })
        .expect(200);
    });

    it('a doctor board shows their own patients and the unassigned', async () => {
      const mine = await request(harness.server)
        .get(`${API}/branches/${branch}/queues/doctor`)
        .set('Cookie', doctor)
        .query({ mine: 'true' })
        .expect(200);
      for (const row of mine.body.items) {
        expect([doctorUser.id, null]).toContain(row.attendingDoctorId);
      }
    });

    it('creates a room and stops assigning it once retired', async () => {
      const room = await request(harness.server)
        .post(`${API}/branches/${branch}/rooms`)
        .set('Cookie', admin)
        .send({ name: 'Consultation 1', code: 'C1' })
        .expect(201);
      const roomId = room.body.items[0].id;

      const patientId = await newPatient('Roomed');
      const created = await checkIn({ patientId, roomId }).expect(201);
      expect(created.body.encounter.roomId).toBe(roomId);

      await request(harness.server)
        .post(`${API}/rooms/${roomId}/retire`)
        .set('Cookie', admin)
        .expect(200);

      const other = await newPatient('No Room');
      const refused = await checkIn({ patientId: other, roomId }).expect(400);
      expect(refused.body.code).toBe('room_inactive');
    });
  });

  describe('The timeline is exact (ENC-R-02)', () => {
    it('writes one event per thing that happened, and no more', async () => {
      const patientId = await newPatient('Exact Timeline');
      const created = await checkIn({ patientId }).expect(201);
      const id = created.body.encounter.id;

      const events = async () =>
        (
          await request(harness.server)
            .get(`${API}/encounters/${id}/events`)
            .set('Cookie', reception)
            .expect(200)
        ).body.items as Array<{
          action: string;
          fromStatus: string;
          toStatus: string;
        }>;

      // Arrived, joined the queue.
      expect(await events()).toHaveLength(2);

      // Called: one event, not two. The call and the move it causes are one
      // thing that happened, and the timeline is read by a person.
      //
      // Asserted against whoever call-next actually took, not against our
      // own patient: the head of the queue depends on what else the suite
      // has left waiting, and the invariant is about the encounter that was
      // called either way.
      const called = await request(harness.server)
        .post(`${API}/branches/${branch}/queues/triage/call-next`)
        .set('Cookie', nurse)
        .expect(200);
      const calledId = called.body.encounter.id as string;

      const calledEvents = (
        await request(harness.server)
          .get(`${API}/encounters/${calledId}/events`)
          .set('Cookie', reception)
          .expect(200)
      ).body.items as Array<{
        action: string;
        fromStatus: string;
        toStatus: string;
      }>;

      const calls = calledEvents.filter((event) => event.action === 'call');
      // One event per call, however many times this patient has been called.
      expect(calls, 'one call event per call, not a pair').toHaveLength(
        called.body.encounter.callCount,
      );
      const last = calls.at(-1)!;
      expect(last.fromStatus).toBe('TRIAGE_WAITING');
      expect(last.toStatus).toBe('TRIAGE_IN_PROGRESS');

      // An ordinary move on our own patient: exactly one more event.
      const beforeMove = (await events()).length;
      await move(id, 'TRIAGE_IN_PROGRESS', nurse).expect(200);
      expect(await events()).toHaveLength(beforeMove + 1);
    });
  });

  // ------------------------------------------- the guard tenancy was owed

  describe('Branch deactivation (TEN-F-07, closing TEN-OPEN-01)', () => {
    it('a branch with somebody in the queue cannot be closed', async () => {
      const patientId = await newPatient('Still Waiting');
      const created = await checkIn({ patientId }).expect(201);

      const refused = await request(harness.server)
        .post(`${API}/branches/${branch}/deactivate`)
        .set('Cookie', admin)
        .send({ reason: 'Closing early' })
        .expect(422);

      expect(refused.body.code).toBe('branch_in_use');
      expect(refused.body.detail).toMatch(/patient(s)? still in the queue/);

      // Once they are off the board, the branch can close.
      await request(harness.server)
        .post(`${API}/encounters/${created.body.encounter.id}/cancel`)
        .set('Cookie', reception)
        .send({ reason: 'Clinic closing' })
        .expect(200);
    });
  });

  // -------------------------------------------------- the waiting room

  describe('The waiting-room screen (ENC-F-20, ENC-R-10)', () => {
    let token: string;

    it('issues a token once, and never again', async () => {
      const issued = await request(harness.server)
        .post(`${API}/branches/${branch}/display-tokens`)
        .set('Cookie', admin)
        .send({ label: 'Waiting room television' })
        .expect(201);

      token = issued.body.token;
      expect(token.length).toBeGreaterThan(30);
      expect(issued.body.url).toContain(token);

      const listed = await request(harness.server)
        .get(`${API}/branches/${branch}/display-tokens`)
        .set('Cookie', admin)
        .expect(200);
      // The token itself is not recoverable: only its hash was kept.
      expect(JSON.stringify(listed.body)).not.toContain(token);
    });

    it('ENC-T-07: shows queue numbers and nothing that identifies anybody', async () => {
      const view = await request(harness.server)
        .get(`${API}/display/${token}`)
        .expect(200);

      expect(view.body.branch.name).toBeTruthy();
      expect(Array.isArray(view.body.waiting)).toBe(true);

      const asText = JSON.stringify(view.body);
      // No full names, no identity numbers, no patient ids.
      expect(asText).not.toContain('Queue Patient');
      expect(asText).not.toMatch(/\d{12}/);
      expect(asText).not.toContain('patientId');
      for (const row of view.body.waiting) {
        expect(row.queueNo).toMatch(/^[A-Z]-\d{3}$/);
        if (row.label) expect(row.label).toMatch(/^\S+( \S\.)?$/);
      }
    });

    it('needs no sign-in, and refuses a token that is not one', async () => {
      await request(harness.server).get(`${API}/display/${token}`).expect(200);
      await request(harness.server)
        .get(`${API}/display/not-a-real-token`)
        .expect(404);
    });

    it('stops working the moment it is revoked', async () => {
      const issued = await request(harness.server)
        .post(`${API}/branches/${branch}/display-tokens`)
        .set('Cookie', admin)
        .send({ label: 'Screen to be replaced' })
        .expect(201);

      await request(harness.server)
        .get(`${API}/display/${issued.body.token}`)
        .expect(200);
      await request(harness.server)
        .delete(`${API}/display-tokens/${issued.body.id}`)
        .set('Cookie', admin)
        .expect(200);
      await request(harness.server)
        .get(`${API}/display/${issued.body.token}`)
        .expect(404);
    });

    it('shows only the numbers when the clinic prefers that', async () => {
      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { displayShowFirstName: false } } })
        .expect(200);

      const view = await request(harness.server)
        .get(`${API}/display/${token}`)
        .expect(200);
      for (const row of [...view.body.waiting, ...view.body.nowServing]) {
        expect(row.label).toBeNull();
      }

      await request(harness.server)
        .patch(`${API}/branches/${branch}/settings`)
        .set('Cookie', admin)
        .send({ settings: { queue: { displayShowFirstName: null } } })
        .expect(200);
    });
  });
});
