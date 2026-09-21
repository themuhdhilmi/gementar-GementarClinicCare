import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { EncounterStatus } from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import {
  Ctx,
  NoRequestTransaction,
  RequirePermission,
  RequireReauth,
} from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { EncounterService } from './encounter.service.js';
import { QueueService } from './queue.service.js';
import { QueueStreamService, type QueueEvent } from './queue-stream.service.js';
import { QueueNumberService } from './queue-number.service.js';
import { STATION_STATUSES, type Station } from './transitions.js';
import {
  AssignmentDto,
  CheckInDto,
  FollowUpDto,
  PriorityDto,
  ReasonDto,
  TransitionDto,
} from './dto/encounter.dto.js';

const STATIONS = Object.keys(STATION_STATUSES) as Station[];

function asStation(raw: string): Station {
  if (!STATIONS.includes(raw as Station)) {
    throw new NotFoundError(`Queue "${raw}"`);
  }
  return raw as Station;
}

@Controller()
export class EncountersController {
  constructor(
    private readonly encounters: EncounterService,
    private readonly queues: QueueService,
    private readonly stream: QueueStreamService,
    private readonly db: DbService,
  ) {}

  // ------------------------------------------------------------ check in

  @Post('branches/:branchId/encounters')
  @Audited(AuditAction.EncounterCreated)
  @RequirePermission('encounter.create')
  @HttpCode(201)
  async checkIn(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CheckInDto,
  ) {
    return this.encounters.checkIn(ctx, branchId, dto);
  }

  // -------------------------------------------------------------- boards

  @Get('branches/:branchId/queues/:station')
  @RequirePermission('patient.read')
  async board(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Param('station') station: string,
    @Query('doctorId') doctorId?: string,
    @Query('mine') mine?: string,
  ) {
    // "Mine" is the doctor's own board, which is the filter they actually
    // want; "any" shows patients nobody has been assigned to as well.
    const filterDoctor = mine === 'true' ? ctx.userId : (doctorId ?? null);
    return {
      items: await this.queues.board(branchId, asStation(station), {
        doctorId: filterDoctor,
      }),
    };
  }

  @Get('branches/:branchId/queues-stats')
  @RequirePermission('patient.read')
  async stats(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    void ctx;
    return this.queues.stats(branchId);
  }

  /**
   * ENC-F-19: the live feed the boards listen to.
   *
   * Marked so the per-request transaction interceptor leaves it alone. A
   * connection here stays open all afternoon, and a transaction held that
   * long would exhaust the pool and trip the five-second cap (TEN-N-05) on
   * the first client.
   *
   * The events are invalidation signals (ENC-R-08): they say what changed,
   * and the client refetches. That is why a dropped connection is harmless
   * and why nothing sensitive travels down it.
   */
  @Sse('branches/:branchId/queues-stream')
  @RequirePermission('patient.read')
  @NoRequestTransaction(
    'A stream stays open for hours; a transaction must not.',
  )
  streamQueue(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ): Observable<{ data: QueueEvent | { heartbeat: string } }> {
    void ctx;
    return this.stream.forBranch(branchId);
  }

  // ------------------------------------------------------------ one visit

