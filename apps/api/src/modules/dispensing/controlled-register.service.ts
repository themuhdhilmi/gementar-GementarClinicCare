import { Injectable } from '@nestjs/common';
import { ControlledEntryType } from '../../generated/prisma/enums.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type RegisterEntry = {
  branchId: string;
  productId: string;
  entryType: ControlledEntryType;
  referenceType?: string | null;
  referenceId?: string | null;
  patientId?: string | null;
  patientName?: string | null;
  /** Unmasked, deliberately. See the note on `record`. */
  patientIc?: string | null;
  prescriberId?: string | null;
  prescriberName?: string | null;
  batchId?: string | null;
  batchNo?: string | null;
  quantityIn?: number;
  quantityOut?: number;
  witnessId?: string | null;
  witnessName?: string | null;
};

/**
 * The controlled drug register (DSP-F-18, F-19).
 *
 * This is the one part of the system with a statute behind it rather
 * than a clinic's preference. It is append-only at the database level,
 * it carries a running balance per product per branch, and it records
 * the patient's identity number unmasked — because an inspector reading
 * it in two years needs to know who was given a controlled drug, and a
 * masked number answers nobody's question.
 *
 * That last point is the reason every read of it is audited.
 */
@Injectable()
export class ControlledRegisterService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * One entry, with the balance it leaves behind.
   *
   * The balance is computed under a lock on the product's previous
   * entries, for the same reason the stock ledger locks a batch: two
   * dispensers registering at the same instant would otherwise both read
   * the same previous balance and write the same new one, and a register
   * whose running balance does not run is not a register.
   */
  async record(tx: Tx, ctx: TenantContext, entry: RegisterEntry) {
    // Serialise on the product row itself. It is the cheapest thing that
    // every entry for this product has in common.
    await tx.$queryRaw`
      SELECT id FROM product WHERE id = ${entry.productId}::uuid FOR UPDATE
    `;

    const previous = await tx.controlledDrugRegister.findFirst({
      where: { branchId: entry.branchId, productId: entry.productId },
      orderBy: { occurredAt: 'desc' },
      select: { balanceAfter: true },
    });

    const quantityIn = entry.quantityIn ?? 0;
    const quantityOut = entry.quantityOut ?? 0;
    const balanceAfter =
      Math.round((Number(previous?.balanceAfter ?? 0) + quantityIn - quantityOut) * 1000) / 1000;

    const id = newId();
    await tx.controlledDrugRegister.create({
      data: {
        id,
        tenantId: requireTenantId(),
        branchId: entry.branchId,
        productId: entry.productId,
        entryType: entry.entryType,
        referenceType: entry.referenceType ?? null,
        referenceId: entry.referenceId ?? null,
        patientId: entry.patientId ?? null,
        patientName: entry.patientName ?? null,
        patientIc: entry.patientIc ?? null,
        prescriberId: entry.prescriberId ?? null,
        prescriberName: entry.prescriberName ?? null,
        batchId: entry.batchId ?? null,
        batchNo: entry.batchNo ?? null,
        quantityIn,
        quantityOut,
        balanceAfter,
        performedBy: ctx.userId,
        performedByName: ctx.userName,
        witnessId: entry.witnessId ?? null,
        witnessName: entry.witnessName ?? null,
        occurredAt: this.clock.now(),
      },
    });

    // PAT: the identity number was shown in full to write this down.
    if (entry.patientIc && entry.patientId) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.PatientIdUnmasked,
        entityType: 'patient',
        entityId: entry.patientId,
        subjectPatientId: entry.patientId,
        reason: 'Controlled drug register entry',
      });
    }

    return { id, balanceAfter };
  }

  /** What an inspector asks for: one product, one period, in order. */
  async read(
    ctx: TenantContext,
    branchId: string,
    options: { productId?: string; from?: Date; to?: Date } = {},
  ) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const rows = await tx.controlledDrugRegister.findMany({
      where: {
        branchId,
        ...(options.productId ? { productId: options.productId } : {}),
        ...(options.from || options.to
          ? {
              occurredAt: {
                ...(options.from ? { gte: options.from } : {}),
                ...(options.to ? { lte: options.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: 2000,
    });

    const products = await tx.product.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
      select: { id: true, name: true, strengthText: true, dispenseUnit: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    // Reading the register means reading unmasked identity numbers.
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ControlledRegisterViewed,
      entityType: 'branch',
      entityId: branchId,
      after: { productId: options.productId ?? null, rows: rows.length },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt,
        entryType: row.entryType,
        product: byId.get(row.productId) ?? null,
        patientName: row.patientName,
        patientIc: row.patientIc,
        prescriberName: row.prescriberName,
        batchNo: row.batchNo,
        quantityIn: Number(row.quantityIn),
        quantityOut: Number(row.quantityOut),
        balanceAfter: Number(row.balanceAfter),
        performedByName: row.performedByName,
        witnessName: row.witnessName,
      })),
    };
  }

  /**
   * DSP-F-19: the register's running balance against the stock ledger.
   *
   * They are two independent records of the same physical thing, kept
   * for different reasons, and they should agree. When they do not, one
   * of them is wrong and an inspector will find whichever it is.
   */
  async reconcile(ctx: TenantContext, branchId: string) {
    const tx = this.db.tx();
    if (!ctx.branchesWithRole.includes(branchId)) throw new NotFoundError('Branch');

    const controlled = await tx.product.findMany({
      where: { isControlled: true },
      select: { id: true, name: true, dispenseUnit: true },
    });

    const results = [];
    for (const product of controlled) {
      const latest = await tx.controlledDrugRegister.findFirst({
        where: { branchId, productId: product.id },
        orderBy: { occurredAt: 'desc' },
        select: { balanceAfter: true },
      });
      const onHand = await tx.productBatch.aggregate({
        where: { branchId, productId: product.id, status: 'ACTIVE' },
        _sum: { quantityOnHand: true },
      });

      const register = Number(latest?.balanceAfter ?? 0);
      const stock = Number(onHand._sum.quantityOnHand ?? 0);
      results.push({
        product,
        register,
        stock,
        difference: Math.round((register - stock) * 1000) / 1000,
        agrees: Math.abs(register - stock) < 0.0005,
      });
    }

    return {
      items: results,
      // Said in words, because "0 disagreements" and "nothing checked"
      // look the same on a dashboard.
      summary:
        controlled.length === 0
          ? 'This clinic stocks no controlled drugs.'
          : results.every((row) => row.agrees)
            ? `${results.length} controlled products, register and shelf agree on every one.`
            : `${results.filter((r) => !r.agrees).length} of ${results.length} controlled products disagree between the register and the shelf.`,
    };
  }
}
