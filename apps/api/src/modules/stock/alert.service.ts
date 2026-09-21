import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BatchStatus, StockAlertKind } from '../../generated/prisma/enums.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/** INV-F-20. Configurable is `INV-OPEN-17`; these are the defaults. */
const EXPIRY_BANDS: Array<{ kind: StockAlertKind; days: number }> = [
  { kind: StockAlertKind.EXPIRING_90, days: 90 },
  { kind: StockAlertKind.EXPIRING_60, days: 60 },
  { kind: StockAlertKind.EXPIRING_30, days: 30 },
];

export type AlertRow = {
  kind: StockAlertKind;
  productId: string;
  product: { id: string; sku: string; name: string; dispenseUnit: string } | null;
  observed: number | null;
  firstSeen: Date;
  lastSeen: Date;
  acknowledgedAt: Date | null;
};

/**
 * Stock alerts (INV-F-19, F-20, INV-T-11).
 *
 * The rule that shapes this file: **an alert fires on the transition,
 * not on the state.** On-hand dropping to the reorder level is news;
 * every subsequent dispense from an already-low shelf is not. Without
 * that distinction a busy morning produces forty identical events and
 * whoever reads them stops reading them.
 *
 * So the state is remembered. A row appears when the condition starts
 * being true, is refreshed silently while it stays true, and
 * disappears when it stops — at which point a later recurrence is news
 * again.
 */
