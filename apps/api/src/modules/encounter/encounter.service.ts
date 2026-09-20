import { Injectable, Logger } from '@nestjs/common';
import {
  EncounterPriority,
  EncounterStatus,
  EncounterType,
  Role,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  InvariantViolationError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { SettingsService } from '../tenancy/settings/settings.service.js';
import { BranchService } from '../tenancy/branch.service.js';
import { QueueNumberService } from './queue-number.service.js';
import { QueueStreamService } from './queue-stream.service.js';
import {
  allowedFrom,
  isAllowed,
  OPEN_STATUSES,
  ruleFor,
  stationOf,
  TERMINAL_STATUSES,
  type Station,
} from './transitions.js';

export type CheckInInput = {
  patientId: string;
  type?: EncounterType;
  priority?: EncounterPriority;
  priorityReason?: string;
  attendingDoctorId?: string | null;
  roomId?: string | null;
};

/** Why a visit may not be finished yet (ENC-F-10). */
export type CompletionBlocker = { reason: string; detail: string };

/**
 * Checks other modules register so that a visit cannot be finished while
 * their work is outstanding.
 *
 * The same shape as the branch deactivation registry, and for the same
 * reason: consultation, prescription and billing own those rules, and
 * encounter must not reach into their tables to guess. With nothing
 * registered a visit can always be finished, which is correct today and
 * wrong the moment prescribing exists.
 */
export type CompletionCheck = (
  tx: Tx,
  encounterId: string,
) => Promise<CompletionBlocker | null>;

@Injectable()
export class EncounterCompletionRegistry {
  private readonly logger = new Logger(EncounterCompletionRegistry.name);
  private readonly checks = new Map<string, CompletionCheck>();

  add(name: string, check: CompletionCheck): void {
    this.checks.set(name, check);
    this.logger.log(`encounter completion check registered: ${name}`);
  }

  remove(name: string): void {
    this.checks.delete(name);
  }

  get registered(): string[] {
    return [...this.checks.keys()];
  }

  async blockers(tx: Tx, encounterId: string): Promise<CompletionBlocker[]> {
    const found: CompletionBlocker[] = [];
    for (const check of this.checks.values()) {
      const blocker = await check(tx, encounterId);
      if (blocker) found.push(blocker);
    }
    return found;
  }
}

const SELECT = {
  id: true,
  branchId: true,
  patientId: true,
  encounterNo: true,
  queueNo: true,
  type: true,
  status: true,
  priority: true,
  priorityReason: true,
  attendingDoctorId: true,
  roomId: true,
  registeredBy: true,
  registeredAt: true,
  statusSince: true,
  calledAt: true,
  callCount: true,
  skipCount: true,
  triageAt: true,
  consultationStartedAt: true,
  consultationEndedAt: true,
  dispensedAt: true,
  paidAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  followUpDue: true,
  followUpNote: true,
} as const;

/**
 * One visit, from the door to the door.
 *
 * Everything that changes a status comes through `transition()`. Nothing
 * else writes the column, a database trigger refuses it if anything tries,
 * and every move leaves exactly one row in the timeline. That single
 * chokepoint is what makes the state machine in §6 a fact rather than an
 * intention.
 */
@Injectable()
export class EncounterService {
  private readonly logger = new Logger(EncounterService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly settings: SettingsService,
    private readonly branches: BranchService,
    private readonly numbers: QueueNumberService,
    private readonly stream: QueueStreamService,
    private readonly completion: EncounterCompletionRegistry,
  ) {}

  async getOrThrow(tx: Tx, encounterId: string) {
    const encounter = await tx.encounter.findFirst({
      where: { id: encounterId },
      select: SELECT,
    });
    if (!encounter) throw new NotFoundError('Encounter');
    return encounter;
  }

  // ------------------------------------------------------------- check in

  /** ENC-F-01: a patient walks in and joins the queue. */
  async checkIn(ctx: TenantContext, branchId: string, input: CheckInInput) {
    const tx = this.db.tx();
    const now = this.clock.now();

    const branch = await this.branches.getDetail(tx, branchId);
    if (branch.status !== 'ACTIVE') {
      throw new BadRequestError(
        `${branch.name} is not open for new patients.`,
        'branch_inactive',
      );
    }

    const patient = await tx.patient.findFirst({
      where: { id: input.patientId },
      select: { id: true, name: true, status: true },
    });
    if (!patient) throw new NotFoundError('Patient');
    if (patient.status === 'DECEASED') {
      throw new BadRequestError(
        'This patient is recorded as deceased. Check the record before checking them in.',
        'patient_deceased',
      );
    }
    if (patient.status !== 'ACTIVE') {
      throw new BadRequestError(
        'This record has been merged or removed. Open the patient and check.',
        'patient_not_active',
      );
    }

    // ENC-F-13: one open visit per patient per branch. The database has the
    // same rule as a partial unique index; this is here to say why.
    const openHere = await tx.encounter.findFirst({
      where: { patientId: input.patientId, branchId, status: { in: [...OPEN_STATUSES] } },
      select: { id: true, queueNo: true, status: true },
    });
    if (openHere) {
      throw new ConflictError(
        `${patient.name} is already in the queue here as ${openHere.queueNo}.`,
        'encounter_already_open',
        { encounterId: openHere.id, queueNo: openHere.queueNo, status: openHere.status },
      );
    }
    // At another branch it is allowed, and worth saying out loud: a referred
    // patient legitimately has two visits on one day.
    const openElsewhere = await tx.encounter.findFirst({
      where: { patientId: input.patientId, status: { in: [...OPEN_STATUSES] } },
      select: { id: true, branchId: true },
    });

    const type = input.type ?? EncounterType.WALK_IN;
    // §12: the type and the priority cannot disagree about an emergency.
    const priority =
      type === EncounterType.EMERGENCY
        ? EncounterPriority.EMERGENCY
        : (input.priority ?? EncounterPriority.NORMAL);
    if (priority !== EncounterPriority.NORMAL && !(input.priorityReason ?? '').trim()) {
      throw new BadRequestError(
        'Say why this patient is being seen sooner. It is shown to whoever is skipped.',
        'priority_reason_required',
      );
    }

    if (input.attendingDoctorId) {
      await this.assertDoctorAtBranch(tx, input.attendingDoctorId, branchId);
    }
    if (input.roomId) await this.assertRoom(tx, input.roomId, branchId);

    const allocated = await this.numbers.allocate(
      branchId,
      branch.code,
      branch.timezone ?? 'Asia/Kuala_Lumpur',
      priority,
      now,
    );

    // ENC-F-05: whether triage happens at all is the clinic's decision.
    const { triageRequired } = await this.settings.group(branchId, 'queue');
    const firstStatus =
      triageRequired === 'NEVER' ? EncounterStatus.DOCTOR_WAITING : EncounterStatus.TRIAGE_WAITING;

    const id = newId();
    await tx.encounter.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId,
        patientId: input.patientId,
        encounterNo: allocated.encounterNo,
        queueNo: allocated.queueNo,
        type,
        status: EncounterStatus.REGISTERED,
        priority,
        priorityReason: input.priorityReason?.trim() || null,
        attendingDoctorId: input.attendingDoctorId ?? null,
        roomId: input.roomId ?? null,
        registeredBy: ctx.userId,
        registeredAt: now,
        statusSince: now,
      },
    });

    await this.writeEvent(tx, ctx, id, null, EncounterStatus.REGISTERED, 'check_in', null);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.EncounterCreated,
      entityType: 'encounter',
      entityId: id,
      subjectPatientId: input.patientId,
      after: { encounterNo: allocated.encounterNo, queueNo: allocated.queueNo, type, priority },
    });
    this.events.publish({
      name: DomainEvent.EncounterCreated,
      tenantId: ctx.tenantId,
      branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { encounterId: id, patientId: input.patientId, queueNo: allocated.queueNo },
    });

    // Straight into the first queue, as one action from the user's point of
    // view: nobody checks a patient in and then separately sends them to wait.
    const after = await this.transition(ctx, id, firstStatus, {
      note: 'Joined the queue on check-in',
      action: 'check_in',
    });

    this.stream.publish({
      branchId,
      kind: 'created',
      encounterId: id,
      queueNo: allocated.queueNo,
      at: now.toISOString(),
    });

    return {
      encounter: after,
      warnings: openElsewhere
        ? [
            'This patient already has an open visit at another branch. That is allowed, ' +
              'and worth checking if it was not expected.',
          ]
        : [],
    };
  }

  // ----------------------------------------------------------- transition

  /**
   * ENC-R-01: the only way a status changes.
   *
   * Validates against the transition table, applies the branch's own
   * routing rules, checks the completion guards, moves `status_since`,
   * writes exactly one timeline row and tells the boards. Everything else in
   * this module calls it; nothing bypasses it.
   */
  async transition(
    ctx: TenantContext,
    encounterId: string,
    to: EncounterStatus,
    options: { note?: string; action?: string; force?: boolean } = {},
  ) {
    const tx = this.db.tx();
    const now = this.clock.now();
    const before = await this.getOrThrow(tx, encounterId);

    if (before.status === to) return this.present(before);

    // Even a forced move has to be one the state machine knows about. Force
    // reaches the recovery transitions and skips the completion guards; it
    // is not permission to put an encounter into any state at all.
    if (!isAllowed(before.status, to, { force: options.force })) {
      const allowed = allowedFrom(before.status);
      throw new InvariantViolationError(
        'invalid_transition',
        allowed.length === 0
          ? `This visit is ${readable(before.status)} and cannot be moved on.`
          : `A visit that is ${readable(before.status)} cannot become ${readable(to)}. ` +
            `It can become: ${allowed.map((rule) => readable(rule.to)).join(', ')}.`,
        { from: before.status, to, allowed: allowed.map((rule) => rule.to) },
      );
    }

    // ENC-F-10, ENC-R-04: evaluated now, against live data, never cached.
    if (to === EncounterStatus.COMPLETED && !options.force) {
      const blockers = await this.completionBlockers(tx, before.branchId, encounterId);
      if (blockers.length > 0) {
        throw new InvariantViolationError(
          'completion_blocked',
          `This visit cannot be finished yet: ${blockers.map((b) => b.detail).join('; ')}.`,
          { blockers },
        );
      }
    }

    const data: Record<string, unknown> = { status: to, statusSince: now };
    // The stage timestamps. Recorded as they happen, because a duration
    // worked out later from the timeline is a duration nobody trusts.
    if (to === EncounterStatus.TRIAGE_IN_PROGRESS) data['triageAt'] = now;
    if (to === EncounterStatus.IN_CONSULTATION) data['consultationStartedAt'] = now;
    if (before.status === EncounterStatus.IN_CONSULTATION) data['consultationEndedAt'] = now;
    if (to === EncounterStatus.DISPENSING) data['dispensedAt'] = now;
    if (to === EncounterStatus.COMPLETED) data['completedAt'] = now;
    if (to === EncounterStatus.CANCELLED) {
      data['cancelledAt'] = now;
      data['cancelledBy'] = ctx.userId;
      data['cancelReason'] = options.note ?? null;
    }
    // Returning someone called by mistake keeps their place in the queue,
    // which is the entire point of the move (§14).
    if (to === EncounterStatus.DOCTOR_WAITING && before.status === EncounterStatus.IN_CONSULTATION) {
      data['consultationStartedAt'] = null;
      // Their place in the queue is kept, which is the whole point of the
      // move. The trigger insists status_since changes when status does,
      // and here it deliberately must not, so it is nudged by the smallest
      // amount that satisfies the backstop without losing the position.
      data['statusSince'] = new Date(before.statusSince.getTime() + 1);
    }
    if (to === EncounterStatus.TRIAGE_WAITING || to === EncounterStatus.DOCTOR_WAITING) {
      // A new queue, so the call state starts again.
      data['calledAt'] = null;
    }

    await tx.encounter.update({ where: { id: encounterId }, data });
    const after = await this.getOrThrow(tx, encounterId);

    await this.writeEvent(
      tx,
      ctx,
      encounterId,
      before.status,
      to,
      options.action ?? (options.force ? 'force' : 'transition'),
      options.note ?? null,
    );

    if (options.force) {
      this.logger.warn(
        `${ctx.userName} forced ${before.encounterNo} from ${before.status} to ${to}: ${options.note ?? 'no reason given'}`,
      );
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: options.force ? AuditAction.EncounterForced : AuditAction.EncounterStatusChanged,
      entityType: 'encounter',
      entityId: encounterId,
      subjectPatientId: before.patientId,
      before: { status: before.status },
      after: { status: to },
      reason: options.note ?? null,
    });

    this.events.publish({
      name:
        to === EncounterStatus.COMPLETED
          ? DomainEvent.EncounterCompleted
          : to === EncounterStatus.CANCELLED
            ? DomainEvent.EncounterCancelled
            : to === EncounterStatus.NO_SHOW
              ? DomainEvent.EncounterNoShow
              : DomainEvent.EncounterStatusChanged,
      tenantId: ctx.tenantId,
      branchId: before.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        encounterId,
        patientId: before.patientId,
        from: before.status,
        to,
      },
    });

    this.stream.publish({
      branchId: before.branchId,
      kind: 'status',
      encounterId,
      queueNo: before.queueNo,
      at: now.toISOString(),
    });

    return this.present(after);
  }

  /** ENC-F-10: what is standing between this visit and being finished. */
  async completionBlockers(tx: Tx, branchId: string, encounterId: string) {
    const settings = await this.settings.group(branchId, 'queue');
    const all = await this.completion.blockers(tx, encounterId);
    return all.filter((blocker) => {
      if (blocker.reason === 'undispensed') return settings.requireDispenseBeforeComplete;
      if (blocker.reason === 'unpaid') return settings.requirePaymentBeforeComplete;
      return true;
    });
  }

  private async writeEvent(
    tx: Tx,
    ctx: TenantContext,
    encounterId: string,
    from: EncounterStatus | null,
    to: EncounterStatus,
    action: string,
    note: string | null,
  ) {
    await tx.encounterEvent.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        encounterId,
        fromStatus: from,
        toStatus: to,
        action,
        actorId: ctx.userId,
        actorName: ctx.userName,
        note,
        occurredAt: this.clock.now(),
      },
    });
  }

  private async assertDoctorAtBranch(tx: Tx, userId: string, branchId: string) {
    const role = await tx.userBranchRole.findFirst({
      where: { userId, branchId, role: Role.DOCTOR },
      select: { id: true },
    });
    if (!role) {
      throw new BadRequestError(
        'That person is not a doctor at this branch.',
        'not_a_doctor_here',
      );
    }
  }

  private async assertRoom(tx: Tx, roomId: string, branchId: string) {
    const room = await tx.branchRoom.findFirst({
      where: { id: roomId, branchId },
      select: { id: true, active: true, name: true },
    });
    if (!room) throw new NotFoundError('Room');
    if (!room.active) {
      throw new BadRequestError(`${room.name} is not in use.`, 'room_inactive');
    }
  }

  /** The shape a screen receives, with the derived bits worked out once. */
  present(encounter: Awaited<ReturnType<EncounterService['getOrThrow']>>) {
    const now = this.clock.now();
    const station: Station | undefined = stationOf(encounter.status);
    return {
      ...encounter,
      waitingMinutes: Math.floor((now.getTime() - encounter.statusSince.getTime()) / 60_000),
      station: station ?? null,
      open: !TERMINAL_STATUSES.includes(encounter.status),
      allowedNext: allowedFrom(encounter.status).map((rule) => ({
        to: rule.to,
        label: rule.label,
        note: rule.note ?? null,
      })),
    };
  }
}

/** A status in the words a person at the counter would use. */
export function readable(status: EncounterStatus): string {
  return status.toLowerCase().replaceAll('_', ' ');
}

export { ruleFor };
