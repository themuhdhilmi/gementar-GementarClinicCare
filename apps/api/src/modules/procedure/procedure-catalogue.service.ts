import { Injectable } from '@nestjs/common';
import { ProcedureCategory, ProductStatus, ProductType } from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { fromSen, toSen } from '../catalogue/money.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type ProcedureInput = {
  code?: string;
  name: string;
  category: ProcedureCategory;
  /** Ringgit, as typed. Stored as sen. */
  price: number;
  requiresConsent?: boolean;
  requiresDoctor?: boolean;
  vaccineProductId?: string | null;
  defaultDurationMin?: number | null;
  protocol?: string | null;
  consumables?: Array<{ productId: string; quantity: number; optional?: boolean }>;
};

/**
 * PRC-F-01 … F-04: what the clinic does, what it costs, and what it uses.
 *
 * The consumable mapping is the part that earns its keep. A nebuliser
 * uses a mask and a respule every single time, and a clinic that relies
 * on a nurse remembering to write that down has stock figures that drift
 * by exactly as much as the nurse is busy.
 */
@Injectable()
export class ProcedureCatalogueService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: TenantContext, options: { q?: string; category?: ProcedureCategory; includeInactive?: boolean } = {}) {
    void ctx;
    const tx = this.db.tx();
    const text = (options.q ?? '').trim().toLowerCase();

