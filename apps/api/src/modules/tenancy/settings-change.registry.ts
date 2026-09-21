import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../../shared/prisma/db.service.js';
import type { TenantSettings } from './settings/tenant-settings.js';

export type SettingsChangeBlocker = {
  /** A stable word for the reason, for the client to branch on. */
  reason: string;
  /** What to say to the administrator, in their words. */
  detail: string;
  count: number;
};

export type SettingsChangeCheck = (
  tx: Tx,
  before: TenantSettings,
  after: TenantSettings,
  /**
   * The branch this change lands on, or `null` when it is clinic-wide.
   *
   * Settings come in two layers and both can be patched, so a check has
   * to know which it is answering about: a branch changing its own flow
   * strands only its own patients, while a clinic-wide change reaches
   * every branch that has not overridden it.
   */
  branchId: string | null,
) => Promise<SettingsChangeBlocker[]>;

/**
 * Changes to the clinic's settings that some other module would object to.
 *
 * The case this exists for: an owner switches triage off at three in the
 * afternoon while two patients are sitting in the triage queue. Nothing
 * is corrupted — they stay on the reception board — but the nurse's
 * screen vanishes from under her and nobody at that station can see them
 * any more. The right answer is to say so before saving, not to explain
 * it afterwards.
 *
 * Tenancy owns the settings and knows nothing about queues, so the
 * knowledge is registered from the module that has it, the same way
 * `BranchDeactivationRegistry` works. With nothing registered every
 * change is allowed, which is the correct behaviour for a clinic whose
 * encounter module is switched off.
 */
@Injectable()
export class SettingsChangeRegistry {
  private readonly logger = new Logger(SettingsChangeRegistry.name);
  private readonly checks = new Map<string, SettingsChangeCheck>();

  add(name: string, check: SettingsChangeCheck): void {
    this.checks.set(name, check);
    this.logger.log(`settings change check registered: ${name}`);
  }

  /** Chiefly for tests, which must not leave a check behind them. */
  remove(name: string): void {
    this.checks.delete(name);
  }

  get registered(): string[] {
    return [...this.checks.keys()];
  }

  async blockers(
    tx: Tx,
    before: TenantSettings,
    after: TenantSettings,
    branchId: string | null,
  ): Promise<SettingsChangeBlocker[]> {
    const found: SettingsChangeBlocker[] = [];
    for (const check of this.checks.values()) {
      found.push(...(await check(tx, before, after, branchId)));
    }
    return found.filter((blocker) => blocker.count > 0);
  }
}
