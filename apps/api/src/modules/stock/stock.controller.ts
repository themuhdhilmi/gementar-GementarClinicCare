import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited, NotAudited } from '../audit/audit.decorators.js';
import { StockMovementType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { StockService } from './stock.service.js';
import { StockCountService } from './stock-count.service.js';
import { StockAlertService } from './alert.service.js';
import { StockImportService } from './stock-import.service.js';
import { StockReconciliationJob } from './reconciliation.job.js';
import { MOVEMENT_LABEL, REASON_CODES } from './movement-kinds.js';
import type { ReasonCode } from './movement-kinds.js';
import {
  AcknowledgeAlertDto,
  AdjustmentDto,
  BlockBatchDto,
  CountEntryDto,
  CountReasonDto,
  ExpiryWriteOffDto,
  MovementQueryDto,
  OpenCountDto,
  ReleaseQuarantineDto,
  StockInDto,
} from './dto/stock.dto.js';

@Controller()
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly reconciliation: StockReconciliationJob,
    private readonly counts: StockCountService,
    private readonly alerts: StockAlertService,
    private readonly imports: StockImportService,
    private readonly db: DbService,
  ) {}

  /** The closed lists the screens build their selects from. */
  @Get('stock/options')
  @RequirePermission('stock.read')
  options(@Ctx() ctx: TenantContext) {
    void ctx;
    return {
      reasonCodes: REASON_CODES,
      movementTypes: Object.entries(MOVEMENT_LABEL).map(([type, label]) => ({ type, label })),
    };
  }

  /** INV-F-18. */
  @Get('branches/:branchId/stock')
  @RequirePermission('stock.read')
  onHand(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('belowMin') belowMin?: string,
    @Query('expiringDays') expiringDays?: string,
    @Query('q') q?: string,
  ) {
    return this.stock.onHandView(ctx, branchId, {
      belowMin: belowMin === 'true',
      expiringDays: expiringDays ? Number(expiringDays) : undefined,
      q,
    });
  }

  @Get('branches/:branchId/batches')
  @RequirePermission('stock.read')
  batches(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('productId') productId: string,
  ) {
    if (!productId) throw new BadRequestError('Which product?', 'product_required');
    return this.stock.batches(ctx, branchId, productId);
  }

  /** What FEFO would pick, shown before anything is committed. */
  @Get('branches/:branchId/fefo')
  @RequirePermission('stock.read')
  fefo(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('productId') productId: string,
    @Query('quantity') quantity: string,
  ) {
    const wanted = Number(quantity);
    if (!productId || !(wanted > 0)) {
      throw new BadRequestError('Which product, and how much?', 'invalid_request');
    }
    return this.stock.fefo(ctx, branchId, productId, wanted);
  }

  /** INV-F-17. */
  @Get('branches/:branchId/movements')
  @RequirePermission('stock.read')
  movements(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query() query: MovementQueryDto,
  ) {
    return this.stock.movements(ctx, branchId, {
      productId: query.productId,
      batchId: query.batchId,
      type: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  }

  /** INV-F-12. */
  @Post('branches/:branchId/stock-in')
  @Audited(AuditAction.StockReceived)
  @RequirePermission('stock.receive')
  receive(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: StockInDto,
  ) {
    return this.stock.receive(ctx, branchId, body);
  }

  /** INV-F-13. */
  @Post('branches/:branchId/adjustments')
  @Audited(AuditAction.StockAdjusted)
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  adjust(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: AdjustmentDto,
  ) {
    return this.stock.adjust(ctx, branchId, {
      batchId: body.batchId,
      type: body.type as StockMovementType,
      quantity: body.quantity,
      reasonCode: body.reasonCode as ReasonCode,
      reasonText: body.reasonText ?? null,
    });
  }

  /** INV-F-14. */
  @Post('branches/:branchId/expiry-writeoff')
  @Audited(AuditAction.StockExpiryWrittenOff)
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  writeOff(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: ExpiryWriteOffDto,
  ) {
    return this.stock.writeOffExpired(ctx, branchId, body);
  }

  /** A recall. Loud, and only an administrator. */
  @Post('batches/:id/block')
  @Audited(AuditAction.BatchBlocked)
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  block(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: BlockBatchDto) {
    return this.stock.blockBatch(ctx, id, body.reason);
  }

  // ------------------------------------------------- counts (INV-F-16)

  @Get('branches/:branchId/counts')
  @RequirePermission('stock.count')
  listCounts(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.counts.list(ctx, branchId);
  }

  /** Freezes what the system expects, before anybody starts counting. */
  @Post('branches/:branchId/counts')
  @Audited(AuditAction.StockCountOpened)
  @RequirePermission('stock.count')
  openCount(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: OpenCountDto,
  ) {
    return this.counts.open(ctx, branchId, {
      type: body.type,
      blind: body.blind,
      notes: body.notes ?? null,
      scope: { categoryIds: body.categoryIds, productIds: body.productIds },
    });
  }

  @Get('counts/:id')
  @RequirePermission('stock.count')
  readCount(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.counts.read(ctx, id);
  }

  @Put('counts/:id/lines')
  @NotAudited('blind entry into an open count; the count is recorded when it is submitted and again when it is approved')
  @HttpCode(200)
  @RequirePermission('stock.count')
  enterCount(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: CountEntryDto) {
    return this.counts.enter(ctx, id, body.lines);
  }

  @Post('counts/:id/submit')
  @Audited(AuditAction.StockCountSubmitted)
  @HttpCode(200)
  @RequirePermission('stock.count')
  submitCount(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.counts.submit(ctx, id);
  }

  /** Posts one adjustment per line that disagrees. */
  @Post('counts/:id/approve')
  @Audited(AuditAction.StockCountApproved)
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  approveCount(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.counts.approve(ctx, id);
  }

  @Post('counts/:id/cancel')
  @Audited(AuditAction.StockCountCancelled)
  @HttpCode(200)
  @RequirePermission('stock.count')
  cancelCount(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: CountReasonDto) {
    return this.counts.cancel(ctx, id, body.reason);
  }

  /**
   * INV-OPEN-02: an opening count from a spreadsheet.
   *
   * Nothing is written unless the run says so in so many words, and
   * even then it fills in a count rather than posting stock — so the
   * same person still has to approve it.
   */
  @Post('branches/:branchId/counts/import')
  @Audited(AuditAction.StockCountImported)
  @HttpCode(200)
  @RequirePermission('stock.count')
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: 20_000_000 } }))
  async importCount(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Query('dryRun') dryRun?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestError('No file was uploaded.', 'file_missing');
    }
    const csv = file.buffer.toString('utf8');
    return dryRun !== 'false'
      ? this.imports.preview(ctx, branchId, csv)
      : this.imports.apply(ctx, branchId, csv);
  }

  // ----------------------------------------- alerts (INV-F-19, F-20)

  @Get('branches/:branchId/alerts')
  @RequirePermission('stock.read')
  alertsFor(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('includeAcknowledged') includeAcknowledged?: string,
  ) {
    return this.alerts.list(ctx, branchId, {
      includeAcknowledged: includeAcknowledged === 'true',
    });
  }

  @Post('branches/:branchId/alerts/acknowledge')
  @Audited(AuditAction.StockAlertAcknowledged)
  @HttpCode(200)
  @RequirePermission('stock.read')
  acknowledge(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: AcknowledgeAlertDto,
  ) {
    return this.alerts.acknowledge(ctx, branchId, body.productId, body.kind);
  }

  // ------------------------------------------- quarantine (INV-F-15)

  @Get('branches/:branchId/quarantine')
  @RequirePermission('stock.read')
  quarantine(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.stock.quarantine(ctx, branchId);
  }

  @Post('branches/:branchId/quarantine/:batchId/release')
  @Audited(AuditAction.StockQuarantineReleased)
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  release(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Param('batchId') batchId: string,
    @Body() body: ReleaseQuarantineDto,
  ) {
    return this.stock.releaseQuarantine(ctx, branchId, batchId, body);
  }

  /** INV-F-22: what to order, and how long what is here will last. */
  @Get('branches/:branchId/reorder-suggestions')
  @RequirePermission('stock.read')
  reorder(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query('days') days?: string,
  ) {
    return this.stock.reorderSuggestions(ctx, branchId, days ? Number(days) : 90);
  }

  /**
   * INV-F-21 on demand. The nightly run is the one that matters; this is
   * for the morning somebody wants to know before tomorrow.
   */
  @Post('admin/stock-reconciliation')
  @Audited(AuditAction.StockReconciled)
  @HttpCode(200)
  @RequirePermission('admin.settings')
  async reconcile(@Ctx() ctx: TenantContext) {
    void ctx;
    const tx = this.db.tx();
    const result = await this.reconciliation.verify(tx);
    return {
      checked: result.checked,
      mismatches: result.mismatches,
      // Said in words, because "0 mismatches" and "nothing was checked"
      // look the same on a dashboard.
      summary:
        result.mismatches.length === 0
          ? `${result.checked} batches checked, every one balanced.`
          : `${result.mismatches.length} of ${result.checked} batches do not match their movements. Nothing has been corrected.`,
    };
  }

  @Get('admin/reconciliation-runs')
  @RequirePermission('admin.settings')
  async runs(@Ctx() ctx: TenantContext) {
    void ctx;
    const tx = this.db.tx();
    return {
      items: await tx.reconciliationRun.findMany({ orderBy: { runAt: 'desc' }, take: 30 }),
    };
  }
}
