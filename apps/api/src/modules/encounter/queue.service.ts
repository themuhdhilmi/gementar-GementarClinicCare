import { Injectable } from '@nestjs/common';
import {
  EncounterPriority,
  EncounterStatus,
  Role,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import { newId } from '../../shared/ids/uuid.js';
import { EncounterService, readable } from './encounter.service.js';
import { QueueStreamService } from './queue-stream.service.js';
import {
  STATION_STATUSES,
  STATION_WAITING,
  callTargetFor,
  stationsFor,
  type Station,
} from './transitions.js';

export type QueueRow = {
  id: string;
  queueNo: string;
  encounterNo: string;
  status: EncounterStatus;
  priority: EncounterPriority;
  priorityReason: string | null;
  patient: { id: string; name: string; age: string | null; gender: string };
  attendingDoctorId: string | null;
  attendingDoctorName: string | null;
  roomName: string | null;
  statusSince: string;
  waitingMinutes: number;
  /** Amber and red come from the branch's own thresholds (ENC-F-22). */
  waitTone: 'normal' | 'amber' | 'red';
  callCount: number;
  skipCount: number;
  calledAt: string | null;
  /**
   * Whether "call next" could reach this row.
   *
   * False for the patient already in the chair. The board shows them,
   * because the station is dealing with them, but they are not in the
   * line — and a screen that cannot tell the difference labels its call
   * button with the wrong person's number.
   */
  callable: boolean;
};

type Row = {
  id: string;
  queue_no: string;
  encounter_no: string;
  status: EncounterStatus;
  priority: EncounterPriority;
  priority_reason: string | null;
  patient_id: string;
  patient_name: string;
  date_of_birth: Date | null;
  gender: string;
  attending_doctor_id: string | null;
  doctor_name: string | null;
  room_name: string | null;
  status_since: Date;
  call_count: number;
  skip_count: number;
  called_at: Date | null;
};

/**
 * The boards, and the buttons on them.
 *
 * Every station sees the same encounters through a different filter
 * (ENC-F-15), ordered the same way: priority first, then how long they have
 * been waiting at *this* station (ENC-F-16, ENC-R-07). There is no manual
 * reordering, deliberately — a queue somebody can drag is a queue nobody can
 * explain to the patient who was moved down it.
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly settings: SettingsService,
    private readonly encounters: EncounterService,
    private readonly stream: QueueStreamService,
  ) {}

  async board(
    branchId: string,
    station: Station,
    options: { doctorId?: string | null } = {},
  ): Promise<QueueRow[]> {
    const statuses = STATION_STATUSES[station];
    if (!statuses) throw new NotFoundError('Queue');

    const tx = this.db.tx();
    const { waitAmberMinutes, waitRedMinutes } = await this.settings.group(
      branchId,
      'queue',
    );

    // One query with the patient and the doctor joined. A board refreshes
    // on every event in the clinic, so a row-per-query shape here would be
    // the busiest thing in the system by a wide margin.
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `
      SELECT e.id, e.queue_no, e.encounter_no, e.status, e.priority, e.priority_reason,
             e.attending_doctor_id, e.status_since, e.call_count, e.skip_count, e.called_at,
             p.id AS patient_id, p.name AS patient_name, p.date_of_birth, p.gender::text AS gender,
             d.name AS doctor_name, r.name AS room_name
        FROM encounter e
        JOIN patient p ON p.id = e.patient_id AND p.tenant_id = e.tenant_id
        LEFT JOIN "user" d ON d.id = e.attending_doctor_id AND d.tenant_id = e.tenant_id
        LEFT JOIN branch_room r ON r.id = e.room_id AND r.tenant_id = e.tenant_id
       WHERE e.tenant_id = $1::uuid
         AND e.branch_id = $2::uuid
         AND e.status = ANY($3::text[]::"EncounterStatus"[])
         AND ($4::uuid IS NULL OR e.attending_doctor_id = $4::uuid OR e.attending_doctor_id IS NULL)
       ORDER BY
         -- Emergency first, then urgent, then how long they have waited here.
         CASE e.priority WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END,
         e.status_since ASC
       LIMIT 200
      `,
      requireTenantId(),
      branchId,
      statuses as unknown as string[],
      options.doctorId ?? null,
    );

    const now = this.clock.now();
    const callable = new Set<EncounterStatus>(STATION_WAITING[station]);
    return rows.map((row) => {
      const waitingMinutes = Math.floor(
        (now.getTime() - row.status_since.getTime()) / 60_000,
      );
      return {
        id: row.id,
        queueNo: row.queue_no,
        encounterNo: row.encounter_no,
        status: row.status,
        priority: row.priority,
        priorityReason: row.priority_reason,
        patient: {
          id: row.patient_id,
          name: row.patient_name,
          age: describeAgeShort(row.date_of_birth, now),
          gender: row.gender,
        },
        attendingDoctorId: row.attending_doctor_id,
        attendingDoctorName: row.doctor_name,
        roomName: row.room_name,
        statusSince: row.status_since.toISOString(),
        waitingMinutes,
        waitTone:
          waitingMinutes >= waitRedMinutes
            ? 'red'
            : waitingMinutes >= waitAmberMinutes
              ? 'amber'
              : 'normal',
        callCount: row.call_count,
        skipCount: row.skip_count,
        calledAt: row.called_at ? row.called_at.toISOString() : null,
        callable: callable.has(row.status),
      };
    });
  }

  /**
   * ENC-F-17: take the patient at the head of this queue.
   *
   * The head row is locked before it is read, so two people pressing the
   * button at the same moment get different patients rather than the same
   * one (§14). That is the only correct way to do this and it is one line
   * of SQL, so there is no excuse for the version that reads then writes.
   */
  async callNext(
    ctx: TenantContext,
    branchId: string,
    station: Station,
    options: { doctorId?: string | null } = {},
  ) {
    if (station === 'reception') {
      throw new BadRequestError(
        'There is no queue to call from at reception: it shows every patient rather than a line.',
        'station_has_no_queue',
      );
    }

    const tx = this.db.tx();
    // The waiting list, not the board: the patient already in the chair
    // must not be picked up again by the button that calls the next one.
    const statuses = STATION_WAITING[station];

    const [head] = await tx.$queryRawUnsafe<
      Array<{ id: string; status: EncounterStatus }>
    >(
      `
      SELECT e.id, e.status
        FROM encounter e
       WHERE e.tenant_id = $1::uuid
         AND e.branch_id = $2::uuid
         AND e.status = ANY($3::text[]::"EncounterStatus"[])
         AND ($4::uuid IS NULL OR e.attending_doctor_id = $4::uuid OR e.attending_doctor_id IS NULL)
       ORDER BY
         CASE e.priority WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END,
         e.status_since ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
      `,
      requireTenantId(),
      branchId,
      statuses as unknown as string[],
      options.doctorId ?? null,
    );

    if (!head) {
      throw new NotFoundError('Nobody is waiting at this station');
    }

    // A combined counter serves two lines at once, and they do not move
    // the same way — so where this call takes them depends on which
    // line they were in, not only on which station called.
    const target = callTargetFor(station, head.status);
    if (!target) return this.callAgain(ctx, head.id);

    return this.call(ctx, head.id, target);
  }

  /** ENC-F-18: call a named patient again, without moving them on. */
  async callAgain(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const encounter = await this.encounters.getOrThrow(tx, encounterId);
    const now = this.clock.now();

    await tx.encounter.update({
      where: { id: encounterId },
      data: { calledAt: now, callCount: { increment: 1 } },
    });
    await this.recordCall(
      tx,
      ctx,
      encounter.id,
      encounter.status,
      'call',
      null,
    );

    const after = await this.encounters.getOrThrow(tx, encounterId);
    this.announce(
      encounter.branchId,
      'call',
      encounter.id,
      encounter.queueNo,
      now,
    );

    const { noShowAfterCalls } = await this.settings.group(
      encounter.branchId,
      'queue',
    );
    return {
      encounter: this.encounters.present(after),
      // The screen asks about a no-show rather than deciding one: the
      // patient may be in the toilet, and the system cannot know.
      suggestNoShow: after.callCount >= noShowAfterCalls,
    };
  }

  private async call(
    ctx: TenantContext,
    encounterId: string,
    to: EncounterStatus,
  ) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const before = await this.encounters.getOrThrow(tx, encounterId);

    await tx.encounter.update({
      where: { id: encounterId },
      data: { calledAt: now, callCount: { increment: 1 } },
    });

    // ENC-R-02: exactly one event. `transition` writes it, tagged as a
    // call, because the call and the move it causes are one thing that
    // happened. Writing a second here made every call appear twice on a
    // timeline that a person reads.
    const moved = await this.encounters.transition(ctx, encounterId, to, {
      action: 'call',
    });

    this.announce(before.branchId, 'call', encounterId, before.queueNo, now);
    return { encounter: moved, calledQueueNo: before.queueNo };
  }

  /**
   * ENC-F-18: the patient is not there. Back of the queue, marked.
   *
   * Implemented by moving `status_since` to now, which is what "back of the
   * queue" means when the order is by how long you have been waiting. No
   * separate position column exists, so there is nothing to get out of step.
   */
  async skip(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const encounter = await this.encounters.getOrThrow(tx, encounterId);

    await tx.encounter.update({
      where: { id: encounterId },
      data: { statusSince: now, skipCount: { increment: 1 }, calledAt: null },
    });
    await this.recordCall(
      tx,
      ctx,
      encounterId,
      encounter.status,
      'skip',
      'Not present when called',
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.EncounterSkipped,
      entityType: 'encounter',
      entityId: encounterId,
      subjectPatientId: encounter.patientId,
      after: { skipCount: encounter.skipCount + 1 },
    });
    this.events.publish({
      name: DomainEvent.EncounterSkipped,
      tenantId: ctx.tenantId,
      branchId: encounter.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { encounterId, queueNo: encounter.queueNo },
    });
    this.announce(
      encounter.branchId,
      'skip',
      encounterId,
      encounter.queueNo,
      now,
    );

    const after = await this.encounters.getOrThrow(tx, encounterId);
    const { noShowAfterCalls } = await this.settings.group(
      encounter.branchId,
      'queue',
    );
    return {
      encounter: this.encounters.present(after),
      suggestNoShow:
        after.skipCount >= 2 || after.callCount >= noShowAfterCalls,
    };
  }

  /** ENC-F-08: move somebody up the queue, and say why. */
  async setPriority(
    ctx: TenantContext,
    encounterId: string,
    priority: EncounterPriority,
    reason?: string,
  ) {
    const tx = this.db.tx();
    const before = await this.encounters.getOrThrow(tx, encounterId);
    if (priority !== EncounterPriority.NORMAL && !(reason ?? '').trim()) {
      throw new BadRequestError(
        'Say why. Everyone moved down the queue is entitled to a reason having been recorded.',
        'priority_reason_required',
      );
    }

    await tx.encounter.update({
      where: { id: encounterId },
      data: { priority, priorityReason: reason?.trim() || null },
    });
    await this.recordCall(
      tx,
      ctx,
      encounterId,
      before.status,
      'priority',
      reason ?? null,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.EncounterPriorityChanged,
      entityType: 'encounter',
      entityId: encounterId,
      subjectPatientId: before.patientId,
      before: { priority: before.priority },
      after: { priority },
      reason: reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.EncounterPriorityChanged,
      tenantId: ctx.tenantId,
      branchId: before.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { encounterId, from: before.priority, to: priority },
    });
    this.announce(
      before.branchId,
      'priority',
      encounterId,
      before.queueNo,
      this.clock.now(),
    );

    return this.encounters.present(
      await this.encounters.getOrThrow(tx, encounterId),
    );
  }

  /** ENC-F-06, ENC-F-07: who is seeing them, and where. */
  async assign(
    ctx: TenantContext,
    encounterId: string,
    input: {
      attendingDoctorId?: string | null;
      roomId?: string | null;
      reason?: string;
    },
  ) {
    const tx = this.db.tx();
    const before = await this.encounters.getOrThrow(tx, encounterId);

    if (input.attendingDoctorId) {
      const role = await tx.userBranchRole.findFirst({
        where: {
          userId: input.attendingDoctorId,
          branchId: before.branchId,
          role: Role.DOCTOR,
        },
        select: { id: true },
      });
      if (!role) {
        throw new BadRequestError(
          'That person is not a doctor at this branch.',
          'not_a_doctor_here',
        );
      }
    }
    if (input.roomId) {
      const room = await tx.branchRoom.findFirst({
        where: { id: input.roomId, branchId: before.branchId, active: true },
        select: { id: true },
      });
      if (!room) throw new NotFoundError('Room');
    }

    // Reassigning somebody who already had a doctor is a decision worth a
    // reason; assigning one for the first time is just doing the job.
    const reassigning =
      input.attendingDoctorId !== undefined &&
      before.attendingDoctorId !== null &&
      input.attendingDoctorId !== before.attendingDoctorId;
    if (reassigning && !(input.reason ?? '').trim()) {
      throw new BadRequestError(
        'Changing the doctor needs a reason, because somebody was expecting this patient.',
        'reason_required',
      );
    }

    await tx.encounter.update({
      where: { id: encounterId },
      data: {
        ...(input.attendingDoctorId === undefined
          ? {}
          : { attendingDoctorId: input.attendingDoctorId }),
        ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
      },
    });
    await this.recordCall(
      tx,
      ctx,
      encounterId,
      before.status,
      'reassign',
      input.reason ?? null,
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.EncounterReassigned,
      entityType: 'encounter',
      entityId: encounterId,
      subjectPatientId: before.patientId,
      before: { doctor: before.attendingDoctorId, room: before.roomId },
      after: {
        doctor: input.attendingDoctorId ?? before.attendingDoctorId,
        room: input.roomId ?? before.roomId,
      },
      reason: input.reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.EncounterReassigned,
      tenantId: ctx.tenantId,
      branchId: before.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { encounterId },
    });
    this.announce(
      before.branchId,
      'assignment',
      encounterId,
      before.queueNo,
      this.clock.now(),
    );

    return this.encounters.present(
      await this.encounters.getOrThrow(tx, encounterId),
    );
  }

  /** ENC-F-21: the three numbers a board shows above itself. */
  async stats(branchId: string) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { timezone: true },
    });
    const timezone = branch?.timezone ?? 'Asia/Kuala_Lumpur';

    const [row] = await tx.$queryRawUnsafe<
      Array<{
        waiting: number | string;
        longest_minutes: number | string | null;
        seen_today: number | string;
        average_wait: number | string | null;
        no_shows: number | string;
      }>
    >(
      `
      SELECT
        count(*) FILTER (WHERE e.status NOT IN ('COMPLETED','CANCELLED','NO_SHOW')) AS waiting,
        max(EXTRACT(EPOCH FROM (now() - e.status_since)) / 60)
          FILTER (WHERE e.status NOT IN ('COMPLETED','CANCELLED','NO_SHOW')) AS longest_minutes,
        count(*) FILTER (WHERE e.status = 'COMPLETED') AS seen_today,
        avg(EXTRACT(EPOCH FROM (e.completed_at - e.registered_at)) / 60)
          FILTER (WHERE e.completed_at IS NOT NULL) AS average_wait,
        count(*) FILTER (WHERE e.status = 'NO_SHOW') AS no_shows
      FROM encounter e
      WHERE e.tenant_id = $1::uuid
        AND e.branch_id = $2::uuid
        -- The clinic's day, not the server's. A clinic open until 10pm in
        -- Kuala Lumpur would otherwise see its counts reset during the
        -- evening if this ever runs anywhere but Malaysia.
        AND e.registered_at >= date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $3
      `,
      requireTenantId(),
      branchId,
      timezone,
    );

    return {
      waiting: Number(row?.waiting ?? 0),
      longestWaitMinutes: Math.round(Number(row?.longest_minutes ?? 0)),
      seenToday: Number(row?.seen_today ?? 0),
      averageVisitMinutes: Math.round(Number(row?.average_wait ?? 0)),
      noShows: Number(row?.no_shows ?? 0),
      at: now.toISOString(),
      stations: await this.boardShape(branchId),
    };
  }

  /**
   * Which tabs this branch's board should have (ENC-F-15).
   *
   * Decided here rather than in the browser, because it follows from the
   * clinic's settings and the browser would otherwise need to read
   * settings it has no permission for. A dispenser can see the board;
   * they cannot see `admin.settings`.
   *
   * Two clinics, two shapes. A clinic with no triage should not have a
   * triage tab that is always empty, and a clinic where one person hands
   * over the medicine and takes the money should have **one** queue
   * rather than two halves of the same person's work.
   */
  async boardShape(branchId: string): Promise<Station[]> {
    const { triageRequired, combinedCounter, proceduresEnabled } =
      await this.settings.group(branchId, 'queue');
    return stationsFor({
      triageRequired,
      combinedCounter,
      proceduresEnabled,
    });
  }

  /**
   * Where this visit is in the journey, for the strip at the top of the
   * chart (ENC-F-11).
   *
   * Computed here rather than in the browser for three reasons, and the
   * third is the one that matters:
   *
   * - the **shape** follows from settings the browser may not read;
   * - **what has happened** is the event log, which the browser has but
   *   would have to interpret;
   * - and **what applies to this visit** is neither. A procedure step
   *   is real only if one was ordered; a pharmacy step only if
   *   something was prescribed. A strip that always shows every step
   *   teaches people to ignore it, and one that hides a step the
   *   patient is standing in is worse.
   */
  async flow(tx: Tx, encounter: { id: string; branchId: string; status: EncounterStatus }) {
    const S = EncounterStatus;
    const { triageRequired, combinedCounter } = await this.settings.group(
      encounter.branchId,
      'queue',
    );

    const events = await tx.encounterEvent.findMany({
      where: { encounterId: encounter.id },
      select: { toStatus: true },
    });
    const visited = new Set<string>(events.map((event) => event.toStatus));
    visited.add(encounter.status);

    const been = (...statuses: EncounterStatus[]) => statuses.some((s) => visited.has(s));
    const here = (...statuses: EncounterStatus[]) => statuses.includes(encounter.status);

    type Step = {
      key: string;
      label: string;
      state: 'done' | 'current' | 'upcoming' | 'skipped';
    };
    const steps: Step[] = [];

    const add = (key: string, label: string, statuses: EncounterStatus[], show = true) => {
      if (!show) {
        steps.push({ key, label, state: 'skipped' });
        return;
      }
      steps.push({
        key,
        label,
        state: here(...statuses) ? 'current' : been(...statuses) ? 'done' : 'upcoming',
      });
    };

    add('checkin', 'Checked in', [S.REGISTERED]);
    add(
      'triage',
      'Triage',
      [S.TRIAGE_WAITING, S.TRIAGE_IN_PROGRESS],
      // Off for the clinic, or this particular visit went round it.
      triageRequired !== 'NEVER',
    );
    add('doctor', 'Doctor', [S.DOCTOR_WAITING, S.IN_CONSULTATION]);

    // Only real once one has been ordered. Before that it is noise.
    if (been(S.PROCEDURE_WAITING, S.PROCEDURE_DONE)) {
      add('procedure', 'Procedure', [S.PROCEDURE_WAITING, S.PROCEDURE_DONE]);
    }

    if (combinedCounter) {
      add('counter', 'Counter', [S.PHARMACY_WAITING, S.DISPENSING, S.PAYMENT_WAITING]);
    } else {
      add('pharmacy', 'Pharmacy', [S.PHARMACY_WAITING, S.DISPENSING]);
      add('payment', 'Pay', [S.PAYMENT_WAITING]);
    }

    // How it ended, or how it is going to.
    if (encounter.status === S.CANCELLED) {
      steps.push({ key: 'end', label: 'Cancelled', state: 'current' });
    } else if (encounter.status === S.NO_SHOW) {
      steps.push({ key: 'end', label: 'Did not attend', state: 'current' });
    } else {
      add('done', 'Done', [S.COMPLETED]);
    }

    return steps;
  }

  /** ENC-F-11: the timeline, which is the answer to "what happened here". */
  async timeline(tx: Tx, encounterId: string) {
    return tx.encounterEvent.findMany({
      where: { encounterId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  private async recordCall(
    tx: Tx,
    ctx: TenantContext,
    encounterId: string,
    status: EncounterStatus,
    action: string,
    note: string | null,
  ) {
    await tx.encounterEvent.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        encounterId,
        fromStatus: status,
        toStatus: status,
        action,
        actorId: ctx.userId,
        actorName: ctx.userName,
        note,
        occurredAt: this.clock.now(),
      },
    });
  }

  private announce(
    branchId: string,
    kind: 'call' | 'skip' | 'priority' | 'assignment',
    encounterId: string,
    queueNo: string,
    at: Date,
  ) {
    this.stream.publish({
      branchId,
      kind,
      encounterId,
      queueNo,
      at: at.toISOString(),
    });
  }
}

/** Compact enough for a queue row: "34 y", "6 mo", "4 d". */
function describeAgeShort(dateOfBirth: Date | null, now: Date): string | null {
  if (!dateOfBirth) return null;
  const days = Math.floor((now.getTime() - dateOfBirth.getTime()) / 86_400_000);
  if (days < 31) return `${days} d`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} mo`;
  return `${Math.floor(days / 365.2425)} y`;
}

export { readable };
