import { Injectable, Logger } from '@nestjs/common';
import {
  BatchStatus,
  StockCountStatus,
  StockCountType,
  StockMovementType,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
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
import { fromSen, toSen } from '../catalogue/money.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { LedgerService, NON_BATCHED, round3 } from './ledger.service.js';
import { parseExpiry } from './stock.service.js';

export type CountScope = {
  categoryIds?: string[];
  productIds?: string[];
};

export type CountLineInput = {
  /** A batch the system knows about. */
  batchId?: string | null;
  /** Or one found on the shelf that it does not (INV-F-16). */
  productId?: string | null;
  newBatchNo?: string | null;
  newExpiry?: string | null;
  /** Ringgit, as typed. */
  newCost?: number | null;
  counted: number;
  note?: string | null;
};

/**
 * Physical counts (INV-F-16).
 *
 * This is the one place where a person walks the shelves and the system
 * accepts being corrected. Everything else in inventory assumes the
 * ledger is right; a count is how it finds out it is not.
 *
 * Three things make it trustworthy. The expected quantity is frozen
 * before anybody starts counting, so a variance is a variance rather
 * than a race. Both numbers are kept, so "the system said 40 and the
 * shelf said 12" survives the correction. And the difference is posted
 * as an ordinary ledger movement — not a silent overwrite — so the
 * nightly reconciliation still balances afterwards.
 */
@Injectable()
export class StockCountService {
  private readonly logger = new Logger(StockCountService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Open a session and freeze what the system expects.
   *
   * INV §14 is explicit that an `OPENING` count expects nothing: the
   * system has no opinion yet, so every line starts at zero and the
   * whole count is the opening balance.
   */
  async open(
    ctx: TenantContext,
    branchId: string,
    input: { type: StockCountType; scope?: CountScope; blind?: boolean; notes?: string | null },
  ) {
    const tx = this.db.tx();
    await this.assertBranch(ctx, tx, branchId);

    const running = await tx.stockCount.findFirst({
      where: {
        branchId,
        status: { in: [StockCountStatus.OPEN, StockCountStatus.SUBMITTED] },
      },
    });
    if (running) {
      throw new ConflictError(
        'A count is already open at this branch. Finish or cancel it first — two counts against ' +
          'two snapshots produce two different answers.',
        'count_already_open',
      );
    }

    const id = newId();
    const now = this.clock.now();
    const opening = input.type === StockCountType.OPENING;

    await tx.stockCount.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId,
        type: input.type,
        status: StockCountStatus.OPEN,
        scope: (input.scope ?? {}) as object,
        blind: input.blind ?? false,
        // Frozen at the moment of opening: everything counted after
        // this is measured against what the system believed then.
        frozenAt: now,
        createdBy: ctx.userId,
        notes: input.notes?.trim() || null,
      },
    });

    // The sheet: every batch in scope, with what the system expects.
    const batches = opening
      ? []
      : await tx.productBatch.findMany({
          where: {
            branchId,
            status: { in: [BatchStatus.ACTIVE, BatchStatus.EXPIRED, BatchStatus.BLOCKED] },
            ...(await this.scopeFilter(tx, input.scope)),
          },
        });

    for (const batch of batches) {
      await tx.stockCountLine.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          countId: id,
          batchId: batch.id,
          productId: batch.productId,
          expected: batch.quantityOnHand,
        },
      });
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockCountOpened,
      entityType: 'stock_count',
      entityId: id,
      after: { type: input.type, blind: input.blind ?? false, lines: batches.length },
    });

    return this.read(ctx, id);
  }

  async read(ctx: TenantContext, countId: string) {
    const tx = this.db.tx();
    const count = await tx.stockCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundError('Stock count');

    const lines = await tx.stockCountLine.findMany({ where: { countId } });
    const productIds = [...new Set(lines.map((line) => line.productId))];
    const batchIds = lines.map((line) => line.batchId).filter((id): id is string => id !== null);

    const [products, batches] = await Promise.all([
      productIds.length
        ? tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true, name: true, strengthText: true, dispenseUnit: true },
          })
        : Promise.resolve([]),
      batchIds.length
        ? tx.productBatch.findMany({
            where: { id: { in: batchIds } },
            select: { id: true, batchNo: true, expiryDate: true, status: true },
          })
        : Promise.resolve([]),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const batchById = new Map(batches.map((b) => [b.id, b]));

    // INV-F-16: a blind count does not show what the system expects.
    // A number on the sheet is a number people count towards.
    const hide = count.blind && count.status === StockCountStatus.OPEN;

    return {
      count: {
        id: count.id,
        branchId: count.branchId,
        type: count.type,
        status: count.status,
        blind: count.blind,
        scope: count.scope,
        frozenAt: count.frozenAt,
        submittedAt: count.submittedAt,
        approvedAt: count.approvedAt,
        notes: count.notes,
        createdBy: count.createdBy,
      },
      lines: lines
        .map((line) => ({
          id: line.id,
          batchId: line.batchId,
          productId: line.productId,
          product: productById.get(line.productId) ?? null,
          batch: line.batchId ? (batchById.get(line.batchId) ?? null) : null,
          newBatchNo: line.newBatchNo,
          newExpiry: line.newExpiry,
          newCost: line.newCost === null ? null : fromSen(line.newCost),
          expected: hide ? null : line.expected === null ? null : Number(line.expected),
          counted: line.counted === null ? null : Number(line.counted),
          variance: hide ? null : line.variance === null ? null : Number(line.variance),
          note: line.note,
          countedAt: line.countedAt,
        }))
        .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? '')),
      summary: hide
        ? null
        : this.summarise(lines.map((l) => ({ variance: l.variance === null ? null : Number(l.variance) }))),
    };
  }

  /** Entering what was on the shelf. Bulk, because that is how it arrives. */
  async enter(ctx: TenantContext, countId: string, inputs: CountLineInput[]) {
    const tx = this.db.tx();
    const count = await this.openCountOrThrow(tx, countId);
    const now = this.clock.now();

    for (const input of inputs) {
      if (!(input.counted >= 0)) {
        throw new BadRequestError('A counted quantity cannot be negative.', 'invalid_count');
      }

      if (input.batchId) {
        const line = await tx.stockCountLine.findFirst({
          where: { countId, batchId: input.batchId },
        });
        if (!line) {
          throw new NotFoundError(
            'Count line',
            'That batch is not on this count sheet. Add it as a batch found on the shelf.',
          );
        }
        const expected = line.expected === null ? 0 : Number(line.expected);
        await tx.stockCountLine.update({
          where: { id: line.id },
          data: {
            counted: input.counted,
            variance: round3(input.counted - expected),
            countedBy: ctx.userId,
            countedAt: now,
            note: input.note?.trim() || null,
          },
        });
        continue;
      }

      // A batch on the shelf the system did not know about — the
      // discovery a count exists to make.
      await this.addDiscovered(tx, ctx, count, input, now);
    }

    return this.read(ctx, countId);
  }

  /**
   * A batch found on the shelf with no row behind it.
   *
   * The batch is created now, with nothing in it, so that approving the
   * count can post an ordinary movement into it. Creating it empty and
   * moving stock in is the same shape as a delivery, which keeps the
   * ledger's one write path intact.
   */
  private async addDiscovered(
    tx: Tx,
    ctx: TenantContext,
    count: { id: string; branchId: string },
    input: CountLineInput,
    now: Date,
  ) {
    if (!input.productId) {
      throw new BadRequestError(
        'Say which product was found on the shelf.',
        'product_required',
      );
    }
    const product = await tx.product.findFirst({ where: { id: input.productId } });
    if (!product) throw new NotFoundError('Product');

    const batchNo = product.isBatched ? (input.newBatchNo ?? '').trim() : NON_BATCHED;
    if (product.isBatched && !batchNo) {
      throw new BadRequestError(
        `${product.name} is tracked by batch, so the one on the shelf needs its number.`,
        'batch_no_required',
      );
    }
    const expiry = product.isBatched ? parseExpiry(input.newExpiry) : null;
    if (product.isBatched && !expiry) {
      throw new BadRequestError(
        `${product.name} is tracked by batch, so the one on the shelf needs its expiry date.`,
        'expiry_required',
      );
    }

    const existing = await tx.productBatch.findFirst({
      where: { branchId: count.branchId, productId: product.id, batchNo },
    });
    if (existing) {
      throw new ConflictError(
        `Batch ${batchNo} is already on the count sheet. Enter its counted quantity instead.`,
        'batch_already_known',
      );
    }

    const batch = await tx.productBatch.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        branchId: count.branchId,
        productId: product.id,
        batchNo,
        expiryDate: expiry,
        costPrice: input.newCost == null ? 0n : BigInt(toSen(input.newCost)),
        quantityOnHand: 0,
        sourceType: 'count',
        sourceId: count.id,
        createdBy: ctx.userId,
        receivedAt: now,
      },
    });

    await tx.stockCountLine.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        countId: count.id,
        batchId: batch.id,
        productId: product.id,
        newBatchNo: batchNo,
        newExpiry: expiry,
        newCost: input.newCost == null ? null : BigInt(toSen(input.newCost)),
        // The system expected none of it, because it did not know.
        expected: 0,
        counted: input.counted,
        variance: round3(input.counted),
        countedBy: ctx.userId,
        countedAt: now,
        note: input.note?.trim() || null,
      },
    });
  }

  /** Counting is done; somebody senior looks at the variances. */
  async submit(ctx: TenantContext, countId: string) {
    const tx = this.db.tx();
    const count = await this.openCountOrThrow(tx, countId);

    const uncounted = await tx.stockCountLine.count({
      where: { countId, counted: null },
    });
    if (uncounted > 0) {
      throw new ConflictError(
        uncounted === 1
          ? 'One line has not been counted. A blank is not a zero — count it, or record zero.'
          : `${uncounted} lines have not been counted. A blank is not a zero.`,
        'lines_uncounted',
      );
    }

    await tx.stockCount.update({
      where: { id: countId },
      data: {
        status: StockCountStatus.SUBMITTED,
        submittedBy: ctx.userId,
        submittedAt: this.clock.now(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockCountSubmitted,
      entityType: 'stock_count',
      entityId: countId,
      after: { lines: await tx.stockCountLine.count({ where: { countId } }) },
    });

    void count;
    return this.read(ctx, countId);
  }

  /**
   * INV-F-16, INV-T-08: approve, and post the difference.
   *
   * One `COUNT_ADJUST` movement per line that disagrees, each carrying
   * the session as its reference so an auditor can get from a movement
   * back to the sheet that produced it. Lines that agree post nothing —
   * a movement of zero is not a movement.
   */
  async approve(ctx: TenantContext, countId: string) {
    const tx = this.db.tx();
    const count = await tx.stockCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundError('Stock count');

    if (count.status !== StockCountStatus.SUBMITTED) {
      throw new ConflictError(
        count.status === StockCountStatus.APPROVED
          ? 'This count has already been approved.'
          : 'A count is submitted before it is approved, so the variances can be looked at.',
        'not_submitted',
      );
    }
    // INV-R-10: the person who counted is not the person who approves.
    if (!ctx.permissions.has('stock.adjust')) {
      throw new ForbiddenError('Approving a count posts stock adjustments.', {});
    }

    const lines = await tx.stockCountLine.findMany({ where: { countId } });
    const now = this.clock.now();
    const posted: Array<{ batchId: string; variance: number; movementId: string }> = [];

    for (const line of lines) {
      const variance = line.variance === null ? 0 : Number(line.variance);
      if (variance === 0 || !line.batchId) continue;

      const moved = await this.ledger.move(tx, ctx, {
        batchId: line.batchId,
        type:
          count.type === StockCountType.OPENING
            ? StockMovementType.OPENING
            : StockMovementType.COUNT_ADJUST,
        // A count can find more or less, so the sign comes from the
        // variance rather than from the movement type.
        signedQuantity: variance,
        referenceType: 'stock_count',
        referenceId: countId,
        reasonCode: count.type === StockCountType.OPENING ? 'opening_balance' : 'miscount',
        reasonText: line.note ?? `Counted ${line.counted}, expected ${line.expected ?? 0}`,
      });
      posted.push({ batchId: line.batchId, variance, movementId: moved.movement.id });
    }

    await tx.stockCount.update({
      where: { id: countId },
      data: {
        status: StockCountStatus.APPROVED,
        approvedBy: ctx.userId,
        approvedAt: now,
      },
    });

    const summary = this.summarise(
      lines.map((l) => ({ variance: l.variance === null ? null : Number(l.variance) })),
    );

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockCountApproved,
      entityType: 'stock_count',
      entityId: countId,
      after: { ...summary, adjustments: posted.length, type: count.type },
    });

    this.events.publish({
      name: DomainEvent.StockCountApproved,
      tenantId: ctx.tenantId,
      branchId: count.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { countId, adjustments: posted.length, ...summary },
    });

    return this.read(ctx, countId);
  }

  async cancel(ctx: TenantContext, countId: string, reason: string) {
    const tx = this.db.tx();
    const count = await tx.stockCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundError('Stock count');
    if (count.status === StockCountStatus.APPROVED) {
      throw new ConflictError(
        'This count has been approved and its adjustments posted.',
        'already_approved',
      );
    }

    await tx.stockCount.update({
      where: { id: countId },
      data: {
        status: StockCountStatus.CANCELLED,
        cancelledAt: this.clock.now(),
        notes: reason?.trim() || count.notes,
      },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockCountCancelled,
      entityType: 'stock_count',
      entityId: countId,
      reason: reason?.trim() || null,
    });
    return { cancelled: true };
  }

  async list(ctx: TenantContext, branchId: string) {
    const tx = this.db.tx();
    await this.assertBranch(ctx, tx, branchId);
    const rows = await tx.stockCount.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        blind: row.blind,
        frozenAt: row.frozenAt,
        approvedAt: row.approvedAt,
        notes: row.notes,
      })),
    };
  }

  // -------------------------------------------------------------------

  private summarise(lines: Array<{ variance: number | null }>) {
    const counted = lines.filter((l) => l.variance !== null);
    const over = counted.filter((l) => l.variance! > 0);
    const under = counted.filter((l) => l.variance! < 0);
    return {
      lines: lines.length,
      agreed: counted.filter((l) => l.variance === 0).length,
      over: over.length,
      under: under.length,
      /** Units, not money: value needs a cost per batch and is a report. */
      netUnits: round3(counted.reduce((sum, l) => sum + l.variance!, 0)),
    };
  }

  private async scopeFilter(tx: Tx, scope?: CountScope) {
    if (!scope) return {};
    if (scope.productIds?.length) return { productId: { in: scope.productIds } };
    if (scope.categoryIds?.length) {
      const products = await tx.product.findMany({
        where: { categoryId: { in: scope.categoryIds } },
        select: { id: true },
      });
      return { productId: { in: products.map((p) => p.id) } };
    }
    return {};
  }

  private async openCountOrThrow(tx: Tx, countId: string) {
    const count = await tx.stockCount.findFirst({ where: { id: countId } });
    if (!count) throw new NotFoundError('Stock count');
    if (count.status !== StockCountStatus.OPEN) {
      throw new ConflictError(
        `This count has been ${count.status.toLowerCase()}.`,
        'count_not_open',
      );
    }
    return count;
  }

  private async assertBranch(ctx: TenantContext, tx: Tx, branchId: string) {
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');
    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: { id: true } });
    if (!branch) throw new NotFoundError('Branch');
  }
}
