import { Injectable } from '@nestjs/common';
import { ProductStatus } from '../../generated/prisma/enums.js';
import { ConflictError, NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { formatSen, ringgitToSen } from './money.js';

/**
 * BIL-F-03: the short list of things a cashier adds by hand.
 *
 * A medical report fee, a dressing pack, an injection fee. Kept as a
 * catalogue rather than free text so that "medical report" is one row
 * in a report rather than eleven spellings of one.
 */
@Injectable()
export class BillableItemService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, includeInactive = false) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.billableItem.findMany({
      where: includeInactive ? {} : { status: ProductStatus.ACTIVE },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        defaultPrice: formatSen(row.defaultPrice),
        taxCode: row.taxCode,
        category: row.category,
        status: row.status,
      })),
    };
  }

  async create(
    ctx: TenantContext,
    input: { code?: string; name: string; defaultPrice: number; taxCode?: string; category?: string },
  ) {
    const tx = this.db.tx();
    const code = (input.code ?? (await this.nextCode(tx))).trim().toUpperCase();
    const clash = await tx.billableItem.findFirst({ where: { code }, select: { name: true } });
    if (clash) throw new ConflictError(`${clash.name} already uses the code ${code}.`, 'code_taken');

    const id = newId();
    await tx.billableItem.create({
      data: {
        id,
        tenantId: requireTenantId(),
        code,
        name: input.name.trim(),
        defaultPrice: ringgitToSen(input.defaultPrice),
        taxCode: input.taxCode ?? 'NONE',
        category: input.category?.trim() || null,
      },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BillableItemChanged,
      entityType: 'billable_item',
      entityId: id,
      after: { code, name: input.name, defaultPrice: String(input.defaultPrice) },
    });
    return this.list(ctx, true);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: { name?: string; defaultPrice?: number; taxCode?: string; category?: string; active?: boolean },
  ) {
    const tx = this.db.tx();
    const before = await tx.billableItem.findFirst({ where: { id } });
    if (!before) throw new NotFoundError('Billable item');

    await tx.billableItem.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.defaultPrice === undefined
          ? {}
          : { defaultPrice: ringgitToSen(input.defaultPrice) }),
        ...(input.taxCode === undefined ? {} : { taxCode: input.taxCode }),
        ...(input.category === undefined ? {} : { category: input.category?.trim() || null }),
        ...(input.active === undefined
          ? {}
          : { status: input.active ? ProductStatus.ACTIVE : ProductStatus.INACTIVE }),
      },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.BillableItemChanged,
      entityType: 'billable_item',
      entityId: id,
      before: { name: before.name, defaultPrice: formatSen(before.defaultPrice) },
      after: input,
    });
    return this.list(ctx, true);
  }

  private async nextCode(tx: ReturnType<DbService['tx']>): Promise<string> {
    const rows = await tx.billableItem.findMany({ select: { code: true } });
    const highest = rows.reduce((max, row) => {
      const n = Number(row.code.replace(/\D/g, ''));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    return `BIL-${String(highest + 1).padStart(4, '0')}`;
  }
}
