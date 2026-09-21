import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { TenantStatus } from '../../generated/prisma/enums.js';
import { Clock } from '../../shared/time/clock.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from './tenant-context.js';
import {
  applyPatch,
  describeSettings,
  explainSettingsIssues,
  resolveSettings,
  settingsPatchSchema,
  SETTINGS_SCHEMA_VERSION,
  type TenantSettings,
} from './settings/tenant-settings.js';
import { SettingsService } from './settings/settings.service.js';
import { describeModuleFlags } from './settings/module-flags.js';
import {
  SettingsChangeBlockedError,
  SettingsRejectedError,
} from './settings/settings-errors.js';
import { SettingsChangeRegistry } from './settings-change.registry.js';

@Injectable()
export class TenantService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly settings: SettingsService,
    private readonly settingsChanges: SettingsChangeRegistry,
  ) {}

  /** Login-time lookup: runs before any tenant is known, so platform scope. */
  async findActiveBySlug(slug: string) {
    return this.db.withPlatform('resolve tenant by slug at login', (tx) =>
      tx.tenant.findFirst({
        where: { slug: slug.trim().toLowerCase(), status: TenantStatus.ACTIVE },
        select: { id: true, name: true, slug: true, timezone: true },
      }),
    );
  }

  async getCurrent(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant');
    return tenant;
  }

  /**
   * TEN-F-01: the clinic company as it describes itself, plus the settings
   * that actually apply at the branch the user is working from.
   */
  async describe(tx: Tx, branchId: string) {
    const tenant = await tx.tenant.findFirst({
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        plan: true,
        timezone: true,
        currency: true,
        tin: true,
        businessRegNo: true,
        settings: true,
        modules: true,
      },
    });
    if (!tenant) throw new NotFoundError('Tenant');

    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { id: true, code: true, name: true, timezone: true, settings: true },
    });

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        plan: tenant.plan,
        // TEN-F-06: a branch may sit in another time zone; most never will.
        timezone: branch?.timezone ?? tenant.timezone,
        currency: tenant.currency,
        tin: tenant.tin,
        businessRegNo: tenant.businessRegNo,
      },
      settings: await this.settings.at(branchId),
      schema: {
        version: SETTINGS_SCHEMA_VERSION,
        fields: describeSettings(),
        modules: describeModuleFlags(),
      },
      // TEN-F-05: every flag, not only the ones written down, so the screen
      // can show what exists as well as what is on.
      modules: await this.settings.modules(),
    };
  }

  /** TEN-F-01: name, time zone and business details. The slug never moves. */
  async updateProfile(
    ctx: TenantContext,
    input: { name?: string; timezone?: string; tin?: string | null; businessRegNo?: string | null },
  ) {
    const tx = this.db.tx();
    const before = await this.getCurrent(tx, ctx.tenantId);

    await tx.tenant.update({
      where: { id: ctx.tenantId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.tin === undefined ? {} : { tin: input.tin }),
        ...(input.businessRegNo === undefined ? {} : { businessRegNo: input.businessRegNo }),
        updatedBy: ctx.userId,
      },
    });

    const after = await this.getCurrent(tx, ctx.tenantId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TenantUpdated,
      entityType: 'tenant',
      entityId: ctx.tenantId,
      before: { name: before.name, timezone: before.timezone, tin: before.tin, businessRegNo: before.businessRegNo },
      after: { name: after.name, timezone: after.timezone, tin: after.tin, businessRegNo: after.businessRegNo },
    });
    return this.describe(tx, ctx.branchId);
  }

  /** TEN-F-04: validated against the schema; unknown keys are refused. */
  async patchSettings(
    ctx: TenantContext,
    patch: unknown,
    options: { acknowledge?: boolean } = {},
  ): Promise<TenantSettings> {
    const tx = this.db.tx();
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new SettingsRejectedError(explainSettingsIssues(parsed.error));

    const tenant = await this.getCurrent(tx, ctx.tenantId);
    const before = tenant.settings as Record<string, unknown>;
    const settings = applyPatch(before, parsed.data);

    /**
     * Would this change strand work that is already in progress?
     *
     * Asked of the modules that own the work rather than answered here:
     * tenancy knows what a setting is and nothing about queues. The
     * commonest case is switching a station off in the middle of the
     * afternoon while patients are still standing in it.
     */
    if (!options.acknowledge) {
      const blockers = await this.settingsChanges.blockers(
        tx,
        resolveSettings(before, null),
        resolveSettings(settings, null),
        null,
      );
      if (blockers.length > 0) throw new SettingsChangeBlockedError(blockers);
    }

    await tx.tenant.update({
      where: { id: ctx.tenantId },
      data: { settings: settings as object, updatedBy: ctx.userId },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.TenantSettingsChanged,
      entityType: 'tenant',
      entityId: ctx.tenantId,
      before: tenant.settings,
      after: settings,
    });
    this.events.publish({
      name: DomainEvent.TenantSettingsChanged,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { changed: Object.keys(parsed.data) },
    });

    this.settings.invalidate(ctx.branchId);
    return this.settings.at(ctx.branchId);
  }

  /**
   * Serialises the tenant-wide invariants (IAM-R-05) by taking a row lock on the
   * tenant for the rest of the transaction. Two administrators disabling each
   * other at the same instant then queue instead of racing.
   */
  async lockForUpdate(tx: Tx, tenantId: string): Promise<void> {
    await tx.$queryRawUnsafe('SELECT id FROM tenant WHERE id = $1::uuid FOR UPDATE', tenantId);
  }
}
