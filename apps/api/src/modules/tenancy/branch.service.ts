import { Injectable } from '@nestjs/common';
import { BranchStatus } from '../../generated/prisma/enums.js';
import {
  ConflictError,
  InvariantViolationError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import type { TenantContext } from './tenant-context.js';
import { BranchDeactivationRegistry } from './branch-deactivation.registry.js';
import { assertBranchCode, assertOperatingHours, assertPostcode } from './branch.validation.js';
import {
  assertLogo,
  letterheadPatchSchema,
  resolveLetterhead,
  type Letterhead,
} from './letterhead.js';
import {
  applyPatch,
  resolveSettings,
  settingsPatchSchema,
  explainSettingsIssues,
  type TenantSettings,
} from './settings/tenant-settings.js';
import { SettingsService } from './settings/settings.service.js';
import {
  SettingsChangeBlockedError,
  SettingsRejectedError,
} from './settings/settings-errors.js';
import { SettingsChangeRegistry } from './settings-change.registry.js';

export type BranchSummary = {
  id: string;
  code: string;
  name: string;
  status: BranchStatus;
};

export type BranchDetail = BranchSummary & {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  email: string | null;
  licenceNo: string | null;
  timezone: string | null;
  operatingHours: unknown;
  settings: unknown;
  letterhead: Letterhead;
  hasLogo: boolean;
};

export type BranchInput = {
  code?: string;
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postcode?: string | null;
  phone?: string | null;
  email?: string | null;
  licenceNo?: string | null;
  timezone?: string | null;
  operatingHours?: unknown;
};

const DETAIL_SELECT = {
  id: true,
  code: true,
  name: true,
  status: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postcode: true,
  phone: true,
  email: true,
  licenceNo: true,
  timezone: true,
  operatingHours: true,
  settings: true,
  letterhead: true,
  // Whether there is a logo, never the logo itself: it is served on its own
  // route so that listing branches does not move a megabyte of images.
  letterheadLogoUpdatedAt: true,
} as const;

@Injectable()
export class BranchService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly deactivation: BranchDeactivationRegistry,
    private readonly settings: SettingsService,
    private readonly settingsChanges: SettingsChangeRegistry,
  ) {}

  async listByIds(tx: Tx, ids: readonly string[]): Promise<BranchSummary[]> {
    if (ids.length === 0) return [];
    return tx.branch.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, code: true, name: true, status: true },
      orderBy: { name: 'asc' },
    });
  }

  /** TEN-F-06: every branch in the tenant, for an administrator. */
  async listAll(tx: Tx): Promise<BranchDetail[]> {
    const rows = await tx.branch.findMany({ select: DETAIL_SELECT, orderBy: { code: 'asc' } });
    return rows.map(toDetail);
  }

  async getOrThrow(tx: Tx, branchId: string): Promise<BranchSummary> {
    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { id: true, code: true, name: true, status: true },
    });
    if (!branch) throw new NotFoundError('Branch');
    return branch;
  }

  async getDetail(tx: Tx, branchId: string): Promise<BranchDetail> {
    const branch = await tx.branch.findFirst({ where: { id: branchId }, select: DETAIL_SELECT });
    if (!branch) throw new NotFoundError('Branch');
    return toDetail(branch);
  }

  /** TEN-R-05 in application form: the branch must belong to the current tenant. */
  async assertBelongsToTenant(tx: Tx, branchId: string): Promise<void> {
    const count = await tx.branch.count({ where: { id: branchId } });
    if (count === 0) throw new NotFoundError('Branch');
  }

  async create(ctx: TenantContext, input: BranchInput & { code: string; name: string }): Promise<BranchDetail> {
    const tx = this.db.tx();
    const code = assertBranchCode(input.code);
    const name = input.name.trim();
    if (name.length < 1 || name.length > 200) {
      throw new InvariantViolationError('invalid_branch_name', 'A branch needs a name.');
    }

    const clash = await tx.branch.findFirst({ where: { code }, select: { id: true } });
    if (clash) {
      throw new ConflictError(`Another branch already uses the code ${code}.`, 'branch_code_taken');
    }

    const id = newId();
    await tx.branch.create({
      data: {
        id,
        tenantId: requireTenantId(),
        code,
        name,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postcode: assertPostcode(input.postcode),
        phone: input.phone ?? null,
        email: input.email ?? null,
        licenceNo: input.licenceNo ?? null,
        timezone: input.timezone ?? null,
        operatingHours: assertOperatingHours(input.operatingHours) as object,
        settings: {},
        status: BranchStatus.ACTIVE,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });

    const created = await this.getDetail(tx, id);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchCreated,
      entityType: 'branch',
      entityId: id,
      after: created,
    });
    this.events.publish({
      name: DomainEvent.BranchCreated,
      tenantId: ctx.tenantId,
      branchId: id,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { branchId: id, code },
    });
    return created;
  }

  async update(ctx: TenantContext, branchId: string, input: BranchInput): Promise<BranchDetail> {
    const tx = this.db.tx();
    const before = await this.getDetail(tx, branchId);

    // TEN-R-08: the code appears in document numbers, so it is immutable once
    // anything has been numbered. Nothing is numbered yet, so this is the
    // narrower rule: it cannot change at all after creation.
    if (input.code !== undefined && assertBranchCode(input.code) !== before.code) {
      throw new InvariantViolationError(
        'branch_code_immutable',
        'A branch code cannot be changed: it is part of every document number already issued under it.',
      );
    }

    await tx.branch.update({
      where: { id: branchId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.addressLine1 === undefined ? {} : { addressLine1: input.addressLine1 }),
        ...(input.addressLine2 === undefined ? {} : { addressLine2: input.addressLine2 }),
        ...(input.city === undefined ? {} : { city: input.city }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.postcode === undefined ? {} : { postcode: assertPostcode(input.postcode) }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.licenceNo === undefined ? {} : { licenceNo: input.licenceNo }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.operatingHours === undefined
          ? {}
          : { operatingHours: assertOperatingHours(input.operatingHours) as object }),
        updatedBy: ctx.userId,
      },
    });

    const after = await this.getDetail(tx, branchId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchUpdated,
      entityType: 'branch',
      entityId: branchId,
      before,
      after,
    });
    this.events.publish({
      name: DomainEvent.BranchUpdated,
      tenantId: ctx.tenantId,
      branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { branchId },
    });
    return after;
  }

  /** TEN-F-07: refused while work is still open at the branch. */
  async deactivate(ctx: TenantContext, branchId: string, reason?: string): Promise<BranchDetail> {
    const tx = this.db.tx();
    const before = await this.getDetail(tx, branchId);
    if (before.status === BranchStatus.INACTIVE) return before;

    const blockers = await this.deactivation.blockers(tx, branchId);
    if (blockers.length > 0) {
      throw new InvariantViolationError(
        'branch_in_use',
        `${before.name} still has ${blockers
          .map((b) => `${b.count} ${b.reason}`)
          .join(', and ')}. Finish or move those first.`,
      );
    }

    await tx.branch.update({
      where: { id: branchId },
      data: { status: BranchStatus.INACTIVE, updatedBy: ctx.userId },
    });

    const after = await this.getDetail(tx, branchId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchDeactivated,
      entityType: 'branch',
      entityId: branchId,
      before: { status: before.status },
      after: { status: after.status },
      reason: reason ?? null,
    });
    this.events.publish({
      name: DomainEvent.BranchDeactivated,
      tenantId: ctx.tenantId,
      branchId,
      actorId: ctx.userId,
      occurredAt: this.clock.now(),
      payload: { branchId },
    });
    return after;
  }

  async activate(ctx: TenantContext, branchId: string): Promise<BranchDetail> {
    const tx = this.db.tx();
    const before = await this.getDetail(tx, branchId);
    if (before.status === BranchStatus.ACTIVE) return before;

    await tx.branch.update({
      where: { id: branchId },
      data: { status: BranchStatus.ACTIVE, updatedBy: ctx.userId },
    });
    const after = await this.getDetail(tx, branchId);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchActivated,
      entityType: 'branch',
      entityId: branchId,
      before: { status: before.status },
      after: { status: after.status },
    });
    return after;
  }

  /** TEN-F-09: what this branch actually runs on, defaults included. */
  async resolvedSettings(branchId: string): Promise<TenantSettings> {
    return this.settings.at(branchId);
  }

  async patchSettings(
    ctx: TenantContext,
    branchId: string,
    patch: unknown,
    options: { acknowledge?: boolean } = {},
  ): Promise<TenantSettings> {
    const tx = this.db.tx();
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new SettingsRejectedError(explainSettingsIssues(parsed.error));

    const before = await this.getDetail(tx, branchId);
    const settings = applyPatch(before.settings as Record<string, unknown>, parsed.data);

    /**
     * Would this change strand work that is already in progress?
     *
     * Compared as *resolved* settings rather than as the branch's own
     * overrides: a branch layer is sparse, and asking what shape a half
     * a settings object implies would give the wrong answer about which
     * stations are going away.
     */
    if (!options.acknowledge) {
      const tenantLayer = (
        await tx.tenant.findFirst({ select: { settings: true } })
      )?.settings as Record<string, unknown> | null;
      const blockers = await this.settingsChanges.blockers(
        tx,
        resolveSettings(tenantLayer, before.settings as Record<string, unknown>),
        resolveSettings(tenantLayer, settings),
        branchId,
      );
      if (blockers.length > 0) throw new SettingsChangeBlockedError(blockers);
    }

    await tx.branch.update({
      where: { id: branchId },
      data: { settings: settings as object, updatedBy: ctx.userId },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchSettingsChanged,
      entityType: 'branch',
      entityId: branchId,
      before: before.settings,
      after: settings,
    });
    // This request has just changed them, so the cached copy is stale.
    this.settings.invalidate(branchId);
    return this.resolvedSettings(branchId);
  }

  /** TEN-F-10: the header and footer a printed document carries. */
  async setLetterhead(
    ctx: TenantContext,
    branchId: string,
    input: unknown,
  ): Promise<BranchDetail> {
    const tx = this.db.tx();
    const parsed = letterheadPatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new SettingsRejectedError(explainSettingsIssues(parsed.error));
    }

    const before = await this.getDetail(tx, branchId);
    const letterhead = { ...before.letterhead, ...parsed.data };
    await tx.branch.update({
      where: { id: branchId },
      data: { letterhead, updatedBy: ctx.userId },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchLetterheadChanged,
      entityType: 'branch',
      entityId: branchId,
      before: before.letterhead,
      after: letterhead,
    });
    return this.getDetail(tx, branchId);
  }

  /** TEN-F-10: the logo itself. Checked by its bytes, not its declared type. */
  async setLogo(
    ctx: TenantContext,
    branchId: string,
    file: { buffer: Buffer; mimetype?: string } | undefined,
  ): Promise<BranchDetail> {
    const tx = this.db.tx();
    const before = await this.getDetail(tx, branchId);
    const { buffer, mime } = assertLogo(file);

    await tx.branch.update({
      where: { id: branchId },
      data: {
        // Prisma wants a plain Uint8Array over a non-shared buffer.
        letterheadLogo: Uint8Array.from(buffer),
        letterheadLogoMime: mime,
        letterheadLogoUpdatedAt: this.clock.now(),
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchLetterheadChanged,
      entityType: 'branch',
      entityId: branchId,
      // The image is not in the audit entry; its shape is.
      before: { hasLogo: before.hasLogo },
      after: { hasLogo: true, mime, bytes: buffer.length },
    });
    return this.getDetail(tx, branchId);
  }

  async removeLogo(ctx: TenantContext, branchId: string): Promise<BranchDetail> {
    const tx = this.db.tx();
    const before = await this.getDetail(tx, branchId);
    if (!before.hasLogo) return before;

    await tx.branch.update({
      where: { id: branchId },
      data: {
        letterheadLogo: null,
        letterheadLogoMime: null,
        letterheadLogoUpdatedAt: null,
        updatedBy: ctx.userId,
      },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BranchLetterheadChanged,
      entityType: 'branch',
      entityId: branchId,
      before: { hasLogo: true },
      after: { hasLogo: false },
    });
    return this.getDetail(tx, branchId);
  }

  async getLogo(
    tx: Tx,
    branchId: string,
  ): Promise<{ bytes: Buffer; mime: string; updatedAt: Date } | null> {
    const row = await tx.branch.findFirst({
      where: { id: branchId },
      select: {
        letterheadLogo: true,
        letterheadLogoMime: true,
        letterheadLogoUpdatedAt: true,
      },
    });
    if (!row?.letterheadLogo) return null;
    return {
      bytes: Buffer.from(row.letterheadLogo),
      mime: row.letterheadLogoMime ?? 'application/octet-stream',
      updatedAt: row.letterheadLogoUpdatedAt ?? new Date(0),
    };
  }
}

type BranchRow = {
  letterhead: unknown;
  letterheadLogoUpdatedAt: Date | null;
} & Omit<BranchDetail, 'letterhead' | 'hasLogo'>;

function toDetail(row: BranchRow): BranchDetail {
  const { letterheadLogoUpdatedAt, ...rest } = row;
  return {
    ...rest,
    letterhead: resolveLetterhead(row.letterhead),
    hasLogo: letterheadLogoUpdatedAt !== null,
  };
}
