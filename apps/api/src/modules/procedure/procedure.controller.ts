import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { ProcedureCategory } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { ProcedureCatalogueService } from './procedure-catalogue.service.js';
import { ProcedureService } from './procedure.service.js';
import {
  OrderProcedureDto,
  PerformDto,
  ProcedureDto,
  ProcedureReasonDto,
  UpdateProcedureDto,
  VoidProcedureDto,
} from './dto/procedure.dto.js';

@Controller()
export class ProcedureController {
  constructor(
    private readonly catalogue: ProcedureCatalogueService,
    private readonly procedures: ProcedureService,
  ) {}

  // ------------------------------------------------------- catalogue

  @Get('procedure-catalog')
  @RequirePermission('stock.read')
  list(
    @Ctx() ctx: TenantContext,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    if (category && !Object.values(ProcedureCategory).includes(category as ProcedureCategory)) {
      throw new BadRequestError(`"${category}" is not a kind of procedure.`, 'invalid_category');
    }
    return this.catalogue.list(ctx, {
      q,
      category: category as ProcedureCategory | undefined,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('procedure-catalog/:id')
  @RequirePermission('stock.read')
  read(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.catalogue.read(ctx, id);
  }

  @Get('procedure-catalog/:id/price-history')
  @RequirePermission('catalogue.write')
  priceHistory(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.catalogue.priceHistory(ctx, id);
  }

  @Post('procedure-catalog')
  @Audited(AuditAction.ProcedureCreated)
  @RequirePermission('catalogue.write')
  create(@Ctx() ctx: TenantContext, @Body() body: ProcedureDto) {
    return this.catalogue.create(ctx, body);
  }

  @Patch('procedure-catalog/:id')
  @Audited(AuditAction.ProcedureUpdated)
  @RequirePermission('catalogue.write')
  update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: UpdateProcedureDto) {
    return this.catalogue.update(ctx, id, body);
  }

  @Post('procedure-catalog/:id/retire')
  @Audited(AuditAction.ProcedureRetired)
  @HttpCode(200)
  @RequirePermission('catalogue.write')
  retire(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: ProcedureReasonDto) {
    return this.catalogue.retire(ctx, id, body.reason);
  }

  // -------------------------------------------------- on an encounter

  @Get('encounters/:id/procedures')
  @RequirePermission('clinical.read')
  async forEncounter(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return { items: await this.procedures.forEncounter(ctx, id) };
  }

  /**
   * A doctor orders from the plan. A nurse may start one where the
   * procedure does not need a doctor and the clinic allows it, which is
   * why `procedure.perform` is enough to reach this — the service
   * refuses the rest.
   */
  @Post('encounters/:id/procedures')
  @Audited(AuditAction.ProcedureOrdered)
  @RequirePermission('procedure.perform')
  order(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: OrderProcedureDto) {
    return this.procedures.order(ctx, id, body);
  }

  @Get('branches/:branchId/procedures/queue')
  @RequirePermission('procedure.perform')
  queue(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.procedures.queue(ctx, branchId);
  }

  @Post('encounter-procedures/:id/perform')
  @Audited(AuditAction.ProcedurePerformed)
  @HttpCode(200)
  @RequirePermission('procedure.perform')
  perform(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: PerformDto) {
    return this.procedures.perform(ctx, id, body);
  }

  @Post('encounter-procedures/:id/cancel')
  @Audited(AuditAction.ProcedureCancelled)
  @HttpCode(200)
  @RequirePermission('procedure.perform')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: ProcedureReasonDto) {
    return this.procedures.cancel(ctx, id, body.reason);
  }

  /** PRC-F-10. Reverses stock and removes a charge, so: administrators only. */
  @Post('encounter-procedures/:id/void')
  @Audited(AuditAction.ProcedureVoided)
  @HttpCode(200)
  @RequirePermission('admin.settings')
  void(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: VoidProcedureDto) {
    return this.procedures.void(ctx, id, body.reason);
  }

  @Get('patients/:id/vaccinations')
  @RequirePermission('clinical.read')
  vaccinations(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.procedures.vaccinations(ctx, id);
  }
}
