import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PaymentMethod } from '../../generated/prisma/enums.js';
import {
  Ctx,
  NoRequestTransaction,
  RequirePermission,
  RequireReauth,
} from '../identity/decorators/auth.decorators.js';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { ringgitToSen } from '../billing/money.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { CashSessionService } from './cash-session.service.js';
import { PaymentService } from './payment.service.js';
import { ReceiptService } from './receipt.service.js';
import {
  CloseSessionDto,
  MovementDto,
  OpenSessionDto,
  PaymentMethodConfigDto,
  PaymentPreviewDto,
  RefundDto,
  ReopenSessionDto,
  SessionQueryDto,
  TakePaymentDto,
  VoidPaymentDto,
} from './dto/payment.dto.js';

/** Ringgit as typed on a form, to the sen this system stores. */
const sen = (ringgit: number | undefined): bigint | null =>
  ringgit === undefined ? null : ringgitToSen(ringgit);

@Controller()
export class PaymentController {
  constructor(
    private readonly db: DbService,
    private readonly sessions: CashSessionService,
    private readonly payments: PaymentService,
    private readonly receipts: ReceiptService,
  ) {}

  // ----------------------------------------------------- the drawer

  @Get('branches/:branchId/cash-sessions/current')
  @RequirePermission('payment.take')
  current(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query() query: SessionQueryDto,
  ) {
    return this.sessions.current(ctx, branchId, query.drawerCode ?? 'MAIN');
  }

  @Get('branches/:branchId/cash-sessions')
  @RequirePermission('eod.close')
  list(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Query() query: SessionQueryDto,
  ) {
    return this.sessions.list(ctx, branchId, query.days ?? 30);
  }

  @Post('branches/:branchId/cash-sessions')
  @Audited(AuditAction.CashSessionOpened)
  @RequirePermission('eod.close')
  open(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: OpenSessionDto,
  ) {
    return this.sessions.open(ctx, branchId, {
      floatAmount: ringgitToSen(body.float),
      drawerCode: body.drawerCode,
    });
  }

  @Post('cash-sessions/:id/suspend')
  @HttpCode(200)
  @Audited(AuditAction.CashSessionOpened)
  @RequirePermission('eod.close')
  suspend(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.sessions.suspend(ctx, id);
  }

  @Post('cash-sessions/:id/resume')
  @HttpCode(200)
  @Audited(AuditAction.CashSessionOpened)
  @RequirePermission('eod.close')
  resume(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.sessions.resume(ctx, id);
  }

  @Post('cash-sessions/:id/movements')
  @HttpCode(200)
  @Audited(AuditAction.CashMovementRecorded)
  @RequirePermission('eod.close')
  movement(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: MovementDto,
  ) {
    return this.sessions.recordMovement(ctx, id, {
      type: body.type,
      amount: ringgitToSen(body.amount),
      reason: body.reason,
    });
  }

  @Get('cash-sessions/:id/preview-close')
  @RequirePermission('eod.close')
  previewClose(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.sessions.previewClose(ctx, id);
  }

  @Post('cash-sessions/:id/close')
  @HttpCode(200)
  @Audited(AuditAction.CashSessionClosed)
  @RequirePermission('eod.close')
  close(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: CloseSessionDto,
  ) {
    return this.sessions.close(ctx, id, {
      countedCash: ringgitToSen(body.counted),
      denominations: body.denominations ?? null,
      note: body.note ?? null,
      approve: body.approve,
    });
  }

  @Post('cash-sessions/:id/reopen')
  @HttpCode(200)
  @Audited(AuditAction.CashSessionReopened)
  @RequirePermission('admin.settings')
  @RequireReauth()
  reopen(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ReopenSessionDto,
  ) {
    return this.sessions.reopen(ctx, id, body.reason);
  }

  @Get('cash-sessions/:id/z-report')
  @RequirePermission('eod.close')
  zReport(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.sessions.zReport(ctx, id);
  }

  // ---------------------------------------------------- taking money

  @Get('invoices/:id/payment-preview')
  @RequirePermission('payment.take')
  preview(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: PaymentPreviewDto,
  ) {
    return this.payments.preview(ctx, id, query.method, sen(query.amount));
  }

