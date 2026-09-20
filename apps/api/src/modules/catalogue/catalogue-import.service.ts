import { Injectable, Logger } from '@nestjs/common';
import { ProductType } from '../../generated/prisma/enums.js';
import { BadRequestError } from '../../shared/errors/domain-errors.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PatientImportService } from '../patient/patient-import.service.js';
import { CatalogueService } from './catalogue.service.js';

export type ProductVerdict = {
  row: number;
  action: 'IMPORT' | 'UPDATE' | 'SKIP_DUPLICATE' | 'REJECT';
  sku?: string;
  name?: string;
  message?: string;
};

const COLUMNS = [
  'sku', 'name', 'type', 'brand', 'generic_name', 'drug_class', 'form',
  'strength', 'dispense_unit', 'pack_size', 'is_controlled', 'is_cold_chain',
  'selling_price', 'barcode', 'default_dose', 'default_route', 'default_frequency',
  'max_daily_dose', 'notes',
] as const;

/**
 * INV-F-04: the clinic's existing product list, brought across.
 *
 * Every clinic has one, usually in a spreadsheet exported from whatever
 * they use now, and typing four hundred medicines in by hand is how a
 * migration stalls. Like the patient import, the dry run is the point: the
 * clinic sees exactly what would happen before anything is written.
 */
@Injectable()
export class CatalogueImportService {
  private readonly logger = new Logger(CatalogueImportService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  async run(
    ctx: TenantContext,
    filename: string,
    csv: string,
    options: { dryRun: boolean; updateExisting?: boolean },
  ) {
    // The same small reader as the patient import: quoted fields with
    // commas and newlines are all a clinic export actually uses.
    const rows = PatientImportService.parseCsv(csv);
    if (rows.length < 2) {
      throw new BadRequestError('That file has no rows under its header line.', 'import_empty');
    }

    const header = rows[0]!.map((h) => h.trim().toLowerCase().replaceAll(/[\s-]+/g, '_'));
    for (const required of ['name', 'type', 'dispense_unit']) {
      if (!header.includes(required)) {
        throw new BadRequestError(
          `The first line must name the columns and must include "${required}". ` +
            `Recognised columns: ${COLUMNS.join(', ')}.`,
          'import_no_header',
        );
      }
    }
    const unknown = header.filter((h) => h !== '' && !COLUMNS.includes(h as never));
    if (unknown.length > 0) {
      // Refused rather than ignored: a column nobody reads is usually a
      // column somebody expected to be read.
      throw new BadRequestError(
        `These columns are not recognised and would be ignored: ${unknown.join(', ')}. ` +
          `Recognised: ${COLUMNS.join(', ')}.`,
        'import_unknown_columns',
      );
    }

    const verdicts: ProductVerdict[] = [];
    const seen = new Map<string, number>();

    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index]!;
      const get = (column: (typeof COLUMNS)[number]): string => {
        const at = header.indexOf(column);
        return at === -1 ? '' : (cells[at] ?? '').trim();
      };
      const rowNumber = index + 1;

      try {
        const name = get('name');
        const typeRaw = (get('type') || 'MEDICINE').toUpperCase();
        if (!Object.values(ProductType).includes(typeRaw as ProductType)) {
          throw new BadRequestError(
            `"${typeRaw}" is not a kind of product. Use one of ${Object.values(ProductType).join(', ')}.`,
            'invalid_type',
          );
        }

        // Two rows for the same thing in one file is a mistake in the
        // file, and reporting it is more useful than importing both.
        const key = (get('sku') || `${name}|${get('strength')}`).toLowerCase();
        const earlier = seen.get(key);
        if (earlier) {
          verdicts.push({
            row: rowNumber,
            action: 'SKIP_DUPLICATE',
            name,
            message: `The same product appears on line ${earlier} of this file.`,
          });
          continue;
        }
        seen.set(key, rowNumber);

        const input = {
          sku: get('sku') || undefined,
          name,
          type: typeRaw as ProductType,
          brand: get('brand') || null,
          genericName: get('generic_name') || null,
          drugClass: get('drug_class') || null,
          form: get('form') || null,
          strengthText: get('strength') || null,
          dispenseUnit: get('dispense_unit') || 'unit',
          packSize: get('pack_size') ? Number(get('pack_size')) : 1,
          isControlled: /^(y|yes|true|1)$/i.test(get('is_controlled')),
          isColdChain: /^(y|yes|true|1)$/i.test(get('is_cold_chain')),
          sellingPrice: get('selling_price') ? Number(get('selling_price')) : 0,
          barcodes: get('barcode') ? [get('barcode')] : [],
          defaultDose: get('default_dose') ? Number(get('default_dose')) : null,
          defaultRoute: get('default_route') || null,
          defaultFrequency: get('default_frequency') || null,
          maxDailyDose: get('max_daily_dose') ? Number(get('max_daily_dose')) : null,
          notes: get('notes') || null,
        };

        const existing = input.sku
          ? await this.db.tx().product.findFirst({
              where: { sku: input.sku.toUpperCase() },
              select: { id: true, name: true },
            })
          : null;

        if (existing && !options.updateExisting) {
          verdicts.push({
            row: rowNumber,
            action: 'SKIP_DUPLICATE',
            sku: input.sku,
            name,
            message: `${existing.name} already uses that code.`,
          });
          continue;
        }

        if (options.dryRun) {
          // The same rules the real run applies, so the report is a
          // promise rather than a guess. Without this call the dry run
          // happily said it would import a medicine with no generic name.
          this.catalogue.validate(input);
          verdicts.push({
            row: rowNumber,
            action: existing ? 'UPDATE' : 'IMPORT',
            sku: input.sku,
            name,
          });
          continue;
        }

        const saved = existing
          ? await this.catalogue.update(ctx, existing.id, input)
          : await this.catalogue.create(ctx, input);
        verdicts.push({
          row: rowNumber,
          action: existing ? 'UPDATE' : 'IMPORT',
          sku: saved.sku,
          name,
        });
      } catch (error) {
        verdicts.push({
          row: rowNumber,
          action: 'REJECT',
          name: get('name') || undefined,
          message: error instanceof Error ? error.message : 'Could not be read.',
        });
      }
    }

    const report = {
      dryRun: options.dryRun,
      filename,
      rowCount: rows.length - 1,
      imported: verdicts.filter((v) => v.action === 'IMPORT').length,
      updated: verdicts.filter((v) => v.action === 'UPDATE').length,
      skipped: verdicts.filter((v) => v.action === 'SKIP_DUPLICATE').length,
      rejected: verdicts.filter((v) => v.action === 'REJECT').length,
      verdicts,
    };

    if (!options.dryRun) {
      await this.audit.record(this.db.tx(), this.audit.actorFromContext(ctx), {
        action: AuditAction.ProductImported,
        entityType: 'product',
        after: {
          filename,
          imported: report.imported,
          updated: report.updated,
          rejected: report.rejected,
        },
      });
    }

    this.logger.log(
      `${options.dryRun ? 'Dry run' : 'Import'} of ${filename}: ${report.imported} new, ` +
        `${report.updated} updated, ${report.skipped} already there, ${report.rejected} rejected.`,
    );
    return report;
  }
}
