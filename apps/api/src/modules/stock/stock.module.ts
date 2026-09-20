import { Module, type OnModuleInit } from '@nestjs/common';
import { BatchStatus } from '../../generated/prisma/enums.js';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import { ProductRetirementRegistry } from '../catalogue/retirement.registry.js';
import { ProductStockLookup } from '../catalogue/stock-lookup.js';
import { LedgerService } from './ledger.service.js';
import { StockService } from './stock.service.js';
import { StockController } from './stock.controller.js';
import { StockReconciliationJob } from './reconciliation.job.js';

/**
 * Stock (INV, the second half of v0-09-inventory.md).
 *
 * The catalogue says what a product is. This says how much of it is on
 * which shelf, and it is the half everything downstream needs:
 * prescribing shows it, dispensing takes from it, procedures consume it,
 * billing prices it.
 *
 * `LedgerService` is exported and `StockService` is not. Other modules
 * move stock; they do not receive deliveries or post adjustments, and
 * keeping the export surface to the one method they need is what makes
 * "there is exactly one write path" true rather than aspirational.
 */
@Module({
  imports: [CatalogueModule],
  controllers: [StockController],
  providers: [LedgerService, StockService, StockReconciliationJob],
  exports: [LedgerService],
})
export class StockModule implements OnModuleInit {
  constructor(
    private readonly retirement: ProductRetirementRegistry,
    private readonly lookup: ProductStockLookup,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit(): void {
    /**
     * INV-F-05: a product cannot be withdrawn while a branch still has
     * some. The registry has been waiting for this since the catalogue
     * was built; it is the check its own comment promised.
     */
    this.retirement.add('stock on hand', async (tx, productId) => {
      const batches = await tx.productBatch.findMany({
        where: { productId, quantityOnHand: { gt: 0 }, status: BatchStatus.ACTIVE },
        select: { branchId: true, quantityOnHand: true },
      });
      if (batches.length === 0) return null;

      const total = batches.reduce((sum, batch) => sum + Number(batch.quantityOnHand), 0);
      const branches = new Set(batches.map((batch) => batch.branchId)).size;
      return {
        reason: 'stock_on_hand',
        detail:
          branches === 1
            ? `there are still ${total} of them on the shelf`
            : `there are still ${total} of them on the shelf, across ${branches} branches`,
      };
    });

    /**
     * INV-F-06, RX-F-04: on-hand beside a product in a search result.
     * Registered here, so the catalogue keeps knowing nothing about
     * batches.
     */
    this.lookup.register((tx, branchId, productIds) =>
      this.ledger.onHandFor(tx, branchId, productIds),
    );
  }
}
