import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../shared/prisma/db.service.js';
import { ConsultationService } from './consultation.service.js';

/**
 * CON-R-02, CON-N-04: every signed consultation, checked against its own
 * fingerprint, every night.
 *
 * The immutability trigger stops a change made through PostgreSQL's
 * ordinary path. This is what notices one that got around it — a superuser,
 * a restore from a doctored backup, a migration that meant well, a failing
 * disk. Those are all unlikely; the point of a clinical record is that
 * "unlikely" is not the same as "would go unnoticed".
 *
 * It runs per tenant, because a hash is computed inside a tenant's own
 * scope like everything else.
 */
@Injectable()
export class ConsultationIntegrityJob {
  private readonly logger = new Logger(ConsultationIntegrityJob.name);

  constructor(
    private readonly db: DbService,
    private readonly consultations: ConsultationService,
  ) {}

  @Cron('45 19 * * *', { name: 'consultation-integrity' }) // 03:45 Asia/Kuala_Lumpur
  async run(): Promise<{ tenants: number; checked: number; mismatched: number }> {
    const tenants = await this.db.withPlatform('list tenants for the integrity check', (tx) =>
      tx.tenant.findMany({ select: { id: true, slug: true } }),
    );

    let checked = 0;
    const failures: Array<{ tenant: string; id: string }> = [];

    for (const tenant of tenants) {
      const result = await this.db.withTenant(tenant.id, (tx) =>
        this.consultations.verifyIntegrity(tx),
      );
      checked += result.checked;
      for (const row of result.mismatched) failures.push({ tenant: tenant.slug, id: row.id });
    }

    if (failures.length > 0) {
      // The most serious thing this system can discover about itself, so it
      // is logged at error level with the identifiers to chase. When `NTF`
      // exists (V1) this also raises an alert; until then somebody has to
      // be reading the logs, which is `CON-OPEN-02`.
      this.logger.error(
        `INTEGRITY FAILURE: ${failures.length} signed consultation(s) no longer match what was ` +
          `signed. ${failures.map((f) => `${f.tenant}/${f.id}`).join(', ')}`,
      );
    } else {
      this.logger.log(`integrity: ${checked} signed consultations verified across ${tenants.length} clinics`);
    }

    return { tenants: tenants.length, checked, mismatched: failures.length };
  }
}