  @Get('encounters/:id')
  @RequirePermission('patient.read')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    const tx = this.db.tx();
    const encounter = await this.encounters.getOrThrow(tx, id);
    const [timeline, blockers, flow] = await Promise.all([
      this.queues.timeline(tx, id),
      this.encounters.completionBlockers(tx, encounter.branchId, id),
      this.queues.flow(tx, encounter),
    ]);
    return {
      encounter: this.encounters.present(encounter),
      timeline,
      // ENC-F-11: the journey, at a glance, above the detail.
      flow,
      // The checklist on the chart: what is still standing in the way of
      // finishing, in words rather than as a disabled button with no reason.
      completionBlockers: blockers,
    };
  }

  @Get('encounters/:id/events')
  @RequirePermission('patient.read')
  async events(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return { items: await this.queues.timeline(this.db.tx(), id) };
  }

  @Post('encounters/:id/transition')
  @Audited(AuditAction.EncounterStatusChanged)
  @RequirePermission('encounter.transition')
  @HttpCode(200)
  async transition(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.encounters.transition(ctx, id, dto.to, { note: dto.note });
  }

  @Post('encounters/:id/call')
  @Audited(AuditAction.EncounterCalled)
  @RequirePermission('encounter.transition')
  @HttpCode(200)
  async callAgain(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.queues.callAgain(ctx, id);
  }

  @Post('branches/:branchId/queues/:station/call-next')
  @Audited(AuditAction.EncounterCalled)
  @RequirePermission('encounter.transition')
  @HttpCode(200)
  async callNext(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Param('station') station: string,
    @Query('mine') mine?: string,
  ) {
    return this.queues.callNext(ctx, branchId, asStation(station), {
      doctorId: mine === 'true' ? ctx.userId : null,
    });
  }

  @Post('encounters/:id/skip')
  @Audited(AuditAction.EncounterSkipped)
  @RequirePermission('encounter.transition')
  @HttpCode(200)
  async skip(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.queues.skip(ctx, id);
  }

  @Post('encounters/:id/no-show')
  @Audited(AuditAction.EncounterNoShow)
  @RequirePermission('encounter.cancel')
  @HttpCode(200)
  async noShow(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.encounters.transition(ctx, id, EncounterStatus.NO_SHOW, {
      note: dto.reason,
      action: 'no_show',
    });
  }

  @Post('encounters/:id/cancel')
  @Audited(AuditAction.EncounterCancelled)
  @RequirePermission('encounter.cancel')
  @HttpCode(200)
  async cancel(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.encounters.transition(ctx, id, EncounterStatus.CANCELLED, {
      note: dto.reason,
      action: 'cancel',
    });
  }

  /** ENC-F-09: the patient came back. Same day only, and recorded. */
  @Post('encounters/:id/revert-no-show')
  @Audited(AuditAction.EncounterReopened)
  @RequirePermission('encounter.cancel')
  @HttpCode(200)
  async revertNoShow(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const encounter = await this.encounters.getOrThrow(this.db.tx(), id);
    if (encounter.status !== EncounterStatus.NO_SHOW) {
      throw new BadRequestError(
        'This visit is not marked absent.',
        'not_a_no_show',
      );
    }
    // The clinic's day, not the server's, and not UTC. A visit registered
    // at 9pm in Kuala Lumpur is still today when somebody comes back at
    // 9.30pm, and a UTC comparison would already have rolled over.
    const tx = this.db.tx();
    const branch = await tx.branch.findFirst({
      where: { id: encounter.branchId },
      select: { timezone: true },
    });
    const timezone = branch?.timezone ?? 'Asia/Kuala_Lumpur';
    const sameDay =
      QueueNumberService.clinicDay(encounter.registeredAt, timezone) ===
      QueueNumberService.clinicDay(new Date(), timezone);
    if (!sameDay) {
      throw new BadRequestError(
        'That visit was not today. Check the patient in again rather than reviving it.',
        'not_today',
      );
    }
    return this.encounters.transition(ctx, id, EncounterStatus.DOCTOR_WAITING, {
      note: 'Patient returned',
      action: 'revert_no_show',
    });
  }

  @Patch('encounters/:id/assignment')
  @Audited(AuditAction.EncounterReassigned)
  @RequirePermission('encounter.transition')
  async assign(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AssignmentDto,
  ) {
    return this.queues.assign(ctx, id, dto);
  }

  @Patch('encounters/:id/priority')
  @Audited(AuditAction.EncounterPriorityChanged)
  @RequirePermission('encounter.priority')
  async priority(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PriorityDto,
  ) {
    return this.queues.setPriority(ctx, id, dto.priority, dto.reason);
  }

  @Patch('encounters/:id/follow-up')
  @Audited(AuditAction.EncounterFollowUpSet)
  @RequirePermission('encounter.transition')
  async followUp(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: FollowUpDto,
  ) {
    const tx = this.db.tx();
    await this.encounters.getOrThrow(tx, id);
    await tx.encounter.update({
      where: { id },
      data: {
        followUpDue: dto.followUpDue ? new Date(dto.followUpDue) : null,
        followUpNote: dto.followUpNote ?? null,
      },
    });
    return this.encounters.present(await this.encounters.getOrThrow(tx, id));
  }

  /**
   * ENC-F-12 and the recovery hatch, together.
   *
   * Both need an administrator and a fresh password, because both step
   * around the state machine, and both are logged loudly. The difference is
   * only which target is asked for.
   */
  @Post('encounters/:id/force-transition')
  @Audited(AuditAction.EncounterForced)
  @RequirePermission('admin.settings')
  @RequireReauth()
  @HttpCode(200)
  async force(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: TransitionDto & ReasonDto,
  ) {
    if (!(dto.note ?? '').trim() && !(dto.reason ?? '').trim()) {
      throw new BadRequestError(
        'Forcing a status needs a reason. It appears on the audit dashboard.',
        'reason_required',
      );
    }
    return this.encounters.transition(ctx, id, dto.to, {
      force: true,
      action: 'force',
      note: dto.note ?? dto.reason,
    });
  }
}