@Injectable()
export class StockAlertService {
  private readonly logger = new Logger(StockAlertService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /**
   * Re-evaluate one product at one branch.
   *
   * Called from the ledger after every movement, inside the same
   * transaction, because an alert that appears a minute later is an
   * alert that appears after the last box has gone.
   */
  async evaluate(tx: Tx, ctx: TenantContext, branchId: string, productId: string): Promise<void> {
    const [setting, batches] = await Promise.all([
      tx.productBranchSetting.findFirst({ where: { branchId, productId } }),
      tx.productBatch.findMany({ where: { branchId, productId } }),
    ]);

    const onHand = batches
      .filter((batch) => batch.status === BatchStatus.ACTIVE)
      .reduce((sum, batch) => sum + Number(batch.quantityOnHand), 0);

    const minStock = setting?.minStock == null ? null : Number(setting.minStock);
    const reorderLevel = setting?.reorderLevel == null ? null : Number(setting.reorderLevel);

    const should = new Map<StockAlertKind, number>();

    // INV-F-19. Critical supersedes low: a shelf below the minimum is
    // also below the reorder level, and saying both is saying it twice.
    if (minStock !== null && onHand <= minStock) {
      should.set(StockAlertKind.CRITICAL, onHand);
    } else if (reorderLevel !== null && onHand <= reorderLevel) {
      should.set(StockAlertKind.LOW, onHand);
    }

    // INV-F-20. Only the nearest band, for the same reason: a batch
    // thirty days out is also ninety days out.
    const today = this.today();
    const live = batches.filter((batch) => Number(batch.quantityOnHand) > 0 && batch.expiryDate);
    const expired = live.filter((batch) => batch.expiryDate! < today);
    if (expired.length > 0) {
      should.set(StockAlertKind.EXPIRED, expired.length);
    } else {
      for (const band of [...EXPIRY_BANDS].sort((a, b) => a.days - b.days)) {
        const within = live.filter(
          (batch) => batch.expiryDate! <= new Date(today.getTime() + band.days * 86_400_000),
        );
        if (within.length > 0) {
          should.set(band.kind, within.length);
          break;
        }
      }
    }

    const current = await tx.stockAlertState.findMany({ where: { branchId, productId } });
    const now = this.clock.now();

    // Gone: the condition stopped being true, so a later recurrence is
    // news again.
    for (const row of current) {
      if (!should.has(row.kind)) {
        await tx.stockAlertState.delete({
          where: {
            branchId_productId_kind: { branchId, productId, kind: row.kind },
          },
        });
      }
    }

    for (const [kind, observed] of should) {
      const existing = current.find((row) => row.kind === kind);
      if (existing) {
        // Still true. Refreshed quietly — no second event.
        await tx.stockAlertState.update({
          where: { branchId_productId_kind: { branchId, productId, kind } },
          data: { lastSeen: now, observed },
        });
        continue;
      }

      await tx.stockAlertState.create({
        data: {
          tenantId: requireTenantId(),
          branchId,
          productId,
          kind,
          firstSeen: now,
          lastSeen: now,
          observed,
        },
      });

      // INV-T-11: once, on the transition.
      this.events.publish({
        name: EVENT_FOR[kind],
        tenantId: ctx.tenantId,
        branchId,
        actorId: ctx.userId || null,
        occurredAt: now,
        payload: { productId, kind, observed, onHand },
      });
    }
  }

  /** What the dashboard shows. */
  async list(
    ctx: TenantContext,
    branchId: string,
    options: { includeAcknowledged?: boolean } = {},
  ): Promise<{ items: AlertRow[] }> {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const rows = await tx.stockAlertState.findMany({
      where: {
        branchId,
        ...(options.includeAcknowledged ? {} : { acknowledgedAt: null }),
      },
    });
    if (rows.length === 0) return { items: [] };

    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
      select: { id: true, sku: true, name: true, dispenseUnit: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return {
      items: rows
        .map((row) => ({
          kind: row.kind,
          productId: row.productId,
          product: byId.get(row.productId) ?? null,
          observed: row.observed === null ? null : Number(row.observed),
          firstSeen: row.firstSeen,
          lastSeen: row.lastSeen,
          acknowledgedAt: row.acknowledgedAt,
        }))
        .sort((a, b) => SEVERITY[b.kind] - SEVERITY[a.kind]),
    };
  }

  /**
   * "I have seen this."
   *
   * The alert stays — the shelf is still low — but it stops being new.
   * Deleting it instead would make it reappear on the next movement and
   * teach people to ignore the list.
   */
  async acknowledge(
    ctx: TenantContext,
    branchId: string,
    productId: string,
    kind: StockAlertKind,
  ) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const row = await tx.stockAlertState.findFirst({ where: { branchId, productId, kind } });
    if (!row) throw new NotFoundError('Alert');

    await tx.stockAlertState.update({
      where: { branchId_productId_kind: { branchId, productId, kind } },
      data: { acknowledgedBy: ctx.userId, acknowledgedAt: this.clock.now() },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.StockAlertAcknowledged,
      entityType: 'product',
      entityId: productId,
      after: { kind, observed: row.observed === null ? null : Number(row.observed) },
    });

    return this.list(ctx, branchId);
  }

  /**
   * INV-F-20: a batch goes off without anybody touching it.
   *
   * Expiry is the one condition that becomes true through the passage
   * of time rather than through a movement, so it needs a clock as well
   * as a trigger.
   */
  @Cron('45 20 * * *', { name: 'stock-alerts' }) // 04:45 Asia/Kuala_Lumpur
  async sweep(): Promise<{ tenants: number; products: number }> {
    const tenants = await this.db.withPlatform('list tenants for the stock alert sweep', (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    );

    let products = 0;
    for (const tenant of tenants) {
      await this.db.withTenant(tenant.id, async (tx) => {
        const pairs = await tx.productBatch.findMany({
          where: { quantityOnHand: { gt: 0 } },
          select: { branchId: true, productId: true },
          distinct: ['branchId', 'productId'],
        });
        const ctx = systemAlertContext(tenant.id);
        for (const pair of pairs) {
          await this.evaluate(tx, ctx, pair.branchId, pair.productId);
          products += 1;
        }
      });
    }

    this.logger.log(`stock alerts: ${products} product/branch pairs across ${tenants.length} clinics`);
    return { tenants: tenants.length, products };
  }

  private today(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

const EVENT_FOR: Record<StockAlertKind, (typeof DomainEvent)[keyof typeof DomainEvent]> = {
  LOW: DomainEvent.StockLow,
  CRITICAL: DomainEvent.StockCritical,
  EXPIRING_90: DomainEvent.StockExpiring,
  EXPIRING_60: DomainEvent.StockExpiring,
  EXPIRING_30: DomainEvent.StockExpiring,
  EXPIRED: DomainEvent.StockExpired,
};

/** Worst first: an expired batch outranks a shelf running low. */
const SEVERITY: Record<StockAlertKind, number> = {
  EXPIRED: 6,
  CRITICAL: 5,
  EXPIRING_30: 4,
  LOW: 3,
  EXPIRING_60: 2,
  EXPIRING_90: 1,
};

/**
 * The nightly sweep acts on nobody's behalf. It writes no audit entries
 * and its events carry no actor, which is the truth: nothing happened
 * except time passing.
 */
function systemAlertContext(tenantId: string): TenantContext {
  return {
    tenantId,
    branchId: '',
    userId: '',
    sessionId: 'system',
    userName: 'the nightly stock sweep',
    userEmail: '',
    roles: [],
    rolesAnywhere: [],
    branchesWithRole: [],
    permissions: new Set(),
    permissionVersion: 0,
    mfaVerified: true,
    reauthAt: null,
    ip: null,
    userAgent: null,
    requestId: 'stock-alert-sweep',
  };
}
