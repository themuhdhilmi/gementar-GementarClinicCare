import { Injectable } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';

export type RetirementBlocker = { reason: string; detail: string };

/**
 * INV-F-05: what stops a product being retired.
 *
 * Built empty, when the catalogue existed and stock did not. The stock
 * half now registers "on hand at some branch", so a product still on a
 * shelf cannot be withdrawn from under it — which is what this was
 * waiting for.
 */
@Injectable()
export class ProductRetirementRegistry {
  private readonly checks = new Map<
    string,
    (tx: Tx, productId: string) => Promise<RetirementBlocker | null>
  >();

  add(name: string, check: (tx: Tx, productId: string) => Promise<RetirementBlocker | null>): void {
    this.checks.set(name, check);
  }

  remove(name: string): void {
    this.checks.delete(name);
  }

  get registered(): string[] {
    return [...this.checks.keys()];
  }

  async blockers(tx: Tx, productId: string): Promise<RetirementBlocker[]> {
    const found: RetirementBlocker[] = [];
    for (const check of this.checks.values()) {
      const blocker = await check(tx, productId);
      if (blocker) found.push(blocker);
    }
    return found;
  }
}
