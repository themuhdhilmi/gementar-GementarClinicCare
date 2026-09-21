import { Injectable, Logger } from '@nestjs/common';
import { BatchStatus, StockMovementType } from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  InvariantViolationError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DIRECTION, NEEDS_REASON, type ReasonCode } from './movement-kinds.js';
import { StockAlertService } from './alert.service.js';

/** INV-F-09: what a product with no lot number gets, once per branch. */
export const NON_BATCHED = 'NB';

export type MoveInput = {
  batchId: string;
  type: StockMovementType;
  /**
   * Always positive. The type decides the sign — see `DIRECTION`. The one
   * exception is COUNT_ADJUST, where the variance may go either way and
   * `signedQuantity` is passed instead.
   */
  quantity?: number;
  /** For a count, where the variance carries its own sign. */
  signedQuantity?: number;
  referenceType?: string | null;
  referenceId?: string | null;
  reasonCode?: ReasonCode | null;
  reasonText?: string | null;
};

export type FefoPick = {
  batchId: string;
  batchNo: string;
  expiryDate: Date | null;
  quantity: number;
  available: number;
};

/**
 * The only write path to stock (INV-F-11, INV-R-02).
 *
 * Every module that moves stock calls `move()` inside its own
 * transaction: dispensing, procedures, receiving, adjustments, counts.
 * Nothing writes `stock_movement` or `quantity_on_hand` any other way,
 * and the nightly reconciliation exists to notice if something ever does.
 *
 * The method is deliberately small and deliberately strict. It locks the
 * batch before computing anything, because two nurses consuming the last
 * two of something at the same instant is not a hypothetical. It records
 * `balance_after` on every row, so the ledger can be read without
 * replaying it. And it refuses to take more than is there, rather than
 * writing a negative that somebody discovers at a stock count.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    private readonly clock: Clock,
    private readonly events: EventBus,
    private readonly alerts: StockAlertService,
  ) {}

  /**
   * INV-R-01, R-03, R-04, R-05. Runs inside the caller's transaction, so
   * a procedure that fails after consuming does not consume.
   */
  async move(tx: Tx, ctx: TenantContext, input: MoveInput) {
    const direction = DIRECTION[input.type];
    const signed =
      input.signedQuantity !== undefined
        ? round3(input.signedQuantity)
        : round3((input.quantity ?? 0) * direction);

    if (signed === 0) {
      throw new BadRequestError('A movement of nothing is not a movement.', 'zero_movement');
    }
    if (input.quantity !== undefined && input.quantity < 0) {
      throw new BadRequestError(
        'Quantities are positive; the kind of movement decides the direction.',
        'negative_quantity',
      );
    }
    if (NEEDS_REASON.has(input.type) && !input.reasonCode) {
      throw new BadRequestError(
        'An adjustment needs a reason, or the stock report cannot be read.',
        'reason_required',
      );
    }

    // INV-R-03. The lock comes first, before anything is read that the
    // decision depends on.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM product_batch WHERE id = ${input.batchId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Batch');

    const batch = await tx.productBatch.findFirst({ where: { id: input.batchId } });
    if (!batch) throw new NotFoundError('Batch');

    const before = Number(batch.quantityOnHand);
    const after = round3(before + signed);

    if (after < 0) {
      throw new InvariantViolationError(
        'insufficient_stock',
        `There are ${fmt(before)} of batch ${batch.batchNo} on the shelf, and this would take ${fmt(-signed)}.`,
        { batchId: batch.id, batchNo: batch.batchNo, onHand: before, requested: -signed },
      );
    }

    const movement = await tx.stockMovement.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        branchId: batch.branchId,
        productId: batch.productId,
        batchId: batch.id,
        type: input.type,
        quantity: signed,
        unitCost: batch.costPrice,
        balanceAfter: after,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        reasonCode: input.reasonCode ?? null,
        reasonText: input.reasonText ?? null,
        performedBy: ctx.userId,
        performedByName: ctx.userName,
        occurredAt: this.clock.now(),
      },
    });

    // Written in the same statement pair as the movement, under the same
    // lock. The trigger derives the batch status from the new quantity.
    await tx.productBatch.update({
      where: { id: batch.id },
      data: { quantityOnHand: after },
    });

    // INV-F-19, F-20: re-evaluated here, in the same transaction, because
    // an alert that arrives a minute later is an alert that arrives
    // after the last box has gone.
    await this.alerts.evaluate(tx, ctx, batch.branchId, batch.productId);

    this.events.publish({
      name: DomainEvent.StockMoved,
      tenantId: ctx.tenantId,
      branchId: batch.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: {
        batchId: batch.id,
        productId: batch.productId,
        type: input.type,
        quantity: signed,
        balanceAfter: after,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
      },
    });

    return { movement, batch: { ...batch, quantityOnHand: after }, before, after };
  }

  /**
   * INV-F-11, INV-R-07: which batches to take from, oldest expiry first.
   *
   * First to expire, not first in: a delivery that arrives today with a
   * short date should go out before one received last month with a long
   * one, or it expires on the shelf. Expired and blocked batches are not
   * offered at all — a recall is not a suggestion.
   *
   * Returns nothing if the branch cannot cover the quantity, rather than
   * a partial plan, because the caller has to decide what to do about a
   * shortfall and a half-filled list hides it.
   */
  async suggestFefo(
    tx: Tx,
    branchId: string,
    productId: string,
    quantity: number,
  ): Promise<{ picks: FefoPick[]; shortfall: number }> {
    const batches = await tx.productBatch.findMany({
      where: {
        branchId,
        productId,
        status: { in: [BatchStatus.ACTIVE] },
        quantityOnHand: { gt: 0 },
      },
      orderBy: [
        // Nulls last: a non-batched product has no expiry and should be
        // taken from only when nothing dated is available.
        { expiryDate: { sort: 'asc', nulls: 'last' } },
        { receivedAt: 'asc' },
      ],
    });

    const picks: FefoPick[] = [];
    let left = round3(quantity);

    for (const batch of batches) {
      if (left <= 0) break;
      // A batch that expires today is not usable today.
      if (batch.expiryDate && batch.expiryDate < this.startOfToday()) continue;

      const available = Number(batch.quantityOnHand);
      const take = Math.min(available, left);
      picks.push({
        batchId: batch.id,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        quantity: round3(take),
        available,
      });
      left = round3(left - take);
    }

    return { picks, shortfall: Math.max(0, left) };
  }

  /**
   * INV-F-09: the batch a product with no lot number moves through.
   *
   * Created on demand rather than up front, because most of the catalogue
   * is never stocked at most branches and a row per product per branch
   * would be mostly zeroes.
   */
  async nonBatched(tx: Tx, ctx: TenantContext, branchId: string, productId: string) {
    const existing = await tx.productBatch.findFirst({
      where: { branchId, productId, batchNo: NON_BATCHED },
    });
    if (existing) return existing;

    const product = await tx.product.findFirst({ where: { id: productId } });
    if (!product) throw new NotFoundError('Product');
    if (product.isBatched) {
      throw new ConflictError(
        `${product.name} is tracked by batch, so it needs a batch number and an expiry date.`,
        'product_is_batched',
      );
    }

    return tx.productBatch.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        branchId,
        productId,
        batchNo: NON_BATCHED,
        expiryDate: null,
        costPrice: 0n,
        quantityOnHand: 0,
        sourceType: 'synthetic',
        createdBy: ctx.userId,
        receivedAt: this.clock.now(),
      },
    });
  }

  /** What is on the shelf at a branch, in total and by batch. */
  async onHand(tx: Tx, branchId: string, productId: string): Promise<number> {
    const rows = await tx.productBatch.aggregate({
      where: { branchId, productId, status: { in: [BatchStatus.ACTIVE] } },
      _sum: { quantityOnHand: true },
    });
    return Number(rows._sum.quantityOnHand ?? 0);
  }

  /** On-hand for many products at once, for a search result list. */
  async onHandFor(
    tx: Tx,
    branchId: string,
    productIds: readonly string[],
  ): Promise<Map<string, { onHand: number; nearestExpiry: Date | null }>> {
    if (productIds.length === 0) return new Map();

    const rows = await tx.productBatch.findMany({
      where: {
        branchId,
        productId: { in: [...productIds] },
        status: BatchStatus.ACTIVE,
        quantityOnHand: { gt: 0 },
      },
      select: { productId: true, quantityOnHand: true, expiryDate: true },
    });

    const out = new Map<string, { onHand: number; nearestExpiry: Date | null }>();
    for (const row of rows) {
      const current = out.get(row.productId) ?? { onHand: 0, nearestExpiry: null };
      current.onHand = round3(current.onHand + Number(row.quantityOnHand));
      if (
        row.expiryDate &&
        (current.nearestExpiry === null || row.expiryDate < current.nearestExpiry)
      ) {
        current.nearestExpiry = row.expiryDate;
      }
      out.set(row.productId, current);
    }
    return out;
  }

  private startOfToday(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(round3(value));
}
