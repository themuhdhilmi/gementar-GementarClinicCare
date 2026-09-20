import { Injectable } from '@nestjs/common';
import { ProductStatus, ProductType } from '../../generated/prisma/enums.js';
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
import type { TenantContext } from '../tenancy/tenant-context.js';
import { fromSen, toSen } from './money.js';
import { ProductRetirementRegistry } from './retirement.registry.js';

export type ProductInput = {
  sku?: string;
  name: string;
  type: ProductType;
  categoryId?: string | null;
  brand?: string | null;
  genericName?: string | null;
  drugClass?: string | null;
  form?: string | null;
  strengthText?: string | null;
  strengthValue?: number | null;
  strengthUnit?: string | null;
  dispenseUnit: string;
  packSize?: number;
  isPackDispensed?: boolean;
  isBatched?: boolean;
  isControlled?: boolean;
  isColdChain?: boolean;
  maxDailyDose?: number | null;
  maxDailyDoseUnit?: string | null;
  defaultDose?: number | null;
  defaultDoseUnit?: string | null;
  defaultRoute?: string | null;
  defaultFrequency?: string | null;
  /** In ringgit, as typed. Stored as sen. */
  sellingPrice?: number | null;
  barcodes?: string[];
  notes?: string | null;
};

/** Units a dose or a pack can be counted in. Fixed, so search works. */
export const DISPENSE_UNITS = [
  'tab', 'cap', 'ml', 'mg', 'g', 'bottle', 'tube', 'sachet', 'pcs', 'vial',
  'ampoule', 'patch', 'drop', 'puff', 'application', 'unit',
] as const;

