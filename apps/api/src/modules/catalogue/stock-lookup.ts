import { Injectable } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';

export type StockSnapshot = { onHand: number; nearestExpiry: Date | null };

export type StockLookup = (
  tx: Tx,
  branchId: string,
  productIds: readonly string[],
) => Promise<Map<string, StockSnapshot>>;

/**
 * INV-F-06, RX-F-04: how much of this is on the shelf, beside each search
 * result.
 *
 * The catalogue half of inventory was built a phase before the stock
 * half, and the dependency between them runs one way: stock knows what a
 * product is, the catalogue knows nothing about batches. Rather than
 * reverse that for one column, stock fills this in when it starts.
 *
 * With nothing registered it answers "no information", which is honestly
 * different from "none in stock" — and the screens say so, because a
 * prescriber told "0 on hand" who then finds a full box has learnt not to
 * believe the number.
 */
@Injectable()
export class ProductStockLookup {
  private lookup: StockLookup | null = null;

  register(lookup: StockLookup): void {
    this.lookup = lookup;
  }

  get available(): boolean {
    return this.lookup !== null;
  }

  async for(
    tx: Tx,
    branchId: string,
    productIds: readonly string[],
  ): Promise<Map<string, StockSnapshot>> {
    if (!this.lookup || productIds.length === 0) return new Map();
    return this.lookup(tx, branchId, productIds);
  }
}
