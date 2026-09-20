import { Module, type OnModuleInit } from '@nestjs/common';
import { ConsultationStatus } from '../../generated/prisma/enums.js';
import { EncounterModule } from '../encounter/encounter.module.js';
import { EncounterCompletionRegistry } from '../encounter/encounter.service.js';
import { TriageModule } from '../triage/triage.module.js';
import { ConsultationController } from './consultation.controller.js';
import { ConsultationService } from './consultation.service.js';
import { TemplateService } from './template.service.js';
import { ConsultationIntegrityJob } from './integrity.job.js';
import { ConsultationSignRegistry } from './consultation-sign.registry.js';

/**
 * Consultation / EMR (CON, v0-06-consultation.md).
 *
 * The completion guard is registered here rather than inside the service,
 * because it is about how this module fits with encounters rather than
 * about consultations themselves.
 */
@Module({
  imports: [EncounterModule, TriageModule],
  controllers: [ConsultationController],
  providers: [ConsultationService, TemplateService, ConsultationIntegrityJob, ConsultationSignRegistry],
  exports: [ConsultationService, TemplateService, ConsultationSignRegistry],
})
export class ConsultationModule implements OnModuleInit {
  constructor(private readonly completion: EncounterCompletionRegistry) {}

  onModuleInit(): void {
    /**
     * ENC-F-10, CON-F-17: a visit cannot be finished while the doctor has
     * not signed what they wrote.
     *
     * Registered here rather than queried by the encounter module, so that
     * encounters know nothing about consultations. This is the check that
     * registry has been waiting for since v0-04.
     */
    this.completion.add('consultation', async (tx, encounterId) => {
      const unsigned = await tx.consultation.count({
        where: { encounterId, status: ConsultationStatus.DRAFT },
      });
      if (unsigned === 0) return null;
      return {
        reason: 'unsigned',
        detail:
          unsigned === 1
            ? 'the consultation has not been signed'
            : `${unsigned} consultations have not been signed`,
      };
    });
  }
}
