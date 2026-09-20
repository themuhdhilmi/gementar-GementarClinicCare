import { Module } from '@nestjs/common';
import { CatalogueController } from './catalogue.controller.js';
import { CatalogueService } from './catalogue.service.js';
import { ProductRetirementRegistry } from './retirement.registry.js';
import { CatalogueImportService } from './catalogue-import.service.js';
import { ProductStockLookup } from './stock-lookup.js';

/**
 * Product catalogue (INV, the first half of v0-09-inventory.md).
 *
 * Split out and built early because prescribing depends on it, and the
 * delivery plan put prescribing a whole phase before inventory. The seam
 * is natural: a product is a definition, and a batch of it on a shelf is a
 * fact about today. Phase 3 adds the second on top of the first.
 */
@Module({
  controllers: [CatalogueController],
  providers: [CatalogueService, CatalogueImportService, ProductRetirementRegistry, ProductStockLookup],
  exports: [CatalogueService, ProductRetirementRegistry, ProductStockLookup],
})
export class CatalogueModule {}
