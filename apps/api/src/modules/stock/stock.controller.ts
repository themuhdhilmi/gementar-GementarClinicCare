import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { StockMovementType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { StockService } from './stock.service.js';
import { StockReconciliationJob } from './reconciliation.job.js';
import { MOVEMENT_LABEL, REASON_CODES } from './movement-kinds.js';
import type { ReasonCode } from './movement-kinds.js';
import {
  AdjustmentDto,
  BlockBatchDto,
  ExpiryWriteOffDto,
  MovementQueryDto,
  StockInDto,
} from './dto/stock.dto.js';

@Controller()
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly reconciliation: StockReconciliationJob,
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
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  block(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() body: BlockBatchDto) {
    return this.stock.blockBatch(ctx, id, body.reason);
  }

  /**
   * INV-F-21 on demand. The nightly run is the one that matters; this is
   * for the morning somebody wants to know before tomorrow.
   */
  @Post('admin/stock-reconciliation')
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
