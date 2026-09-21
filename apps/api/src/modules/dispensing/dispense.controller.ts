import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DispenseService } from './dispense.service.js';
import { ControlledRegisterService } from './controlled-register.service.js';
import {
  CancelDispenseDto,
  CompleteDispenseDto,
  DispenseItemDto,
  DispenseReasonDto,
  ReturnDto,
  SubstituteDto,
} from './dto/dispense.dto.js';

@Controller()
export class DispenseController {
  constructor(
    private readonly dispensing: DispenseService,
    private readonly register: ControlledRegisterService,
  ) {}

  @Get('branches/:branchId/pharmacy/queue')
  @RequirePermission('dispense.perform')
  queue(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.dispensing.queue(ctx, branchId);
  }

  @Post('encounters/:id/dispense')
  @Audited(AuditAction.DispenseOpened)
  @RequirePermission('dispense.perform')
  open(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.dispensing.open(ctx, id);
  }

  @Get('dispenses/:id')
  @RequirePermission('dispense.perform')
  read(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.dispensing.read(ctx, id);
  }

  @Post('dispenses/:id/items/:rxItemId/dispense')
  @Audited(AuditAction.DispenseItemDispensed)
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  dispenseItem(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('rxItemId') rxItemId: string,
    @Body() body: DispenseItemDto,
  ) {
    return this.dispensing.dispenseItem(ctx, id, rxItemId, body);
  }

  /**
   * DSP-F-07. `dispense.substitute` is not required here: swapping one
   * brand for another of the same generic is routine counter work. The
   * service asks for the permission only when the generic changes,
   * which is a prescribing decision.
   */
  @Post('dispenses/:id/items/:rxItemId/substitute')
  @Audited(AuditAction.DispenseItemSubstituted)
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  substitute(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('rxItemId') rxItemId: string,
    @Body() body: SubstituteDto,
  ) {
    return this.dispensing.substitute(ctx, id, rxItemId, body);
  }

  @Post('dispense-items/:id/undo')
  @Audited(AuditAction.DispenseUndone)
  @HttpCode(200)
  @RequirePermission('dispense.cancel')
  undo(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: DispenseReasonDto) {
    return this.dispensing.undo(ctx, id, body.reason);
  }

  @Post('dispense-items/:id/return')
  @Audited(AuditAction.DispenseReturned)
  @HttpCode(200)
  @RequirePermission('dispense.cancel')
  recordReturn(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: ReturnDto) {
    return this.dispensing.recordReturn(ctx, id, body);
  }

  /** DSP-F-12. A reprint is counted, and audited past the first. */
  @Post('dispense-items/:id/label')
  @Audited(AuditAction.LabelReprinted)
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  label(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.dispensing.label(ctx, id);
  }

  @Post('dispenses/:id/complete')
  @Audited(AuditAction.DispenseCompleted)
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  complete(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: CompleteDispenseDto,
  ) {
    return this.dispensing.complete(ctx, id, body);
  }

  @Post('dispenses/:id/cancel')
  @Audited(AuditAction.DispenseCancelled)
  @HttpCode(200)
  @RequirePermission('dispense.perform')
  cancel(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: CancelDispenseDto) {
    return this.dispensing.cancel(ctx, id, body.reason ?? '');
  }

  /** DSP-F-18. Reading it shows unmasked identity numbers, so it is audited. */
  @Get('branches/:branchId/controlled-register')
  @RequirePermission('stock.read')
  registerFor(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('productId') productId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.register.read(ctx, branchId, {
      productId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /** DSP-F-19: the register's balance against the shelf. */
  @Get('branches/:branchId/controlled-register/reconciliation')
  @RequirePermission('stock.read')
  reconcile(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.register.reconcile(ctx, branchId);
  }
}
