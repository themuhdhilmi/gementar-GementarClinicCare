import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../shared/prisma/db.service.js';
import { systemContext } from '../tenancy/tenant-context.js';
import { DocumentService } from './document.service.js';

/**
 * DOC-R-06, DOC-T-08: every stored document still matches what was
 * issued.
 *
 * The same reasoning as the consultation integrity job. The database
 * refuses to change a document row; this is what notices a change to the
 * *file* — a restore from a doctored backup, a helpful edit with a text
 * editor, a failing disk. A certificate that can be quietly altered
 * after the fact is not evidence of anything.
 */
@Injectable()
export class DocumentIntegrityJob {
  private readonly logger = new Logger(DocumentIntegrityJob.name);

  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentService,
  ) {}

  @Cron('0 20 * * *', { name: 'document-integrity' }) // 04:00 Asia/Kuala_Lumpur
  async run(): Promise<{
    tenants: number;
    checked: number;
    mismatched: number;
  }> {
    const tenants = await this.db.withPlatform(
      'list tenants for the document check',
      (tx) => tx.tenant.findMany({ select: { id: true, slug: true } }),
    );

    let checked = 0;
    let mismatched = 0;

    for (const tenant of tenants) {
      const ctx = systemContext({
        tenantId: tenant.id,
        branchId: '',
        causedByUserId: '',
        because: 'the nightly document integrity check',
      });
      const result = await this.documents.verifyIntegrity(ctx);
      checked += result.checked;
      mismatched += result.mismatched.length;

      for (const row of result.mismatched) {
        this.logger.error(
          `DOCUMENT INTEGRITY FAILURE ${tenant.slug}: ${row.documentNo ?? row.id} — ${row.why}.`,
        );
      }
    }

    if (mismatched === 0) {
      this.logger.log(
        `document integrity: ${checked} documents, all as issued`,
      );
    }
    return { tenants: tenants.length, checked, mismatched };
  }
}
