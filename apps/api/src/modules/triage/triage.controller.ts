import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Audited } from '../audit/audit.decorators.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { EncounterService } from '../encounter/encounter.service.js';
import { ageInYears } from '../patient/patient.validation.js';
import { Clock } from '../../shared/time/clock.js';
import { TriageService } from './triage.service.js';
import { AmendTriageDto, TriageDto } from './dto/triage.dto.js';

@Controller()
export class TriageController {
  constructor(
    private readonly triage: TriageService,
    private readonly encounters: EncounterService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly db: DbService,
  ) {}

  /**
   * Everything recorded during this visit, plus what the form should show
   * before the nurse starts typing.
   *
   * Gated on `clinical.read` and the view is recorded: vitals are clinical
   * data, and an administrator reading them is break-glass.
   */
  @Get('encounters/:id/triage')
  @RequirePermission('clinical.read')
  async forEncounter(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const tx = this.db.tx();
    const encounter = await this.encounters.getOrThrow(tx, id);
    const patient = await tx.patient.findFirst({
      where: { id: encounter.patientId },
      select: { dateOfBirth: true, nkdaRecorded: true },
    });
    const age = ageInYears(patient?.dateOfBirth ?? null, this.clock.now());

    const [records, prefill] = await Promise.all([
      this.triage.forEncounter(tx, id),
      this.triage.prefill(tx, encounter.patientId, age),
    ]);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ClinicalViewed,
      entityType: 'triage',
      entityId: id,
      subjectPatientId: encounter.patientId,
    });

    return {
      records,
      prefill,
      // TRI-F-05: the form asks about allergies when nobody has.
      allergyPromptNeeded: patient?.nkdaRecorded === null,
      // So the screen can colour a reading as the nurse types it, against
      // the same numbers the server will use when it saves.
      thresholds: await this.triage.thresholds(encounter.branchId),
      isChild: age !== null && age < 12,
    };
  }

  @Post('encounters/:id/triage')
  @Audited(AuditAction.TriageRecorded)
  @RequirePermission('triage.write')
  @HttpCode(201)
  async record(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: TriageDto) {
    const { advance, escalate, ...readings } = dto;
    return this.triage.record(ctx, id, readings, { advance, escalate });
  }

  @Patch('triage/:id')
  @Audited(AuditAction.TriageRecorded)
  @RequirePermission('triage.write')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: TriageDto) {
    const { advance, escalate, ...readings } = dto;
    void advance;
    void escalate;
    return this.triage.update(ctx, id, readings);
  }

  @Post('triage/:id/amend')
  @Audited(AuditAction.TriageAmended)
  @RequirePermission('triage.write')
  @HttpCode(200)
  async amend(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: AmendTriageDto) {
    const { advance, escalate, reason, ...readings } = dto;
    void advance;
    void escalate;
    return this.triage.amend(ctx, id, readings, reason);
  }

  @Get('triage/:id/amendments')
  @RequirePermission('clinical.read')
  async amendments(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return { items: await this.triage.amendments(this.db.tx(), id) };
  }

  /** TRI-F-09: one measurement over the patient's last dozen readings. */
  @Get('patients/:id/vitals-trend')
  @RequirePermission('clinical.read')
  async trend(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query('param') param = 'systolic',
  ) {
    void ctx;
    return { param, points: await this.triage.trend(this.db.tx(), id, param) };
  }
}