    const rows = await tx.procedureCatalog.findMany({
      where: {
        ...(options.includeInactive ? {} : { status: ProductStatus.ACTIVE }),
        ...(options.category ? { category: options.category } : {}),
        ...(text.length >= 2
          ? { OR: [{ name: { contains: text, mode: 'insensitive' } }, { code: { contains: text, mode: 'insensitive' } }] }
          : {}),
      },
      include: { consumables: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      take: 200,
    });

    const productIds = [...new Set(rows.flatMap((row) => row.consumables.map((c) => c.productId)))];
    const products = productIds.length
      ? await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, dispenseUnit: true, isBatched: true },
        })
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    return { items: rows.map((row) => this.present(row, byId)) };
  }

  async getOrThrow(tx: Tx, id: string) {
    const row = await tx.procedureCatalog.findFirst({
      where: { id },
      include: { consumables: true },
    });
    if (!row) throw new NotFoundError('Procedure');
    return row;
  }

  async read(ctx: TenantContext, id: string) {
    void ctx;
    const tx = this.db.tx();
    const row = await this.getOrThrow(tx, id);
    const products = await tx.product.findMany({
      where: { id: { in: row.consumables.map((c) => c.productId) } },
      select: { id: true, name: true, dispenseUnit: true, isBatched: true },
    });
    return this.present(row, new Map(products.map((p) => [p.id, p])));
  }

  async create(ctx: TenantContext, input: ProcedureInput) {
    const tx = this.db.tx();
    await this.validate(tx, input);

    const code = (input.code ?? (await this.nextCode(tx, input.category))).trim().toUpperCase();
    const clash = await tx.procedureCatalog.findFirst({ where: { code }, select: { name: true } });
    if (clash) throw new ConflictError(`${clash.name} already uses the code ${code}.`, 'code_taken');

    const id = newId();
    const now = this.clock.now();

    await tx.procedureCatalog.create({
      data: {
        id,
        tenantId: requireTenantId(),
        code,
        name: input.name.trim(),
        category: input.category,
        price: BigInt(toSen(input.price)),
        requiresConsent: input.requiresConsent ?? false,
        requiresDoctor: input.requiresDoctor ?? false,
        vaccineProductId: input.vaccineProductId ?? null,
        defaultDurationMin: input.defaultDurationMin ?? null,
        protocol: input.protocol?.trim() || null,
        createdBy: ctx.userId,
        createdAt: now,
      },
    });

    await this.replaceConsumables(tx, id, input.consumables ?? []);
    await this.recordPrice(tx, ctx, id, BigInt(toSen(input.price)), 'Added to the catalogue');

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureCreated,
      entityType: 'procedure_catalog',
      entityId: id,
      after: { code, name: input.name, price: input.price, category: input.category },
    });

    return this.read(ctx, id);
  }

  async update(ctx: TenantContext, id: string, input: Partial<ProcedureInput> & { priceReason?: string }) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, id);

    // class-transformer leaves an absent optional as undefined, and
    // spreading that over the row would blank the field. Only what was
    // actually sent is merged.
    const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const merged = {
      name: before.name,
      category: before.category,
      price: Number(fromSen(before.price)),
      requiresConsent: before.requiresConsent,
      requiresDoctor: before.requiresDoctor,
      vaccineProductId: before.vaccineProductId,
      defaultDurationMin: before.defaultDurationMin,
      protocol: before.protocol,
      ...given,
    } as ProcedureInput & { priceReason?: string };

    await this.validate(tx, merged);

    const priceSen = BigInt(toSen(merged.price));
    await tx.procedureCatalog.update({
      where: { id },
      data: {
        name: merged.name.trim(),
        category: merged.category,
        price: priceSen,
        requiresConsent: merged.requiresConsent ?? false,
        requiresDoctor: merged.requiresDoctor ?? false,
        vaccineProductId: merged.vaccineProductId ?? null,
        defaultDurationMin: merged.defaultDurationMin ?? null,
        protocol: merged.protocol?.trim() || null,
      },
    });

    if (input.consumables !== undefined) {
      await this.replaceConsumables(tx, id, input.consumables);
    }

    if (priceSen !== before.price) {
      await this.recordPrice(tx, ctx, id, priceSen, input.priceReason ?? 'Price changed');
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureUpdated,
      entityType: 'procedure_catalog',
      entityId: id,
      before: { name: before.name, price: fromSen(before.price) },
      after: { name: merged.name, price: merged.price },
    });

    return this.read(ctx, id);
  }

  async retire(ctx: TenantContext, id: string, reason: string) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, id);

    // An ordered-but-not-performed procedure would be left unperformable.
    const pending = await tx.encounterProcedure.count({
      where: { procedureId: id, status: 'ORDERED' },
    });
    if (pending > 0) {
      throw new ConflictError(
        pending === 1
          ? 'One patient is still waiting for this procedure. Perform or cancel it first.'
          : `${pending} patients are still waiting for this procedure. Perform or cancel them first.`,
        'ordered_outstanding',
      );
    }

    await tx.procedureCatalog.update({ where: { id }, data: { status: ProductStatus.INACTIVE } });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProcedureRetired,
      entityType: 'procedure_catalog',
      entityId: id,
      reason,
      before: { status: before.status },
      after: { status: ProductStatus.INACTIVE },
    });
    return this.read(ctx, id);
  }

  async priceHistory(ctx: TenantContext, id: string) {
    void ctx;
    const tx = this.db.tx();
    const rows = await tx.procedurePriceHistory.findMany({
      where: { procedureId: id },
      orderBy: { effectiveFrom: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      price: fromSen(row.price),
      effectiveFrom: row.effectiveFrom,
      setBy: row.setBy,
      reason: row.reason,
    }));
  }

  // -------------------------------------------------------------------

  private async validate(tx: Tx, input: ProcedureInput) {
    if (!input.name?.trim()) {
      throw new BadRequestError('A procedure needs a name.', 'name_required');
    }
    if (!(input.price >= 0)) {
      throw new BadRequestError('A price cannot be negative.', 'invalid_price');
    }

    if (input.category === ProcedureCategory.VACCINATION) {
      if (!input.vaccineProductId) {
        throw new BadRequestError(
          'A vaccination has to name the vaccine, or its batch and expiry never reach the patient’s record.',
          'vaccine_required',
        );
      }
      const vaccine = await tx.product.findFirst({ where: { id: input.vaccineProductId } });
      if (!vaccine) throw new NotFoundError('Vaccine product');
      if (vaccine.type !== ProductType.MEDICINE) {
        throw new BadRequestError(
          `${vaccine.name} is not a medicine, so it cannot be the vaccine given.`,
          'not_a_medicine',
        );
      }
    } else if (input.vaccineProductId) {
      throw new BadRequestError(
        'Only a vaccination names a vaccine.',
        'vaccine_on_non_vaccination',
      );
    }

    for (const line of input.consumables ?? []) {
      if (!(line.quantity > 0)) {
        throw new BadRequestError('A consumable needs a quantity.', 'invalid_quantity');
      }
      const product = await tx.product.findFirst({ where: { id: line.productId } });
      if (!product) throw new NotFoundError('Consumable product');
      if (product.status !== ProductStatus.ACTIVE) {
        throw new ConflictError(
          `${product.name} has been withdrawn from the catalogue.`,
          'product_retired',
        );
      }
    }
  }

  private async replaceConsumables(
    tx: Tx,
    procedureId: string,
    lines: Array<{ productId: string; quantity: number; optional?: boolean }>,
  ) {
    await tx.procedureConsumable.deleteMany({ where: { procedureId } });
    for (const line of lines) {
      await tx.procedureConsumable.create({
        data: {
          id: newId(),
          tenantId: requireTenantId(),
          procedureId,
          productId: line.productId,
          quantity: line.quantity,
          optional: line.optional ?? false,
        },
      });
    }
  }

  private async recordPrice(
    tx: Tx,
    ctx: TenantContext,
    procedureId: string,
    price: bigint,
    reason: string,
  ) {
    await tx.procedurePriceHistory.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        procedureId,
        price,
        effectiveFrom: this.clock.now(),
        setBy: ctx.userId,
        reason,
      },
    });
  }

  /** PRC-0001, NEB-0002 — readable, and never reused. */
  private async nextCode(tx: Tx, category: ProcedureCategory): Promise<string> {
    const prefix = CODE_PREFIX[category];
    const rows = await tx.procedureCatalog.findMany({
      where: { code: { startsWith: `${prefix}-` } },
      select: { code: true },
    });
    const highest = rows.reduce((max, row) => {
      const n = Number(row.code.slice(prefix.length + 1));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    return `${prefix}-${String(highest + 1).padStart(4, '0')}`;
  }

  private present(
    row: {
      id: string;
      code: string;
      name: string;
      category: ProcedureCategory;
      price: bigint;
      requiresConsent: boolean;
      requiresDoctor: boolean;
      vaccineProductId: string | null;
      defaultDurationMin: number | null;
      protocol: string | null;
      status: ProductStatus;
      consumables: Array<{ id: string; productId: string; quantity: unknown; optional: boolean }>;
    },
    products: Map<string, { id: string; name: string; dispenseUnit: string; isBatched: boolean }>,
  ) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      price: fromSen(row.price),
      priceSen: Number(row.price),
      requiresConsent: row.requiresConsent,
      requiresDoctor: row.requiresDoctor,
      vaccineProductId: row.vaccineProductId,
      defaultDurationMin: row.defaultDurationMin,
      protocol: row.protocol,
      status: row.status,
      consumables: row.consumables.map((line) => ({
        id: line.id,
        productId: line.productId,
        quantity: Number(line.quantity),
        optional: line.optional,
        product: products.get(line.productId) ?? null,
      })),
    };
  }
}

const CODE_PREFIX: Record<ProcedureCategory, string> = {
  INJECTION: 'INJ',
  NEBULISER: 'NEB',
  DRESSING: 'DRS',
  MINOR_SURGERY: 'SUR',
  VACCINATION: 'VAC',
  SCREENING: 'SCR',
  OTHER: 'PRC',
};