/**
 * The catalogue: what the clinic sells and uses.
 *
 * Built ahead of the rest of inventory because prescribing needs it. The
 * fields that matter most here are the two nobody would guess: the generic
 * name and the drug class. A brand name tells an allergy check nothing —
 * a patient allergic to penicillin is allergic to Augmentin whether or not
 * anybody wrote that down.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    /** Injected, so the catalogue does not know what stock is. */
    private readonly retirement: ProductRetirementRegistry,
  ) {}

  async getOrThrow(tx: Tx, id: string) {
    const product = await tx.product.findFirst({ where: { id } });
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  /**
   * INV-F-06: what a dispenser types, and what comes back.
   *
   * One query over a trigram index on name, generic, brand, strength and
   * SKU together, because somebody typing "amox" should find Amoxicillin
   * whether it is on the shelf as Amoxil or as its generic.
   */
  async search(
    query: string,
    options: { type?: ProductType; includeInactive?: boolean; limit?: number } = {},
  ) {
    const tx = this.db.tx();
    const text = query.trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    // A barcode is scanned, not typed, and has to be an exact hit.
    if (/^\d{6,}$/.test(text)) {
      const scanned = await tx.product.findMany({
        where: { barcodes: { has: text }, ...(options.includeInactive ? {} : { status: ProductStatus.ACTIVE }) },
        take: limit,
      });
      if (scanned.length > 0) return scanned.map((row) => this.present(row));
    }

    if (text.length < 2) return [];

    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
         FROM product
        WHERE tenant_id = $1::uuid
          AND ($2::boolean OR status = 'ACTIVE')
          AND ($3::text IS NULL OR type = $3::text::"ProductType")
          AND search_text LIKE '%' || $4::text || '%'
        ORDER BY
          -- What was typed, at the start of the name, first.
          CASE WHEN lower(name) LIKE $4::text || '%' THEN 0 ELSE 1 END,
          similarity(search_text, $4::text) DESC,
          name ASC
        LIMIT ${limit}`,
      requireTenantId(),
      options.includeInactive ?? false,
      options.type ?? null,
      text,
    );

    if (rows.length === 0) return [];
    const products = await tx.product.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const order = new Map(rows.map((row, index) => [row.id, index]));
    return products
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => this.present(row));
  }

  async create(ctx: TenantContext, input: ProductInput) {
    const tx = this.db.tx();
    this.assertUsable(input);

    const sku = (input.sku ?? (await this.nextSku(tx, input.type))).trim().toUpperCase();
    const clash = await tx.product.findFirst({ where: { sku }, select: { id: true, name: true } });
    if (clash) {
      throw new ConflictError(`${clash.name} already uses the code ${sku}.`, 'sku_taken');
    }

    const id = newId();
    const price = input.sellingPrice === null || input.sellingPrice === undefined
      ? 0
      : toSen(input.sellingPrice);

    await tx.product.create({
      data: {
        id,
        tenantId: requireTenantId(),
        sku,
        ...this.toRow(input),
        sellingPrice: BigInt(price),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });
    if (price > 0) await this.recordPrice(tx, ctx, id, price, 'Initial price');

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProductCreated,
      entityType: 'product',
      entityId: id,
      after: { sku, name: input.name, type: input.type, price: fromSen(price) },
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  async update(ctx: TenantContext, id: string, input: Partial<ProductInput> & { priceReason?: string }) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, id);

    // Only what was actually sent. A request body carries every optional
    // property as `undefined`, and spreading those over the existing row
    // would blank the name of a product whose price was being changed.
    const given = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    const merged = { ...this.fromRow(before), ...given } as ProductInput;
    this.assertUsable(merged);

    const data: Record<string, unknown> = { ...this.toRow(merged), updatedBy: ctx.userId };
    // The code appears on invoices and stock records, so it does not move.
    delete data['sku'];

    let newPrice: number | null = null;
    if (given['sellingPrice'] !== undefined && given['sellingPrice'] !== null) {
      newPrice = toSen(given['sellingPrice'] as number);
      data['sellingPrice'] = BigInt(newPrice);
    }

    await tx.product.update({ where: { id }, data });
    if (newPrice !== null && BigInt(newPrice) !== before.sellingPrice) {
      await this.recordPrice(tx, ctx, id, newPrice, input.priceReason ?? 'Price changed');
    }

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProductUpdated,
      entityType: 'product',
      entityId: id,
      before: { name: before.name, price: fromSen(before.sellingPrice) },
      after: { name: merged.name, price: fromSen(newPrice ?? Number(before.sellingPrice)) },
      reason: input.priceReason ?? null,
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  /**
   * INV-F-05: a product is retired, never deleted.
   *
   * The specification blocks it while any branch holds stock. There is no
   * stock yet, so the check is registered by the stock half of inventory
   * when it arrives — the same pattern as the branch deactivation guard.
   * Retiring keeps it on every prescription and invoice that already
   * names it.
   */
  async retire(ctx: TenantContext, id: string, reason: string) {
    const tx = this.db.tx();
    const before = await this.getOrThrow(tx, id);
    if (before.status === ProductStatus.INACTIVE) return this.present(before);

    const blockers = await this.retirement.blockers(tx, id);
    if (blockers.length > 0) {
      throw new ConflictError(
        `${before.name} cannot be retired: ${blockers.map((b) => b.detail).join('; ')}.`,
        'product_in_use',
        { blockers },
      );
    }

    await tx.product.update({
      where: { id },
      data: { status: ProductStatus.INACTIVE, updatedBy: ctx.userId },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProductRetired,
      entityType: 'product',
      entityId: id,
      before: { status: before.status },
      after: { status: ProductStatus.INACTIVE },
      reason,
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  async reinstate(ctx: TenantContext, id: string) {
    const tx = this.db.tx();
    await tx.product.update({
      where: { id },
      data: { status: ProductStatus.ACTIVE, updatedBy: ctx.userId },
    });
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ProductUpdated,
      entityType: 'product',
      entityId: id,
      after: { status: ProductStatus.ACTIVE },
    });
    return this.present(await this.getOrThrow(tx, id));
  }

  async priceHistory(tx: Tx, productId: string) {
    const rows = await tx.productPriceHistory.findMany({
      where: { productId },
      orderBy: { effectiveFrom: 'desc' },
    });
    return rows.map((row) => ({
      ...row,
      sellingPrice: fromSen(row.sellingPrice),
      effectiveFrom: row.effectiveFrom.toISOString(),
    }));
  }

  // ------------------------------------------------------------ helpers

  private async recordPrice(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    sellingPrice: number,
    reason: string,
  ) {
    await tx.productPriceHistory.create({
      data: {
        id: newId(),
        tenantId: requireTenantId(),
        productId,
        sellingPrice: BigInt(sellingPrice),
        effectiveFrom: this.clock.now(),
        setBy: ctx.userId,
        reason,
      },
    });
  }

  /** `MED-0001`, so a clinic that does not keep its own codes need not. */
  private async nextSku(tx: Tx, type: ProductType): Promise<string> {
    const prefix = type === ProductType.MEDICINE ? 'MED' : type === ProductType.CONSUMABLE ? 'CON' : 'ITM';
    const [row] = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(sku, '^${prefix}-', ''), '')::int), 0) AS n
         FROM product
        WHERE tenant_id = $1::uuid AND sku ~ ('^${prefix}-[0-9]+$')`,
      requireTenantId(),
    );
    return `${prefix}-${String(Number(row?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  /**
   * The same rules `create` applies, without writing anything.
   *
   * The import's dry run calls this so its report is a promise rather than
   * a guess. It was not, at first: the dry run skipped straight to a
   * verdict and cheerfully said it would import a medicine with no generic
   * name, which the real run would then reject.
   */
  validate(input: ProductInput): void {
    this.assertUsable(input);
    if (input.sellingPrice !== null && input.sellingPrice !== undefined) {
      toSen(input.sellingPrice);
    }
  }

  private assertUsable(input: ProductInput) {
    const name = input.name?.trim() ?? '';
    if (name.length < 2) {
      throw new BadRequestError('A product needs a name.', 'invalid_product');
    }
    if (!DISPENSE_UNITS.includes(input.dispenseUnit as never)) {
      throw new BadRequestError(
        `"${input.dispenseUnit}" is not a unit things are handed over in. ` +
          `One of: ${DISPENSE_UNITS.join(', ')}.`,
        'invalid_unit',
      );
    }
    // The rule this whole table exists to support. Also a database check
    // constraint, because an import is the likeliest way one slips through.
    if (input.type === ProductType.MEDICINE && !(input.genericName ?? '').trim()) {
      throw new BadRequestError(
        'A medicine needs its generic name. Allergies are recorded against the substance, ' +
          'not the brand, and without it nothing can warn that a patient allergic to ' +
          'penicillin has been prescribed Augmentin.',
        'generic_name_required',
      );
    }
    if ((input.packSize ?? 1) < 1) {
      throw new BadRequestError('A pack holds at least one.', 'invalid_pack_size');
    }
  }

  private toRow(input: ProductInput) {
    return {
      name: input.name.trim(),
      type: input.type,
      categoryId: input.categoryId ?? null,
      brand: input.brand?.trim() || null,
      genericName: input.genericName?.trim() || null,
      drugClass: input.drugClass?.trim().toLowerCase() || null,
      form: input.form?.trim() || null,
      strengthText: input.strengthText?.trim() || null,
      strengthValue: input.strengthValue ?? null,
      strengthUnit: input.strengthUnit?.trim() || null,
      dispenseUnit: input.dispenseUnit,
      packSize: input.packSize ?? 1,
      isPackDispensed: input.isPackDispensed ?? false,
      isBatched: input.isBatched ?? true,
      isControlled: input.isControlled ?? false,
      isColdChain: input.isColdChain ?? false,
      maxDailyDose: input.maxDailyDose ?? null,
      maxDailyDoseUnit: input.maxDailyDoseUnit?.trim() || null,
      defaultDose: input.defaultDose ?? null,
      defaultDoseUnit: input.defaultDoseUnit?.trim() || null,
      defaultRoute: input.defaultRoute?.trim().toUpperCase() || null,
      defaultFrequency: input.defaultFrequency?.trim().toUpperCase() || null,
      barcodes: (input.barcodes ?? []).map((b) => b.trim()).filter(Boolean),
      notes: input.notes?.trim() || null,
    };
  }

  private fromRow(row: Awaited<ReturnType<CatalogueService['getOrThrow']>>): ProductInput {
    return {
      name: row.name,
      type: row.type,
      categoryId: row.categoryId,
      brand: row.brand,
      genericName: row.genericName,
      drugClass: row.drugClass,
      form: row.form,
      strengthText: row.strengthText,
      strengthValue: row.strengthValue === null ? null : Number(row.strengthValue),
      strengthUnit: row.strengthUnit,
      dispenseUnit: row.dispenseUnit,
      packSize: row.packSize,
      isPackDispensed: row.isPackDispensed,
      isBatched: row.isBatched,
      isControlled: row.isControlled,
      isColdChain: row.isColdChain,
      maxDailyDose: row.maxDailyDose === null ? null : Number(row.maxDailyDose),
      maxDailyDoseUnit: row.maxDailyDoseUnit,
      defaultDose: row.defaultDose === null ? null : Number(row.defaultDose),
      defaultDoseUnit: row.defaultDoseUnit,
      defaultRoute: row.defaultRoute,
      defaultFrequency: row.defaultFrequency,
      barcodes: row.barcodes,
      notes: row.notes,
    };
  }

  present(row: Awaited<ReturnType<CatalogueService['getOrThrow']>>) {
    return {
      ...row,
      strengthValue: row.strengthValue === null ? null : Number(row.strengthValue),
      maxDailyDose: row.maxDailyDose === null ? null : Number(row.maxDailyDose),
      defaultDose: row.defaultDose === null ? null : Number(row.defaultDose),
      markupPct: row.markupPct === null ? null : Number(row.markupPct),
      sellingPrice: fromSen(row.sellingPrice),
      sellingPriceSen: Number(row.sellingPrice),
      /** What a prescription or an invoice line calls it. */
      label: [row.name, row.strengthText, row.form].filter(Boolean).join(' '),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
