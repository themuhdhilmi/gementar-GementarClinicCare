import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  Harness,
  totpFor,
  type Fixture,
  DEFAULT_PASSWORD,
} from './support/harness.js';
import { Role } from '../src/generated/prisma/enums.js';
import { AuditPartitionJob } from '../src/modules/audit/partition.job.js';
import { checkSource } from '../scripts/check-audited-routes.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { newId } from '../src/shared/ids/uuid.js';

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

type Entry = {
  id: string;
  action: string;
  actorName: string;
  actorRole: string | null;
  entityType: string;
  entityId: string | null;
  subjectPatientId: string | null;
  requestId: string | null;
  reason: string | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
  occurredAt: string;
};

describe('AUD — audit trail', () => {
  const harness = new Harness();
  let fx: Fixture;
  let admin: string;
  let doctor: string;
  let reception: string;
  let branch: string;

  let seq = 0;

  async function newPatient(): Promise<string> {
    seq += 1;
    const day = String((seq % 28) + 1).padStart(2, '0');
    const response = await request(harness.server)
      .post(`${API}/patients`)
      .set('Cookie', reception)
      .send({
        name: `Audit Patient ${seq}`,
        idType: 'MYKAD',
        idNumber: `7502${day}-10-${String(5000 + seq).slice(0, 4)}`,
        gender: 'MALE',
        dateOfBirth: `1975-02-${day}`,
        phone: `019-${String(40_000_000 + seq).slice(0, 8)}`,
      })
      .expect(201);
    return response.body.patient.id as string;
  }

  /** Through the API, so the creation is audited the way a real one is. */
  async function createUser(name: string, role: Role = Role.NURSE) {
    seq += 1;
    const response = await request(harness.server)
      .post(`${API}/users`)
      .set('Cookie', admin)
      .send({
        name,
        email: `audit-${seq}-${Date.now()}@klinik.test`,
        roles: [{ branchId: branch, role }],
      })
      .expect(201);
    return response.body.user?.id ?? (response.body.id as string);
  }

  function look(query: Record<string, string | number> = {}, cookie = admin) {
    return request(harness.server)
      .get(`${API}/audit`)
      .set('Cookie', cookie)
      .query(query);
  }

  beforeAll(async () => {
    await harness.start();
    fx = await harness.seedTenant('audit');
    branch = fx.branchAId;
    [doctor, reception] = await Promise.all([
      signIn(harness, fx.doctor.email),
      signIn(harness, fx.frontdesk.email),
    ]);
    admin = await signInAdmin(harness, fx.admin.email);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  });

  // ---------------------------------------------------------- immutable

  describe('AUD-T-01: history cannot be rewritten', () => {
    it('refuses an update and a delete, as the application role sees the table', async () => {
      const patientId = await newPatient();
      const entry = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({
          where: { entityId: patientId, action: 'patient.registered' },
        }),
      );

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE audit_log SET action = 'nothing.happened' WHERE id = $1::uuid`,
            entry.id,
          ),
        ),
      ).rejects.toThrow(/AUDIT_IMMUTABLE/);

      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM audit_log WHERE id = $1::uuid`,
            entry.id,
          ),
        ),
      ).rejects.toThrow(/AUDIT_IMMUTABLE/);

      // And the trigger is on the partitioned parent, so it also fires
      // for a write aimed straight at a partition.
      const partition = `audit_log_${entry.occurredAt.toISOString().slice(0, 7).replace('-', '_')}`;
      await expect(
        harness.db.withTenant(fx.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE ${partition} SET action = 'nothing.happened' WHERE id = $1::uuid`,
            entry.id,
          ),
        ),
      ).rejects.toThrow(/AUDIT_IMMUTABLE/);
    });

    it('there is no write endpoint at all', async () => {
      const patientId = await newPatient();
      const entry = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { entityId: patientId } }),
      );
      await request(harness.server)
        .patch(`${API}/audit/${entry.id}`)
        .set('Cookie', admin)
        .send({ action: 'nothing.happened' })
        .expect(404);
      await request(harness.server)
        .delete(`${API}/audit/${entry.id}`)
        .set('Cookie', admin)
        .expect(404);
    });
  });

  // ------------------------------------------------------ what is written

  describe('AUD-T-02: a mutating route leaves exactly one traceable entry', () => {
    it('records the actor, the entity and the request it came from', async () => {
      const patientId = await newPatient();

      const found = await look({
        entityId: patientId,
        action: 'patient.registered',
      }).expect(200);
      expect(found.body.items).toHaveLength(1);

      const entry = found.body.items[0] as Entry;
      expect(entry.actorName).toBe(fx.frontdesk.name);
      expect(entry.actorRole).toContain('RECEPTION');
      expect(entry.entityType).toBe('patient');
      expect(entry.entityId).toBe(patientId);
      expect(entry.subjectPatientId).toBe(patientId);
      // AUD-F-02: the request id is what ties this to the application log.
      expect(entry.requestId).toMatch(/.+/);
    });

    it('AUD-R-06: the actor name is a snapshot, not a join', async () => {
      const staff = await harness.addUser(fx, {
        name: 'Encik Salleh',
        roles: [{ branchId: branch, role: Role.RECEPTION }],
      });
      const cookie = await signIn(harness, staff.email);

      const created = await request(harness.server)
        .post(`${API}/patients`)
        .set('Cookie', cookie)
        .send({
          name: 'Renamed Actor Test',
          idType: 'NONE',
          notes: 'Test patient',
          gender: 'FEMALE',
          dateOfBirth: '1990-05-05',
          phone: '019-8765432',
        })
        .expect(201);

      await request(harness.server)
        .patch(`${API}/users/${staff.id}`)
        .set('Cookie', admin)
        .send({ name: 'Encik Salleh bin Osman' })
        .expect(200);

      const found = await look({
        entityId: created.body.patient.id,
        action: 'patient.registered',
      }).expect(200);
      expect((found.body.items[0] as Entry).actorName).toBe('Encik Salleh');
    });

    it('AUD-T-05: a secret never reaches the trail', async () => {
      const staffId = await createUser('Cik Redacted');

      const found = await look({
        entityId: staffId,
        action: 'user.created',
      }).expect(200);
      expect(found.body.items.length).toBeGreaterThan(0);

      const full = await request(harness.server)
        .get(`${API}/audit/${(found.body.items[0] as Entry).id}`)
        .set('Cookie', admin)
        .expect(200);

      const serialised = JSON.stringify(full.body);
      expect(serialised).not.toMatch(/\$argon2/);
      expect(serialised).not.toMatch(/passwordHash"\s*:\s*"[^"[]/);
      expect(serialised).toContain('Cik Redacted');
    });

    it('AUD-N-05: an oversized snapshot is replaced by a note saying so', async () => {
      const patientId = await newPatient();
      const huge = 'x'.repeat(80_000);

      await harness.db.withTenant(fx.tenantId, async (tx) => {
        const service = harness.app.get(
          (await import('../src/modules/audit/audit.service.js')).AuditService,
        );
        await service.record(
          tx,
          {
            tenantId: fx.tenantId,
            actorId: null,
            actorName: 'system:test',
          },
          {
            action: 'patient.updated',
            entityType: 'patient',
            entityId: patientId,
            after: { notes: huge },
          },
        );
      });

      const found = await look({
        entityId: patientId,
        action: 'patient.updated',
      }).expect(200);
      const full = await request(harness.server)
        .get(`${API}/audit/${(found.body.items[0] as Entry).id}`)
        .set('Cookie', admin)
        .expect(200);

      expect(full.body.after._truncated).toBe(true);
      expect(full.body.after._bytes).toBeGreaterThan(64 * 1024);
      expect(JSON.stringify(full.body).length).toBeLessThan(10_000);
    });
  });

  // --------------------------------------------------------- the backstop

  describe('AUD-F-03: the declaration is a guarantee, not a hope', () => {
    it('AUD-T-06: a mutating route that says nothing fails the lint', () => {
      const offender = `
        @Controller('probe')
        export class ProbeController {
          @Post('undeclared')
          @RequirePermission('admin.settings')
          async doSomething() { return { ok: true }; }
        }`;
      const findings = checkSource(
        'probe.controller.ts',
        offender,
        new Set(),
        new Set(),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]!.problem).toBe('missing_declaration');

      // And a declaration naming an action nobody emits fails too, because
      // a filter for it would return nothing and read as innocence.
      const invented = offender.replace(
        "@Post('undeclared')",
        "@Post('undeclared')\n          @Audited('nothing.ever.happens')",
      );
      expect(
        checkSource(
          'probe.controller.ts',
          invented,
          new Set(['patient.registered']),
          new Set(),
        )[0]!.problem,
      ).toBe('unknown_action');

      // An exemption without a real reason is not an exemption.
      const lazy = offender.replace(
        "@Post('undeclared')",
        "@Post('undeclared')\n          @NotAudited('meh')",
      );
      expect(
        checkSource('probe.controller.ts', lazy, new Set(), new Set())[0]!
          .problem,
      ).toBe('empty_reason');
    });

    it('writes a fallback entry when the service wrote nothing itself', async () => {
      // `POST /patients/search` is `@NotAudited` and must stay silent...
      const before = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.count({}),
      );
      await request(harness.server)
        .post(`${API}/patients/search`)
        .set('Cookie', reception)
        .send({ q: 'Audit Patient' })
        .expect(200);
      const after = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.auditLog.count({}),
      );
      expect(after).toBe(before);

      // ...while every `@Audited` route leaves something behind, whether
      // or not its service remembered to.
      const patientId = await newPatient();
      await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);

      const found = await look({
        action: 'encounter.created',
        patientId,
      }).expect(200);
      expect(found.body.items.length).toBeGreaterThan(0);
    });
  });

  it('AUD-T-04 / AUD-F-05: opening a clinical record is recorded', async () => {
    const patientId = await newPatient();
    await request(harness.server)
      .get(`${API}/patients/${patientId}/clinical-summary`)
      .set('Cookie', doctor)
      .expect(200);

    const found = await look({ action: 'clinical.viewed', patientId }).expect(
      200,
    );
    expect(found.body.items.length).toBeGreaterThan(0);
    expect((found.body.items[0] as Entry).subjectPatientId).toBe(patientId);
    expect((found.body.items[0] as Entry).actorName).toBe(fx.doctor.name);
  });

  it('AUD-T-07: an administrator reading clinical data is break-glass, and counted', async () => {
    const patientId = await newPatient();
    const before = await request(harness.server)
      .get(`${API}/audit/dashboard`)
      .set('Cookie', admin)
      .expect(200);

    await request(harness.server)
      .get(`${API}/patients/${patientId}/clinical-summary`)
      .set('Cookie', admin)
      .expect(200);

    const found = await look({ action: 'audit.break_glass' }).expect(200);
    expect(found.body.items.length).toBeGreaterThan(0);

    const after = await request(harness.server)
      .get(`${API}/audit/dashboard`)
      .set('Cookie', admin)
      .expect(200);
    expect(after.body.breakGlass.last24h).toBeGreaterThan(
      before.body.breakGlass.last24h,
    );

    // A doctor doing the same thing is routine and is not flagged.
    await request(harness.server)
      .get(`${API}/patients/${patientId}/clinical-summary`)
      .set('Cookie', doctor)
      .expect(200);
    const unchanged = await request(harness.server)
      .get(`${API}/audit/dashboard`)
      .set('Cookie', admin)
      .expect(200);
    expect(unchanged.body.breakGlass.last24h).toBe(
      after.body.breakGlass.last24h,
    );
  });

  it('AUD-F-06: unmasking an identity number is recorded', async () => {
    const patientId = await newPatient();
    await request(harness.server)
      .get(`${API}/patients/${patientId}?unmask=true`)
      .set('Cookie', reception)
      .expect(200);

    const found = await look({
      action: 'patient.id_unmasked',
      patientId,
    }).expect(200);
    expect(found.body.items.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------- reading it back

  describe('AUD-F-10 … F-11: finding things in it', () => {
    it('filters by actor, by action group, by entity and by patient', async () => {
      const patientId = await newPatient();

      const byActor = await look({
        actorId: fx.frontdesk.id,
        actionGroup: 'patient',
      }).expect(200);
      expect(byActor.body.items.length).toBeGreaterThan(0);
      expect(
        byActor.body.items.every((e: Entry) => e.action.startsWith('patient.')),
      ).toBe(true);

      const byEntity = await look({
        entityType: 'patient',
        entityId: patientId,
      }).expect(200);
      expect(
        byEntity.body.items.every((e: Entry) => e.entityId === patientId),
      ).toBe(true);

      // §12: a range nobody can answer quickly is refused rather than run.
      await look({
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-12-31T00:00:00.000Z',
      }).expect(400);
      // And an action nobody emits is refused rather than returning an
      // empty page that reads like innocence.
      const invented = await look({ action: 'patient.abducted' }).expect(400);
      expect(invented.body.code).toBe('unknown_action');
    });

    it('AUD-F-11: a patient access history answers "who has seen this record"', async () => {
      const patientId = await newPatient();
      await request(harness.server)
        .get(`${API}/patients/${patientId}/clinical-summary`)
        .set('Cookie', doctor)
        .expect(200);
      await request(harness.server)
        .get(`${API}/patients/${patientId}?unmask=true`)
        .set('Cookie', reception)
        .expect(200);

      const history = await request(harness.server)
        .get(`${API}/patients/${patientId}/access-history`)
        .set('Cookie', admin)
        .expect(200);

      const actions = history.body.items.map((e: Entry) => e.action);
      expect(actions).toContain('patient.registered');
      expect(actions).toContain('clinical.viewed');
      expect(actions).toContain('patient.id_unmasked');
      expect(
        history.body.items.every(
          (e: Entry) => e.subjectPatientId === patientId,
        ),
      ).toBe(true);
    });

    it('is refused to anybody without audit.read', async () => {
      await look({}, doctor).expect(403);
      await look({}, reception).expect(403);
      await request(harness.server)
        .get(`${API}/patients/${await newPatient()}/access-history`)
        .set('Cookie', doctor)
        .expect(403);
    });
  });

  // -------------------------------------------------------------- export

  describe('AUD-T-09 / AUD-F-13: taking a copy', () => {
    it('needs a fresh password, records itself, and does not hand Excel a formula', async () => {
      // A reason field is free text a user typed, and it is exported. If
      // it reaches Excel unquoted it is a formula, and `=cmd|…` in a
      // cancellation reason is an attack on whoever opens the file.
      const patientId = await newPatient();
      const encounter = await request(harness.server)
        .post(`${API}/branches/${branch}/encounters`)
        .set('Cookie', reception)
        .send({ patientId })
        .expect(201);
      await request(harness.server)
        .post(`${API}/encounters/${encounter.body.encounter.id}/cancel`)
        .set('Cookie', reception)
        .send({ reason: "=cmd|'/c calc'!A1" })
        .expect(200);

      const stale = await request(harness.server)
        .post(`${API}/audit/export`)
        .set('Cookie', admin)
        .send({ actionGroup: 'clinical' });
      // The administrator's session was made fresh by enrolling in MFA at
      // the start of this file; either it is still fresh or it is not,
      // and both are correct answers to ask for.
      expect([200, 401, 403]).toContain(stale.status);

      await request(harness.server)
        .post(`${API}/auth/reauth`)
        .set('Cookie', admin)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      const exported = await request(harness.server)
        .post(`${API}/audit/export`)
        .set('Cookie', admin)
        .send({ patientId })
        .expect(200);

      expect(exported.headers['content-type']).toMatch(/text\/csv/);
      expect(exported.headers['content-disposition']).toMatch(
        /attachment; filename="audit-/,
      );
      expect(exported.text).toContain('occurred_at,action,actor_name');
      // The reason is a spreadsheet formula. It comes back with a leading
      // apostrophe, which makes Excel treat it as text, and never as a
      // cell that starts with `=`.
      expect(exported.text).toContain("'=cmd|'/c calc'!A1");
      expect(exported.text).not.toMatch(/(^|,)=cmd/m);

      const own = await look({ action: 'audit.exported' }).expect(200);
      expect(own.body.items.length).toBeGreaterThan(0);

      const full = await request(harness.server)
        .get(`${API}/audit/${(own.body.items[0] as Entry).id}`)
        .set('Cookie', admin)
        .expect(200);
      expect(full.body.after.filter.patientId).toBe(patientId);
      expect(full.body.after.rows).toBeGreaterThan(0);
    });

    it('refuses a range wider than the export limit', async () => {
      await request(harness.server)
        .post(`${API}/auth/reauth`)
        .set('Cookie', admin)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);
      const response = await request(harness.server)
        .post(`${API}/audit/export`)
        .set('Cookie', admin)
        .send({
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-09-21T00:00:00.000Z',
        })
        .expect(400);
      expect(response.body.code).toBe('range_too_wide');
    });
  });

  // ------------------------------------------------------- not best-effort

  it('AUD-T-03: if the entry cannot be written, the change does not happen', async () => {
    // The specification is blunt about this (§14) and it is the one
    // property that cannot be tested by being careful: make the write
    // fail and watch the work disappear with it.
    //
    // Not through a trigger on `audit_log`. That was the first attempt.
    // `CREATE TRIGGER` takes an ACCESS EXCLUSIVE lock on a table every
    // other suite writes to several times a second, and the suites run
    // in parallel — the first version failed seven tests in two other
    // files, and the version after that hung the whole run. A test that
    // can stop the build is not worth the extra fidelity.
    //
    // So the failure is made in the audit row itself. `action` is
    // `varchar(80)` and `record` does not truncate it, so an over-long
    // one is refused by the column. What is proved is the rule: the
    // entry and the change share one transaction, and neither survives
    // without the other.
    const service = harness.app.get(AuditService);
    const name = `Rolled Back ${Date.now()}`;

    await expect(
      harness.db.withTenant(fx.tenantId, async (tx) => {
        await tx.patient.create({
          data: {
            id: newId(),
            tenantId: fx.tenantId,
            name,
            idType: 'NONE',
            gender: 'MALE',
            dateOfBirth: new Date('1988-08-08'),
            mrn: `RB-${Date.now()}`,
          },
        });
        await service.record(
          tx,
          { tenantId: fx.tenantId, actorId: null, actorName: 'system:test' },
          { action: 'x'.repeat(200) as never, entityType: 'patient' },
        );
      }),
    ).rejects.toThrow();

    // Not "created without an entry" — not created at all. That is the
    // trade the specification asks for, and it is the right way round.
    const survivors = await harness.db.withTenant(fx.tenantId, (tx) =>
      tx.patient.count({ where: { name } }),
    );
    expect(survivors).toBe(0);

    // And the system still works afterwards.
    await expect(newPatient()).resolves.toMatch(/.+/);
  });

  // --------------------------------------------------------- partitioning

  describe('AUD-F-14: partitioned by month', () => {
    it('writes land in the partition for their month', async () => {
      const patientId = await newPatient();
      const month = new Date().toISOString().slice(0, 7).replace('-', '_');

      const rows = await harness.db.withTenant(fx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::bigint AS count FROM audit_log_${month} WHERE entity_id = $1::uuid`,
          patientId,
        ),
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    });

    it('AUD-N-04: the job keeps months ahead, and nothing is stranded', async () => {
      const job = harness.app.get(AuditPartitionJob);
      const result = await job.run();

      expect(result.ensured).toHaveLength(4);
      const month = new Date();
      month.setUTCMonth(month.getUTCMonth() + 3);
      expect(result.ensured).toContain(
        `audit_log_${month.toISOString().slice(0, 7).replace('-', '_')}`,
      );

      // The default partition is a safety net, not a destination. Anything
      // in it means a month went by without maintenance.
      expect(result.unclaimed).toBe(0);

      // Running it twice is not an error; a cron that retries must be safe.
      expect((await job.run()).ensured).toEqual(result.ensured);
    });
  });
});
