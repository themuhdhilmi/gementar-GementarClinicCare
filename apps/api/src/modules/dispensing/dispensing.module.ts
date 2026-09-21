import { Module, type OnModuleInit } from '@nestjs/common';
import { PrescriptionItemStatus, PrescriptionStatus } from '../../generated/prisma/enums.js';
import { EncounterModule } from '../encounter/encounter.module.js';
import { EncounterCompletionRegistry } from '../encounter/encounter.service.js';
import { PrescriptionModule } from '../prescription/prescription.module.js';
import { StockModule } from '../stock/stock.module.js';
import { DispenseController } from './dispense.controller.js';
import { DispenseService } from './dispense.service.js';
import { ControlledRegisterService } from './controlled-register.service.js';

/**
 * Dispensing (DSP, v0-08-dispensing.md).
 *
 * The last link in the chain a patient walks: registered, queued,
 * triaged, seen, prescribed, and now handed something. It sits on top of
 * the stock ledger and the prescription, and it is the only module that
 * turns an intention into a thing that left the building.
 */
@Module({
  imports: [StockModule, PrescriptionModule, EncounterModule],
  controllers: [DispenseController],
  providers: [DispenseService, ControlledRegisterService],
  exports: [DispenseService],
})
export class DispensingModule implements OnModuleInit {
  constructor(private readonly completion: EncounterCompletionRegistry) {}

  onModuleInit(): void {
    /**
     * ENC-F-10: a visit cannot be finished while medicine is still
     * waiting to be handed over.
     *
     * This is the guard `RX` deliberately did not register, because
     * until now nothing could satisfy it and it would have made every
     * prescribed visit impossible to finish. Registering it belongs to
     * the module that can clear it — which is this one, by dispensing,
     * or by the dispenser marking an item declined or external.
     */
    this.completion.add('dispense', async (tx, encounterId) => {
      const prescription = await tx.prescription.findFirst({
        where: { encounterId, status: PrescriptionStatus.ACTIVE },
        select: { id: true },
      });
      if (!prescription) return null;

      const waiting = await tx.prescriptionItem.count({
        where: {
          prescriptionId: prescription.id,
          isCurrent: true,
          status: { in: [PrescriptionItemStatus.ACTIVE, PrescriptionItemStatus.PARTIAL] },
        },
      });
      if (waiting === 0) return null;

      return {
        reason: 'medicine_outstanding',
        detail:
          waiting === 1
            ? 'one prescribed medicine has not been handed over'
            : `${waiting} prescribed medicines have not been handed over`,
      };
    });
  }
}
