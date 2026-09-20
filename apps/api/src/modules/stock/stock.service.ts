import { Injectable, Logger } from '@nestjs/common';
import { BatchStatus, StockMovementType } from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
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
import { toSen, fromSen } from '../catalogue/money.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { LedgerService, NON_BATCHED, round3 } from './ledger.service.js';
import { MOVEMENT_LABEL, REASON_CODES, type ReasonCode } from './movement-kinds.js';

export type StockInLine = {
  productId: string;
  batchNo?: string | null;
  /** `YYYY-MM` is accepted and becomes the last day of that month. */
  expiry?: string | null;
  quantity: number;
  /** Ringgit per dispensing unit, as typed. */
  costPrice?: number | null;
  sellingPrice?: number | null;
  barcode?: string | null;
};

export type AdjustmentInput = {
  batchId: string;
  type: StockMovementType;
  quantity: number;
  reasonCode: ReasonCode;
  reasonText?: string | null;
};

const ADJUSTMENT_TYPES = new Set<StockMovementType>([
  StockMovementType.ADJUST_IN,
  StockMovementType.ADJUST_OUT,
  StockMovementType.DAMAGE,
  StockMovementType.EXPIRE,
  StockMovementType.RETURN_TO_SUPPLIER,
]);

/**
 * Stock at a branch: getting it in, correcting it, writing it off and
 * looking at it.
 *
 * Every quantity change here goes through `LedgerService.move()`, the
 * same way every other module's does. This service's job is the workflow
 * around it — creating the batch a delivery arrives in, deciding what an
 * expiry write-off covers, and presenting what is on the shelf.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly ledger: LedgerService,
  ) {}

  // -------------------------------------------------------------------
  // Getting stock in (INV-F-12)
  // -------------------------------------------------------------------

  /**
   * A delivery, as one transaction.
   *
   * All of it or none of it: a half-recorded delivery is worse than an
   * unrecorded one, because nobody knows which half.
   */
  async receive(
    ctx: TenantContext,
    branchId: string,
    input: { lines: StockInLine[]; supplierNote?: string | null; opening?: boolean },
  ) {
    if (input.lines.length === 0) {
      throw new BadRequestError('There is nothing on this delivery.', 'no_lines');
    }

    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);

    const reference = newId();
    const type = input.opening ? StockMovementType.OPENING : StockMovementType.RECEIVE;
    const received: Array<{ productId: string; batchId: string; batchNo: string; quantity: number }> = [];

    for (const line of input.lines) {
      if (!(line.quantity > 0)) {
        throw new BadRequestError('Every line needs a quantity.', 'invalid_quantity');
      }

      const product = await tx.product.findFirst({ where: { id: line.productId } });
      if (!product) throw new NotFoundError('Product');
      if (product.status !== 'ACTIVE') {
        throw new ConflictError(
          `${product.name} has been withdrawn from the catalogue.`,
          'product_retired',
        );
      }

      const batch = product.isBatched
        ? await this.batchFor(tx, ctx, branchId, product.id, line)
        : await this.ledger.nonBatched(tx, ctx, branchId, product.id);

      // A delivery at a new price updates the batch's cost, because cost
      // belongs to the batch. Movements already posted keep the cost they
      // were posted at.
      if (line.costPrice !== undefined && line.costPrice !== null) {
        await tx.productBatch.update({
          where: { id: batch.id },
          data: { costPrice: toSen(line.costPrice) },
        });
      }

      await this.ledger.move(tx, ctx, {
        batchId: batch.id,
        type,
        quantity: line.quantity,
        referenceType: 'stock_in',
        referenceId: reference,
        ...(input.opening ? { reasonCode: 'opening_balance' as const } : {}),
        reasonText: input.supplierNote ?? null,
      });

      received.push({
        productId: product.id,
        batchId: batch.id,
        batchNo: batch.batchNo,
        quantity: line.quantity,
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: input.opening ? AuditAction.StockOpeningPosted : AuditAction.StockReceived,
      entityType: 'stock_in',
      entityId: reference,
      after: { lines: received, supplierNote: input.supplierNote ?? null },
    });

    return { reference, lines: received };
  }

  /**
   * The batch a line arrives in: the one with that number, or a new one.
   *
   * Two deliveries of the same lot go into the same batch, which is the
   * point of recording a lot number. A delivery with no number given is
   * refused for a batched product rather than quietly merged into one
   * called "unknown" — that is how a recall becomes impossible.
   */
  private async batchFor(
    tx: Tx,
    ctx: TenantContext,
    branchId: string,
    productId: string,
    line: StockInLine,
  ) {
    const batchNo = (line.batchNo ?? '').trim();
    if (!batchNo) {
      throw new BadRequestError(
        'This product is tracked by batch, so the delivery needs its batch number.',
        'batch_no_required',
      );
    }
    if (batchNo.toUpperCase() === NON_BATCHED) {
      throw new BadRequestError(
        `"${NON_BATCHED}" is reserved for products that have no batch number.`,
        'reserved_batch_no',
      );
    }

    const expiry = parseExpiry(line.expiry);
    if (!expiry) {
      throw new BadRequestError(
        'This product is tracked by batch, so the delivery needs an expiry date.',
        'expiry_required',
      );
    }
    if (expiry < this.today()) {
      throw new BadRequestError(
        `That batch expired on ${expiry.toISOString().slice(0, 10)}. It cannot be received into stock.`,
        'already_expired',
      );
    }

    const existing = await tx.productBatch.findFirst({
      where: { branchId, productId, batchNo },
    });
    if (existing) {
      if (existing.status === BatchStatus.BLOCKED) {
        throw new ConflictError(
          `Batch ${batchNo} is blocked, so nothing can be added to it.`,
          'batch_blocked',
        );
      }
      if (
        existing.expiryDate &&
        existing.expiryDate.toISOString().slice(0, 10) !== expiry.toISOString().slice(0, 10)
      ) {
        throw new ConflictError(
          `Batch ${batchNo} is already recorded as expiring on ` +
            `${existing.expiryDate.toISOString().slice(0, 10)}, not ` +
            `${expiry.toISOString().slice(0, 10)}. One of the two is wrong.`,
          'expiry_mismatch',
        );
      }
      return existing;
    }

    return tx.productBatch.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        branchId,
        productId,
        batchNo,
        expiryDate: expiry,
        costPrice: line.costPrice == null ? 0n : toSen(line.costPrice),
        sellingPrice: line.sellingPrice == null ? null : toSen(line.sellingPrice),
        barcode: line.barcode?.trim() || null,
        quantityOnHand: 0,
        sourceType: 'manual',
        createdBy: ctx.userId,
        receivedAt: this.clock.now(),
      },
    });
  }

  // -------------------------------------------------------------------
  // Correcting it (INV-F-13)
  // -------------------------------------------------------------------

  async adjust(ctx: TenantContext, branchId: string, input: AdjustmentInput) {
    if (!ADJUSTMENT_TYPES.has(input.type)) {
      throw new BadRequestError(
        `${input.type} is not something a person posts by hand.`,
        'not_an_adjustment',
      );
    }
    if (!REASON_CODES.includes(input.reasonCode)) {
      throw new BadRequestError(`"${input.reasonCode}" is not a reason.`, 'invalid_reason');
    }

    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);

    const batch = await tx.productBatch.findFirst({ where: { id: input.batchId, branchId } });
    if (!batch) throw new NotFoundError('Batch');

    const result = await this.ledger.move(tx, ctx, {
      batchId: batch.id,
      type: input.type,
      quantity: input.quantity,
      referenceType: 'adjustment',
      referenceId: newId(),
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
    });

    // INV-R-08 asks for reauth above a value threshold. The threshold is
    // a tenant setting that does not exist yet, so the audit entry
    // carries the value and `INV-OPEN-05` tracks the gate.
    const valueSen = Math.round(Math.abs(Number(result.movement.quantity)) * Number(batch.costPrice));

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockAdjusted,
      entityType: 'product_batch',
      entityId: batch.id,
      reason: input.reasonText ?? input.reasonCode,
      before: { quantityOnHand: result.before },
      after: {
        quantityOnHand: result.after,
        type: input.type,
        reasonCode: input.reasonCode,
        valueRinggit: fromSen(BigInt(valueSen)),
      },
    });

    return this.presentBatch({ ...batch, quantityOnHand: result.after as unknown as never });
  }

  /** INV-F-14: everything past its date, written off together. */
  async writeOffExpired(
    ctx: TenantContext,
    branchId: string,
    input: { batchIds: string[]; note?: string | null },
  ) {
    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);

    const written: Array<{ batchId: string; batchNo: string; quantity: number }> = [];
    for (const batchId of input.batchIds) {
      const batch = await tx.productBatch.findFirst({ where: { id: batchId, branchId } });
      if (!batch) throw new NotFoundError('Batch');

      const onHand = Number(batch.quantityOnHand);
      if (onHand <= 0) continue;
      if (!batch.expiryDate || batch.expiryDate >= this.today()) {
        throw new ConflictError(
          `Batch ${batch.batchNo} has not expired. Use an adjustment with a reason instead.`,
          'not_expired',
        );
      }

      await this.ledger.move(tx, ctx, {
        batchId: batch.id,
        type: StockMovementType.EXPIRE,
        quantity: onHand,
        referenceType: 'expiry_writeoff',
        referenceId: batch.id,
        reasonCode: 'expired',
        reasonText: input.note ?? null,
      });
      written.push({ batchId: batch.id, batchNo: batch.batchNo, quantity: onHand });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockExpiryWrittenOff,
      entityType: 'branch',
      entityId: branchId,
      after: { batches: written, note: input.note ?? null },
    });

    return { written };
  }

  /** A recall. The batch stops being usable and nothing can be added to it. */
  async blockBatch(ctx: TenantContext, batchId: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say why this batch is being blocked, in a sentence.',
        'reason_required',
      );
    }

    const tx = this.db.tx();
    const batch = await tx.productBatch.findFirst({ where: { id: batchId } });
    if (!batch) throw new NotFoundError('Batch');

    await tx.productBatch.update({
      where: { id: batchId },
      data: { status: BatchStatus.BLOCKED },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BatchBlocked,
      entityType: 'product_batch',
      entityId: batchId,
      reason: reason.trim(),
      after: { status: BatchStatus.BLOCKED, onHand: Number(batch.quantityOnHand) },
    });

    this.events.publish({
      name: DomainEvent.BatchBlocked,
      tenantId: ctx.tenantId,
      branchId: batch.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { batchId, productId: batch.productId, reason: reason.trim() },
    });

    return this.presentBatch(await tx.productBatch.findFirstOrThrow({ where: { id: batchId } }));
  }

  // -------------------------------------------------------------------
  // Looking at it (INV-F-17, INV-F-18)
  // -------------------------------------------------------------------

  /**
   * INV-F-18: what is on the shelf, per product, with the batches under
   * it and the nearest date something goes off.
   */
  async onHandView(
    ctx: TenantContext,
    branchId: string,
    options: { belowMin?: boolean; expiringDays?: number; q?: string } = {},
  ) {
    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);

    const batches = await tx.productBatch.findMany({
      where: {
        branchId,
        ...(options.expiringDays
          ? { expiryDate: { lte: this.inDays(options.expiringDays) }, quantityOnHand: { gt: 0 } }
          : {}),
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }],
    });

    const productIds = [...new Set(batches.map((b) => b.productId))];
    if (productIds.length === 0) return { items: [] };

    const [products, settings] = await Promise.all([
      tx.product.findMany({
        where: {
          id: { in: productIds },
          ...(options.q && options.q.trim().length >= 2
            ? { searchText: { contains: options.q.trim().toLowerCase() } }
            : {}),
        },
      }),
      tx.productBranchSetting.findMany({ where: { branchId, productId: { in: productIds } } }),
    ]);

    const settingFor = new Map(settings.map((s) => [s.productId, s]));
    const items = products
      .map((product) => {
        const own = batches.filter((batch) => batch.productId === product.id);
        const onHand = round3(
          own
            .filter((batch) => batch.status === BatchStatus.ACTIVE)
            .reduce((sum, batch) => sum + Number(batch.quantityOnHand), 0),
        );
        const setting = settingFor.get(product.id);
        const reorderLevel = setting?.reorderLevel == null ? null : Number(setting.reorderLevel);
        const minStock = setting?.minStock == null ? null : Number(setting.minStock);

        return {
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            genericName: product.genericName,
            strengthText: product.strengthText,
            dispenseUnit: product.dispenseUnit,
            isColdChain: product.isColdChain,
            isControlled: product.isControlled,
          },
          onHand,
          minStock,
          reorderLevel,
          belowMin: minStock !== null && onHand <= minStock,
          belowReorder: reorderLevel !== null && onHand <= reorderLevel,
          nearestExpiry:
            own
              .filter((batch) => batch.quantityOnHand.toString() !== '0' && batch.expiryDate)
              .map((batch) => batch.expiryDate!)
              .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
          batches: own.map((batch) => this.presentBatch(batch)),
        };
      })
      .filter((row) => (options.belowMin ? row.belowMin || row.belowReorder : true))
      .sort((a, b) => a.product.name.localeCompare(b.product.name));

    return { items };
  }

  /** INV-F-17: the ledger, read forwards, with the balance it left behind. */
  async movements(
    ctx: TenantContext,
    branchId: string,
    options: {
      productId?: string;
      batchId?: string;
      type?: StockMovementType;
      from?: Date;
      to?: Date;
      limit?: number;
    } = {},
  ) {
    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);

    const rows = await tx.stockMovement.findMany({
      where: {
        branchId,
        ...(options.productId ? { productId: options.productId } : {}),
        ...(options.batchId ? { batchId: options.batchId } : {}),
        ...(options.type ? { type: options.type } : {}),
        ...(options.from || options.to
          ? {
              occurredAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(options.limit ?? 200, 1000),
    });

    const batchIds = [...new Set(rows.map((row) => row.batchId))];
    const productIds = [...new Set(rows.map((row) => row.productId))];
    const [batches, products] = await Promise.all([
      tx.productBatch.findMany({
        where: { id: { in: batchIds } },
        select: { id: true, batchNo: true, expiryDate: true },
      }),
      tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, dispenseUnit: true },
      }),
    ]);
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        label: MOVEMENT_LABEL[row.type],
        quantity: Number(row.quantity),
        balanceAfter: Number(row.balanceAfter),
        unitCost: fromSen(row.unitCost),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        reasonCode: row.reasonCode,
        reasonText: row.reasonText,
        performedByName: row.performedByName,
        occurredAt: row.occurredAt,
        batch: batchById.get(row.batchId) ?? null,
        product: productById.get(row.productId) ?? null,
      })),
    };
  }

  async batches(ctx: TenantContext, branchId: string, productId: string) {
    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);
    const rows = await tx.productBatch.findMany({
      where: { branchId, productId },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }],
    });
    return { items: rows.map((row) => this.presentBatch(row)) };
  }

  /** What FEFO would choose, so a screen can show it before committing. */
  async fefo(ctx: TenantContext, branchId: string, productId: string, quantity: number) {
    const tx = this.db.tx();
    await this.assertBranch(tx, ctx, branchId);
    return this.ledger.suggestFefo(tx, branchId, productId, quantity);
  }

  // -------------------------------------------------------------------

  private async assertBranch(tx: Tx, ctx: TenantContext, branchId: string) {
    if (!ctx.branchesWithRole.includes(branchId)) {
      throw new NotFoundError('Branch');
    }
    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: { id: true } });
    if (!branch) throw new NotFoundError('Branch');
  }

  private presentBatch(batch: {
    id: string;
    productId: string;
    branchId: string;
    batchNo: string;
    expiryDate: Date | null;
    costPrice: bigint;
    sellingPrice: bigint | null;
    quantityOnHand: unknown;
    quantityQuarantined: unknown;
    status: BatchStatus;
    receivedAt: Date;
    barcode: string | null;
  }) {
    return {
      id: batch.id,
      productId: batch.productId,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      costPrice: fromSen(batch.costPrice),
      sellingPrice: batch.sellingPrice === null ? null : fromSen(batch.sellingPrice),
      quantityOnHand: Number(batch.quantityOnHand),
      quantityQuarantined: Number(batch.quantityQuarantined),
      status: batch.status,
      receivedAt: batch.receivedAt,
      barcode: batch.barcode,
    };
  }

  private today(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private inDays(days: number): Date {
    return new Date(this.today().getTime() + days * 86_400_000);
  }
}

/**
 * INV-F-08: a month is a valid expiry, and it means the end of that month.
 *
 * Blister packs are stamped "03/2027", not with a day. Reading that as
 * the first of March throws away thirty days of usable stock; reading it
 * as the last day is what the manufacturer means.
 */
export function parseExpiry(value: string | null | undefined): Date | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const year = Number(month[1]);
    const monthIndex = Number(month[2]);
    if (monthIndex < 1 || monthIndex > 12) return null;
    // Day zero of the next month is the last day of this one.
    return new Date(Date.UTC(year, monthIndex, 0));
  }

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!day) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
