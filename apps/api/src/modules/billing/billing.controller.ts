import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited, NotAudited } from '../audit/audit.decorators.js';
import { InvoiceStatus } from '../../generated/prisma/enums.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { InvoiceService, DISCOUNT_SOURCES, type DiscountSource } from './invoice.service.js';
import { BillableItemService } from './billable-item.service.js';
import { FeeScheduleService } from './fee-schedule.service.js';
import {
  BillableItemDto,
  DiscountDto,
  FeeScheduleDto,
  InvoiceQueryDto,
  IssueInvoiceDto,
  ManualLineDto,
  StandaloneInvoiceDto,
  UpdateLineDto,
  VoidInvoiceDto,
} from './dto/billing.dto.js';

@Controller()
export class BillingController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly items: BillableItemService,
    private readonly fees: FeeScheduleService,
  ) {}

  /** The closed lists a cashier's screen builds its selects from. */
  @Get('billing/options')
  @RequirePermission('invoice.read')
  options(@Ctx() ctx: TenantContext) {
    void ctx;
    return { discountSources: DISCOUNT_SOURCES };
  }

  // ---------------------------------------------------------- reading

  @Get('encounters/:id/invoice')
  @RequirePermission('invoice.read')
  forEncounter(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.invoices.forEncounter(ctx, id);
  }

  /** BIL-F-01: the cashier opening billing is what usually creates it. */
  @Post('encounters/:id/invoice')
  @Audited(AuditAction.InvoiceDraftCreated)
  @RequirePermission('invoice.issue')
  ensureDraft(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.invoices.ensureDraft(ctx, id);
  }

  @Get('invoices/:id')
  @RequirePermission('invoice.read')
  read(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.invoices.read(ctx, id);
  }

  @Get('branches/:branchId/invoices')
  @RequirePermission('invoice.read')
  list(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query() query: InvoiceQueryDto,
  ) {
    return this.invoices.list(ctx, branchId, {
      status: query.status as InvoiceStatus | undefined,
      patientId: query.patientId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  // ------------------------------------------------------------ lines

  @Post('invoices/:id/lines')
  @Audited(AuditAction.InvoiceLineAdded)
  @RequirePermission('invoice.issue')
  addLine(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: ManualLineDto) {
    return this.invoices.addManualLine(ctx, id, body);
  }

  @Patch('invoices/:id/lines/:lineId')
  @Audited(AuditAction.InvoiceLineEdited)
  @RequirePermission('invoice.issue')
  updateLine(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: UpdateLineDto,
  ) {
    return this.invoices.updateManualLine(ctx, id, lineId, body);
  }

  @Delete('invoices/:id/lines/:lineId')
  @Audited(AuditAction.InvoiceLineRemoved)
  @RequirePermission('invoice.issue')
  removeLine(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ) {
    return this.invoices.removeManualLine(ctx, id, lineId);
  }

  // -------------------------------------------------------- discounts

  @Put('invoices/:id/lines/:lineId/discount')
  @Audited(AuditAction.InvoiceDiscounted)
  @HttpCode(200)
  @RequirePermission('invoice.discount')
  discountLine(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: DiscountDto,
  ) {
    return this.invoices.setLineDiscount(ctx, id, lineId, {
      pct: body.pct ?? null,
      amount: body.amount ?? null,
      source: body.source as DiscountSource,
      reason: body.reason ?? null,
      elevatedBy: body.elevatedBy ?? null,
    });
  }

  @Put('invoices/:id/discount')
  @Audited(AuditAction.InvoiceDiscounted)
  @HttpCode(200)
  @RequirePermission('invoice.discount')
  discountInvoice(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: DiscountDto,
  ) {
    return this.invoices.setInvoiceDiscount(ctx, id, {
      pct: body.pct ?? null,
      amount: body.amount ?? null,
      source: body.source as DiscountSource,
      reason: body.reason ?? null,
      elevatedBy: body.elevatedBy ?? null,
    });
  }

  @Delete('invoices/:id/discount')
  @Audited(AuditAction.InvoiceDiscounted)
  @RequirePermission('invoice.discount')
  clearDiscount(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.invoices.clearInvoiceDiscount(ctx, id);
  }

  // ------------------------------------------------- issue and after

  @Post('invoices/:id/issue')
  @Audited(AuditAction.InvoiceIssued)
  @HttpCode(200)
  @RequirePermission('invoice.issue')
  issue(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: IssueInvoiceDto) {
    return this.invoices.issue(ctx, id, { idempotencyKey: body.idempotencyKey });
  }

  /** BIL-F-15. Reverses a document somebody may already hold. */
  @Post('invoices/:id/void')
  @Audited(AuditAction.InvoiceVoided)
  @HttpCode(200)
  @RequirePermission('invoice.void')
  voidInvoice(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: VoidInvoiceDto) {
    return this.invoices.void(ctx, id, body.reason);
  }

  @Post('invoices/:id/reissue')
  @Audited(AuditAction.InvoiceReissued)
  @RequirePermission('invoice.issue')
  reissue(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.invoices.reissue(ctx, id);
  }

  @Post('branches/:branchId/invoices/standalone')
  @Audited(AuditAction.InvoiceIssued)
  @RequirePermission('invoice.issue')
  standalone(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: StandaloneInvoiceDto,
  ) {
    return this.invoices.standalone(ctx, branchId, body);
  }

  // ----------------------------------------------------------- admin

  @Get('billable-items')
  @RequirePermission('invoice.read')
  listItems(@Ctx() ctx: TenantContext, @Query('includeInactive') includeInactive?: string) {
    return this.items.list(ctx, includeInactive === 'true');
  }

  @Post('billable-items')
  @Audited(AuditAction.BillableItemChanged)
  @RequirePermission('admin.settings')
  createItem(@Ctx() ctx: TenantContext, @Body() body: BillableItemDto) {
    return this.items.create(ctx, body);
  }

  @Patch('billable-items/:id')
  @Audited(AuditAction.BillableItemChanged)
  @RequirePermission('admin.settings')
  updateItem(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: BillableItemDto) {
    return this.items.update(ctx, id, body);
  }

  @Get('fee-schedule')
  @RequirePermission('admin.settings')
  listFees(@Ctx() ctx: TenantContext) {
    return this.fees.list(ctx);
  }

  @Post('fee-schedule')
  @Audited(AuditAction.FeeScheduleChanged)
  @RequirePermission('admin.settings')
  createFee(@Ctx() ctx: TenantContext, @Body() body: FeeScheduleDto) {
    return this.fees.create(ctx, body);
  }

  @Delete('fee-schedule/:id')
  @Audited(AuditAction.FeeScheduleChanged)
  @RequirePermission('admin.settings')
  removeFee(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.fees.remove(ctx, id);
  }
}