  @Post('invoices/:id/payments')
  @Audited(AuditAction.PaymentReceived)
  @RequirePermission('payment.take')
  take(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: TakePaymentDto,
  ) {
    return this.payments.take(ctx, id, {
      method: body.method,
      amountSen: sen(body.amount),
      tenderedSen: sen(body.tendered),
      reference: body.reference ?? null,
      cardBrand: body.cardBrand ?? null,
      idempotencyKey: body.idempotencyKey,
      drawerCode: body.drawerCode,
    });
  }

  @Get('invoices/:id/payments')
  @RequirePermission('invoice.read')
  forInvoice(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.payments.forInvoice(ctx, id);
  }

  @Post('payments/:id/void')
  @HttpCode(200)
  @Audited(AuditAction.PaymentVoided)
  @RequirePermission('payment.void')
  @RequireReauth()
  voidPayment(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: VoidPaymentDto,
  ) {
    return this.payments.void(ctx, id, body.reason);
  }

  @Post('invoices/:id/refunds')
  @Audited(AuditAction.PaymentRefunded)
  @RequirePermission('payment.void')
  @RequireReauth()
  refund(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: RefundDto,
  ) {
    return this.payments.refund(ctx, id, {
      amountSen: ringgitToSen(body.amount),
      method: body.method,
      reason: body.reason,
      refundOfId: body.refundOfId ?? null,
      idempotencyKey: body.idempotencyKey,
      drawerCode: body.drawerCode,
    });
  }

  @Get('branches/:branchId/outstanding')
  @RequirePermission('invoice.read')
  outstanding(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    return this.payments.outstandingAt(ctx, branchId);
  }

  // -------------------------------------------------------- receipts

  @Get('payments/:id/receipt')
  @NoRequestTransaction(
    'renders and stores the receipt outside any transaction (DOC-R-07)',
  )
  @RequirePermission('payment.take')
  receipt(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.receipts.build(ctx, id);
  }

  @Post('payments/:id/receipt/reprint')
  @HttpCode(200)
  @Audited(AuditAction.ReceiptReprinted)
  @RequirePermission('payment.take')
  reprint(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.payments.markPrinted(ctx, id);
  }

  // ---------------------------------------------------------- admin

  @Get('branches/:branchId/payment-methods')
  @RequirePermission('payment.take')
  methods(@Ctx() ctx: TenantContext, @Param('branchId') branchId: string) {
    void ctx;
    return this.db
      .tx()
      .paymentMethodConfig.findMany({
        where: { branchId },
        orderBy: { sortOrder: 'asc' },
      })
      .then((rows) => ({
        // A branch nobody has configured takes cash, which is what a
        // clinic on its first morning needs (§14).
        items:
          rows.length > 0
            ? rows
            : [
                {
                  branchId,
                  method: PaymentMethod.CASH,
                  enabled: true,
                  requiresReference: false,
                  displayName: 'Cash',
                  sortOrder: 0,
                  qrPayload: null,
                },
              ],
        configured: rows.length > 0,
      }));
  }

  @Put('branches/:branchId/payment-methods')
  @HttpCode(200)
  @Audited(AuditAction.PaymentMethodsChanged)
  @RequirePermission('admin.settings')
  async setMethods(
    @Ctx() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() body: { methods: PaymentMethodConfigDto[] },
  ) {
    void ctx;
    const tx = this.db.tx();
    for (const method of body.methods ?? []) {
      await tx.paymentMethodConfig.upsert({
        where: { branchId_method: { branchId, method: method.method } },
        create: {
          tenantId: requireTenantId(),
          branchId,
          method: method.method,
          enabled: method.enabled,
          requiresReference: method.requiresReference ?? false,
          displayName: method.displayName ?? null,
          sortOrder: method.sortOrder ?? 0,
          qrPayload: method.qrPayload ?? null,
        },
        update: {
          enabled: method.enabled,
          requiresReference: method.requiresReference ?? false,
          displayName: method.displayName ?? null,
          sortOrder: method.sortOrder ?? 0,
          qrPayload: method.qrPayload ?? null,
        },
      });
    }
    return this.methods(ctx, branchId);
  }
}
