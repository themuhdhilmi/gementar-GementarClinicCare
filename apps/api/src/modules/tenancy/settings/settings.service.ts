import { Injectable } from '@nestjs/common';
import { DbService } from '../../../shared/prisma/db.service.js';
import { ModuleDisabledError } from './settings-errors.js';
import {
  MODULE_FLAGS,
  resolveModuleFlags,
  type ModuleFlags,
  type ModuleKey,
} from './module-flags.js';
import { resolveSettings, TENANT_ONLY_GROUPS, type TenantSettings } from './tenant-settings.js';

/**
 * TEN-F-04: the one way a module reads a setting.
 *
 * Nothing outside this file should touch `tenant.settings` or
 * `branch.settings` as JSON. Going through here means a module gets the
 * resolved value with its type, the three layers applied in the right order
 * (TEN-F-09), and the defaults filled in — rather than whatever happens to be
 * written down, which for most clinics is nothing at all.
 *
 * TEN-N-04: resolution is cached for the life of the unit of work. The cache
 * is the transaction's, so there is no invalidation to get wrong: a change
 * made by one request is read fresh by the next one.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService) {}

  /** Everything that applies at this branch, defaults included. */
  async at(branchId: string): Promise<TenantSettings> {
    return this.db.once(`settings:${branchId}`, async () => {
      const tx = this.db.tx();
      const [tenant, branch] = await Promise.all([
        tx.tenant.findFirst({ select: { settings: true } }),
        tx.branch.findFirst({ where: { id: branchId }, select: { settings: true } }),
      ]);
      return resolveSettings(
        tenant?.settings as Record<string, unknown> | null,
        branch?.settings as Record<string, unknown> | null,
      );
    });
  }

  /**
   * Settings with the branch layer left out, for the things that must be the
   * same everywhere. A patient number cannot depend on which door the patient
   * came through, so `patient.mrnPrefix` is read through here.
   */
  async clinicWide(): Promise<TenantSettings> {
    return this.db.once('settings:clinic', async () => {
      const tenant = await this.db.tx().tenant.findFirst({ select: { settings: true } });
      return resolveSettings(tenant?.settings as Record<string, unknown> | null, null);
    });
  }

  /** One group, for a caller that only needs billing or only needs queue. */
  async group<K extends keyof TenantSettings>(
    branchId: string,
    name: K,
  ): Promise<TenantSettings[K]> {
    // A group that must not vary by branch is resolved without one, whichever
    // way it is asked for, so a caller cannot get the wrong answer by
    // reaching for the obvious method.
    if (TENANT_ONLY_GROUPS.has(name)) return (await this.clinicWide())[name];
    return (await this.at(branchId))[name];
  }

  /** TEN-F-05: the modules this clinic has switched on. */
  async modules(): Promise<ModuleFlags> {
    return this.db.once('modules', async () => {
      const tenant = await this.db.tx().tenant.findFirst({ select: { modules: true } });
      return resolveModuleFlags(tenant?.modules);
    });
  }

  async isEnabled(key: ModuleKey): Promise<boolean> {
    return (await this.modules())[key];
  }

  /**
   * Refuses the request when the clinic has not switched the module on. The
   * message names the module rather than the flag, because the person reading
   * it has to decide whether to buy it, not to edit JSON.
   */
  async require(key: ModuleKey): Promise<void> {
    if (!(await this.isEnabled(key))) throw new ModuleDisabledError(MODULE_FLAGS[key]);
  }

  /** Called after a change, so the rest of this request sees the new value. */
  invalidate(branchId?: string): void {
    this.db.forget('modules');
    this.db.forget('settings:clinic');
    if (branchId) this.db.forget(`settings:${branchId}`);
  }
}
