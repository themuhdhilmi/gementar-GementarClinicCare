import { Module, type OnModuleInit } from '@nestjs/common';
import { ProcedureStatus } from '../../generated/prisma/enums.js';
import { CatalogueModule } from '../catalogue/catalogue.module.js';
import { ConsultationModule } from '../consultation/consultation.module.js';
import { ConsultationSignRegistry } from '../consultation/consultation-sign.registry.js';
import { EncounterModule } from '../encounter/encounter.module.js';
import { EncounterCompletionRegistry } from '../encounter/encounter.service.js';
import { StockModule } from '../stock/stock.module.js';
import { ProcedureController } from './procedure.controller.js';
import { ProcedureCatalogueService } from './procedure-catalogue.service.js';
import { ProcedureService } from './procedure.service.js';

/**
 * Procedures (PRC, v0-10-procedures.md).
 *
 * Sits on top of the stock ledger, which is the whole reason it waited
 * for it: a procedure that does not deduct what it used is a procedure
 * that makes the stock figures wrong every time it happens.
 */
@Module({
  imports: [CatalogueModule, StockModule, ConsultationModule, EncounterModule],
  controllers: [ProcedureController],
  providers: [ProcedureCatalogueService, ProcedureService],
  exports: [ProcedureService],
})
export class ProcedureModule implements OnModuleInit {
  constructor(
    private readonly signHooks: ConsultationSignRegistry,
    private readonly completion: EncounterCompletionRegistry,
  ) {}

  onModuleInit(): void {
    /**
     * CON-R-07: a signed note with a procedure on it sends the patient
     * to the treatment room. The order was placed while the note was a
     * draft; signing is what makes it real, the same way it does for a
     * prescription.
     */
    this.signHooks.add('procedure', async (tx, ctx, consultation) => {
      void ctx;
      const ordered = await tx.encounterProcedure.count({
        where: { encounterId: consultation.encounterId, status: ProcedureStatus.ORDERED },
      });
      return { hasProcedures: ordered > 0 };
    });

    /**
     * ENC-F-10: a visit cannot be finished while somebody is still
     * waiting for a procedure that was ordered for them.
     *
     * Unlike the dispensing guard, this one is registered now, because
     * the module that clears it is this one: a nurse performs it, or
     * somebody cancels it with a reason. It can never be a dead end.
     */
    this.completion.add('procedure', async (tx, encounterId) => {
      const waiting = await tx.encounterProcedure.count({
        where: { encounterId, status: ProcedureStatus.ORDERED },
      });
      if (waiting === 0) return null;
      return {
        reason: 'procedure_outstanding',
        detail:
          waiting === 1
            ? 'a procedure that was ordered has not been done'
            : `${waiting} procedures that were ordered have not been done`,
      };
    });

    /** A consultation abandoned takes its unperformed orders with it. */
    this.signHooks.addCancelHook('procedure', async (tx, ctx, consultation, reason) => {
      void ctx;
      await tx.encounterProcedure.updateMany({
        where: { encounterId: consultation.encounterId, status: ProcedureStatus.ORDERED },
        data: { status: ProcedureStatus.CANCELLED, cancelReason: reason },
      });
    });
  }
}
