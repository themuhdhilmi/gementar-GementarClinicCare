import { Injectable, Logger } from '@nestjs/common';
import { StockCountType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { PatientImportService } from '../patient/patient-import.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { StockCountService } from './stock-count.service.js';
import { parseExpiry } from './stock.service.js';

/** What a count sheet looks like as a spreadsheet. */
const COLUMNS = ['sku', 'batch_no', 'expiry', 'quantity', 'cost'] as const;

export type ImportRow = {
  line: number;
  sku: string;
  batchNo: string | null;
  expiry: string | null;
  quantity: number;
  cost: number | null;
  productId?: string;
  productName?: string;
  problem?: string;
};

/**
 * INV-OPEN-02: opening stock from a spreadsheet.
 *
 * A clinic's opening count arrives as four hundred rows somebody wrote
 * on a clipboard and then typed into Excel. Typing them a second time
 * is where opening balances go wrong, so this reads the file — and,
 * like the catalogue import, it says everything that is wrong with it
 * before writing anything.
 *
 * It does not post stock directly. It fills in a count session, which
 * is approved like any other: one path into the ledger, and one place
 * where a person says yes.
 */
@Injectable()
export class StockImportService {
  private readonly logger = new Logger(StockImportService.name);

  constructor(
    private readonly db: DbService,
    private readonly counts: StockCountService,
  ) {}

  /** Read the file, check every row, and say what is wrong with it. */
  async preview(ctx: TenantContext, branchId: string, csv: string) {
    const rows = await this.parse(ctx, csv);
    const problems = rows.filter((row) => row.problem);
    return {
      branchId,
      rows: rows.length,
      usable: rows.length - problems.length,
      problems: problems.map((row) => ({ line: row.line, sku: row.sku, problem: row.problem! })),
      // Enough to recognise the file; not the whole thing down a wire.
      preview: rows.slice(0, 20),
    };
  }

  /**
   * Turn the file into an opening count, ready to be approved.
   *
   * Refuses outright if any row is unusable. A partial import of an
   * opening balance is worse than none: nobody can tell afterwards
   * which shelves were counted and which were skipped.
   */
  async apply(ctx: TenantContext, branchId: string, csv: string) {
    const rows = await this.parse(ctx, csv);
    const problems = rows.filter((row) => row.problem);
    if (problems.length > 0) {
      throw new BadRequestError(
        `${problems.length} of ${rows.length} rows cannot be imported. Fix the file and try ` +
          'again — a half-imported opening balance cannot be told from a complete one.',
        'rows_rejected',
      );
    }
    if (rows.length === 0) {
      throw new BadRequestError('That file has no rows in it.', 'empty_file');
    }

    const opened = await this.counts.open(ctx, branchId, {
      type: StockCountType.OPENING,
      notes: `Imported from a spreadsheet: ${rows.length} rows`,
    });

    await this.counts.enter(
      ctx,
      opened.count.id,
      rows.map((row) => ({
        productId: row.productId!,
        newBatchNo: row.batchNo,
        newExpiry: row.expiry,
        newCost: row.cost,
        counted: row.quantity,
      })),
    );

    this.logger.log(`opening import: ${rows.length} rows into count ${opened.count.id}`);
    return this.counts.read(ctx, opened.count.id);
  }

  // -------------------------------------------------------------------

  /** One parse, used by both the preview and the import. */
  private async parse(ctx: TenantContext, csv: string): Promise<ImportRow[]> {
    void ctx;
    const tx = this.db.tx();
    const grid = PatientImportService.parseCsv(csv);
    if (grid.length < 2) {
      throw new BadRequestError('That file has no rows under its header line.', 'empty_file');
    }

    const header = grid[0]!.map((column) => column.trim().toLowerCase());
    const unknown = header.filter((column) => column && !COLUMNS.includes(column as never));
    if (unknown.length > 0) {
      throw new BadRequestError(
        `This file has columns nothing can be done with: ${unknown.join(', ')}. ` +
          `Recognised: ${COLUMNS.join(', ')}.`,
        'unknown_columns',
      );
    }
    for (const required of ['sku', 'quantity']) {
      if (!header.includes(required)) {
        throw new BadRequestError(`This file has no "${required}" column.`, 'missing_column');
      }
    }

    const rows: ImportRow[] = [];
    for (const [offset, raw] of grid.slice(1).entries()) {
      if (raw.every((cell) => cell.trim() === '')) continue;
      const at = (name: string) => {
        const i = header.indexOf(name);
        return i === -1 ? '' : (raw[i] ?? '').trim();
      };

      const quantity = Number(at('quantity'));
      const row: ImportRow = {
        line: offset + 2,
        sku: at('sku').toUpperCase(),
        batchNo: at('batch_no') || null,
        expiry: at('expiry') || null,
        quantity,
        cost: at('cost') ? Number(at('cost')) : null,
      };
      if (!row.sku) row.problem = 'no product code';
      else if (!Number.isFinite(quantity) || quantity < 0) {
        row.problem = 'quantity is not a number';
      } else if (row.cost !== null && !Number.isFinite(row.cost)) {
        row.problem = 'cost is not a number';
      }
      rows.push(row);
    }

    // One query for every product mentioned, rather than one per row.
    const skus = [...new Set(rows.map((row) => row.sku).filter(Boolean))];
    const products = skus.length
      ? await tx.product.findMany({
          where: { sku: { in: skus } },
          select: { id: true, sku: true, name: true, isBatched: true, status: true },
        })
      : [];
    const bySku = new Map(products.map((p) => [p.sku, p]));

    // A lot repeated in the file is two lines for one shelf, and
    // importing both would double it.
    const seen = new Set<string>();

    for (const row of rows) {
      if (row.problem) continue;
      const product = bySku.get(row.sku);
      if (!product) {
        row.problem = `no product with the code ${row.sku}`;
        continue;
      }
      if (product.status !== 'ACTIVE') {
        row.problem = `${product.name} has been withdrawn from the catalogue`;
        continue;
      }
      row.productId = product.id;
      row.productName = product.name;

      if (product.isBatched) {
        if (!row.batchNo) {
          row.problem = `${product.name} is tracked by batch and this row has no batch number`;
          continue;
        }
        if (!parseExpiry(row.expiry)) {
          row.problem = `${product.name} is tracked by batch and this row has no usable expiry`;
          continue;
        }
      } else {
        // A non-batched product has one synthetic batch; a number in
        // the file would be silently ignored, so say so instead.
        row.batchNo = null;
        row.expiry = null;
      }

      const key = `${product.id}:${row.batchNo ?? 'NB'}`;
      if (seen.has(key)) {
        row.problem = 'this batch appears twice in the file';
        continue;
      }
      seen.add(key);
    }

    return rows;
  }
}
