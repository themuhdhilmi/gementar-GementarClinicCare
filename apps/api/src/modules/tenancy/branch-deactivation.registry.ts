import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';

export type DeactivationBlocker = { reason: string; count: number };

export type DeactivationCheck = (tx: Tx, branchId: string) => Promise<DeactivationBlocker | null>;

/**
 * TEN-F-07: a branch may not be deactivated while work is still open at it.
 *
 * What counts as open work belongs to the modules that own it — encounters to
 * `ENC`, stock to `INV` — and neither exists yet. Rather than have tenancy
 * reach into tables it does not own, each module registers a check here when
 * it is built:
 *
 *     constructor(registry: BranchDeactivationRegistry) {
 *       registry.add('open encounters', async (tx, branchId) => { ... });
 *     }
 *
 * With nothing registered, deactivation is allowed. That is correct today and
 * wrong the moment stock exists, so the test for it names the modules that
 * still owe a check.
 */
@Injectable()
export class BranchDeactivationRegistry {
  private readonly logger = new Logger(BranchDeactivationRegistry.name);
  private readonly checks = new Map<string, DeactivationCheck>();

  add(name: string, check: DeactivationCheck): void {
    this.checks.set(name, check);
    this.logger.log(`branch deactivation check registered: ${name}`);
  }

  /** Chiefly for tests, which must not leave a check behind them. */
  remove(name: string): void {
    this.checks.delete(name);
  }

  get registered(): string[] {
    return [...this.checks.keys()];
  }

  async blockers(tx: Tx, branchId: string): Promise<DeactivationBlocker[]> {
    const found: DeactivationBlocker[] = [];
    for (const check of this.checks.values()) {
      const blocker = await check(tx, branchId);
      if (blocker && blocker.count > 0) found.push(blocker);
    }
    return found;
  }
}
