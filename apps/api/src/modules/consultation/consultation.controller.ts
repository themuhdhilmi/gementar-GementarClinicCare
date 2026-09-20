import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { newId } from '../../shared/ids/uuid.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import {
  Ctx,
  NoPermission,
  RequirePermission,
  RequireReauth,
} from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ConsultationService, type ClinicalField } from './consultation.service.js';
import { TemplateService } from './template.service.js';
import {
  AmendDto,
  DiagnosesDto,
  QuickPhraseDto,
  ReasonDto,
  ReassignDto,
  SignDto,
  SaveConsultationDto,
  StartConsultationDto,
  TemplateDto,
  UpdateTemplateDto,
} from './dto/consultation.dto.js';

@Controller()
export class ConsultationController {
  constructor(
    private readonly consultations: ConsultationService,
    private readonly templates: TemplateService,
    private readonly db: DbService,
  ) {}

  // ------------------------------------------------------ the record

  @Post('encounters/:id/consultations')
  @RequirePermission('clinical.write')
  @HttpCode(201)
  async start(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: StartConsultationDto,
  ) {
    return this.consultations.start(ctx, id, { copyFromId: dto.copyFromId });
  }

  @Get('consultations/:id')
  @RequirePermission('clinical.read')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.consultations.read(ctx, id);
  }

  /** CON-F-12: called every few seconds while the doctor is typing. */
  @Patch('consultations/:id')
  @RequirePermission('clinical.write')
  async save(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SaveConsultationDto,
  ) {
    return this.consultations.save(ctx, id, dto);
  }

  @Put('consultations/:id/diagnoses')
  @RequirePermission('clinical.write')
  async diagnoses(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DiagnosesDto,
  ) {
    return { items: await this.consultations.setDiagnoses(ctx, id, dto.diagnoses) };
  }

  @Post('consultations/:id/sign')
  @RequirePermission('clinical.sign')
  @HttpCode(200)
  async sign(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: SignDto) {
    return this.consultations.sign(ctx, id, { confirm: dto.confirm ?? [] });
  }

  @Post('consultations/:id/cancel')
  @RequirePermission('clinical.write')
  @HttpCode(200)
  async cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.consultations.cancel(ctx, id, dto.reason);
  }

  @Post('consultations/:id/amend')
  @RequirePermission('clinical.amend')
  @HttpCode(200)
  async amend(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: AmendDto) {
    return this.consultations.amend(ctx, id, {
      type: dto.type,
      field: dto.field as ClinicalField | undefined,
      current: dto.current,
      reason: dto.reason,
    });
  }

  /** §14: a locum has gone home with drafts open. */
  @Post('consultations/:id/reassign')
  @RequirePermission('admin.settings')
  @RequireReauth()
  @HttpCode(200)
  async reassign(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReassignDto) {
    return this.consultations.reassign(ctx, id, dto.toDoctorId, dto.reason);
  }

  // ------------------------------------------------------------ lists

  @Get('me/drafts')
  @RequirePermission('clinical.write')
  async myDrafts(@Ctx() ctx: TenantContext) {
    return { items: await this.consultations.myDrafts(this.db.tx(), ctx.userId) };
  }

  @Get('consultations-stale')
  @RequirePermission('admin.settings')
  async stale(@Ctx() ctx: TenantContext) {
    void ctx;
    return { items: await this.consultations.staleDrafts(this.db.tx()) };
  }

  @Get('patients/:id/consultations')
  @RequirePermission('clinical.read')
  async forPatient(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    void ctx;
    return {
      items: await this.consultations.history(this.db.tx(), id, limit ? Number(limit) : 10),
    };
  }

  // -------------------------------------------------------- templates

  @Get('clinical-templates')
  @RequirePermission('clinical.write')
  async listTemplates(@Ctx() ctx: TenantContext) {
    return { items: await this.templates.list(this.db.tx(), ctx.userId) };
  }

  @Post('clinical-templates')
  @NoPermission(
    'A doctor manages their own templates and an administrator the clinic\u2019s. ' +
      'Two permissions, so TemplateService decides which applies.',
  )
  @HttpCode(201)
  async createTemplate(@Ctx() ctx: TenantContext, @Body() dto: TemplateDto) {
    return this.templates.create(ctx, dto);
  }

  @Patch('clinical-templates/:id')
  @NoPermission(
    'A doctor manages their own templates and an administrator the clinic\u2019s. ' +
      'Two permissions, so TemplateService decides which applies.',
  )
  async updateTemplate(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templates.update(ctx, id, dto);
  }

  @Delete('clinical-templates/:id')
  @NoPermission(
    'A doctor manages their own templates and an administrator the clinic\u2019s. ' +
      'Two permissions, so TemplateService decides which applies.',
  )
  async retireTemplate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.templates.retire(ctx, id);
  }

  @Post('consultations/:id/apply-template/:templateId')
  @RequirePermission('clinical.write')
  @HttpCode(200)
  async applyTemplate(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templates.apply(ctx, id, templateId);
  }

  // ----------------------------------------------------- quick phrases

  @Get('me/quick-phrases')
  @RequirePermission('clinical.write')
  async phrases(@Ctx() ctx: TenantContext) {
    return {
      items: await this.db.tx().quickPhrase.findMany({
        where: { userId: ctx.userId },
        orderBy: { trigger: 'asc' },
      }),
    };
  }

  @Post('me/quick-phrases')
  @RequirePermission('clinical.write')
  @HttpCode(201)
  async addPhrase(@Ctx() ctx: TenantContext, @Body() dto: QuickPhraseDto) {
    const tx = this.db.tx();
    const trigger = dto.trigger.startsWith('.') ? dto.trigger : `.${dto.trigger}`;
    await tx.quickPhrase.upsert({
      where: { userId_trigger: { userId: ctx.userId, trigger } },
      create: {
        id: newId(),
        tenantId: requireTenantId(),
        userId: ctx.userId,
        trigger,
        expansion: dto.expansion,
      },
      update: { expansion: dto.expansion },
    });
    return this.phrases(ctx);
  }

  @Delete('me/quick-phrases/:id')
  @RequirePermission('clinical.write')
  async removePhrase(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const tx = this.db.tx();
    const phrase = await tx.quickPhrase.findFirst({ where: { id, userId: ctx.userId } });
    if (!phrase) throw new NotFoundError('Quick phrase');
    await tx.quickPhrase.delete({ where: { id } });
    return this.phrases(ctx);
  }
}
