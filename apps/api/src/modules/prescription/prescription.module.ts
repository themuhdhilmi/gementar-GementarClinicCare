import { Module, type OnModuleInit } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import { ConsultationModule } from '../consultation/consultation.module.js';
import { ConsultationSignRegistry } from '../consultation/consultation-sign.registry.js';
import { PrescriptionController } from './prescription.controller.js';
import { PrescriptionService } from './prescription.service.js';

/**
 * Prescription (RX, v0-07-prescription.md).
 *
 * Depends on the catalogue, because an allergy check with no generic
 * name to match on is not a check. Depends on consultations, because a
 * prescription without the decision behind it is a list of drugs.
 *
 * Nothing depends on this module in the other direction: CON learns that
 * a prescription exists through the sign registry, and the pharmacy will
 * learn the same way when DSP is built.
 */
@Module({
  imports: [CatalogueModule, ConsultationModule],
  controllers: [PrescriptionController],
  providers: [PrescriptionService],
  exports: [PrescriptionService],
})
export class PrescriptionModule implements OnModuleInit {
  constructor(
    private readonly signHooks: ConsultationSignRegistry,
    private readonly rx: PrescriptionService,
  ) {}

  onModuleInit(): void {
    /**
     * RX-F-05, RX-F-17: the prescription becomes real when the note is
     * signed, inside the same transaction. If the re-check raises a
     * warning nobody has answered, this throws and the signature does
     * not happen — which is the point of re-checking at all.
     */
    this.signHooks.add('prescription', async (tx, ctx, consultation, options) =>
      this.rx.activateForConsultation(tx, ctx, consultation, {
        confirmedItemIds: options.confirm,
      }),
    );

    /** The visit was abandoned, so the prescription is too. */
    this.signHooks.addCancelHook('prescription', async (tx, ctx, consultation, reason) => {
      await this.rx.cancelForConsultation(tx, ctx, consultation.id, reason);
    });
  }
}
