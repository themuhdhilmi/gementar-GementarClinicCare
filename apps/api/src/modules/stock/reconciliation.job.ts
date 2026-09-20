import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { newId } from '../../shared/ids/uuid.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';

type Mismatch = {
  batchId: string;
  batchNo: string;
  productId: string;
  branchId: string;
  cached: number;
  ledger: number;
  difference: number;
};

/**
 * INV-F-21, INV-R-01, INV-R-10: the invariant, checked every night.
 *
 * `quantity_on_hand` is a cache of `Σ stock_movement.quantity`. The
 * ledger writes both together under a lock, so they cannot drift through
 * the application. This is what notices drift that arrived another way —
 * a direct UPDATE by somebody with a psql prompt, a restore, a migration
 * that meant well.
 *
 * **It never corrects anything.** A job that silently fixes a mismatch
 * destroys the evidence of how the mismatch happened, and the how is the
 * only part that stops it happening again. A human posts a COUNT_ADJUST
 * after counting the shelf.
 */
@Injectable()
export class StockReconciliationJob {
  private readonly logger = new Logger(StockReconciliationJob.name);

  constructor(private readonly db: DbService) {}

  @Cron('15 20 * * *', { name: 'stock-reconciliation' }) // 04:15 Asia/Kuala_Lumpur
  async run(): Promise<{ tenants: number; checked: number; mismatched: number }> {
    const tenants = await this.db.withPlatform('list tenants for stock reconciliation', (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    );

    let checked = 0;
    let mismatched = 0;

    for (const tenant of tenants) {
      const result = await this.db.withTenant(tenant.id, (tx) => this.verify(tx));
      checked += result.checked;
      mismatched += result.mismatches.length;

      for (const row of result.mismatches) {
        this.logger.error(
          `STOCK MISMATCH ${tenant.slug}: batch ${row.batchNo} (${row.batchId}) ` +
            `says ${row.cached} on hand, its movements total ${row.ledger}. ` +
            'Nothing has been corrected — count the shelf and post an adjustment.',
        );
      }
    }

    if (mismatched === 0) {
      this.logger.log(`stock reconciliation: ${checked} batches, all balanced`);
    }
    return { tenants: tenants.length, checked, mismatched };
  }

  /**
   * One tenant. Exposed so a test can call it directly and so an
   * administrator can ask for it on demand rather than waiting for
   * tomorrow morning.
   */
  async verify(tx: Tx): Promise<{ checked: number; mismatches: Mismatch[]; runId: string }> {
    // One query rather than one per batch: at fifty thousand batches the
    // round trips would cost more than the arithmetic.
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        batch_no: string;
        product_id: string;
        branch_id: string;
        cached: string;
        ledger: string | null;
      }>
    >`
      SELECT b.id,
             b.batch_no,
             b.product_id,
             b.branch_id,
             b.quantity_on_hand AS cached,
             (SELECT SUM(m.quantity) FROM stock_movement m WHERE m.batch_id = b.id) AS ledger
        FROM product_batch b
    `;

    const mismatches: Mismatch[] = [];
    for (const row of rows) {
      const cached = Number(row.cached);
      // A batch with no movements yet is balanced at zero, not mismatched.
      const ledger = row.ledger === null ? 0 : Number(row.ledger);
      if (Math.abs(cached - ledger) < 0.0005) continue;
      mismatches.push({
        batchId: row.id,
        batchNo: row.batch_no,
        productId: row.product_id,
        branchId: row.branch_id,
        cached,
        ledger,
        difference: Math.round((cached - ledger) * 1000) / 1000,
      });
    }

    const runId = newId();
    await tx.reconciliationRun.create({
      data: {
        id: runId,
        tenantId: requireTenantId(),
        batchesChecked: rows.length,
        mismatches: mismatches.length,
        // Kept whole: a mismatch that appears one night and is corrected
        // the next is still worth being able to read about.
        details: mismatches as unknown as object,
      },
    });

    return { checked: rows.length, mismatches, runId };
  }
}
