import { Module, type OnModuleInit } from '@nestjs/common';
import { InvoiceStatus } from '../../generated/prisma/enums.js';
import { ChargeRegistry } from '../events/charge.registry.js';
import { EncounterModule } from '../encounter/encounter.module.js';
import { EncounterCompletionRegistry } from '../encounter/encounter.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { BillingController } from './billing.controller.js';
import { InvoiceService } from './invoice.service.js';
import { BillableItemService } from './billable-item.service.js';
import { FeeScheduleService } from './fee-schedule.service.js';

/**
 * Billing (BIL, v0-11-billing.md).
 *
 * Sits between the clinical modules, which say what happened, and
 * payment, which collects. It never asks them anything: they tell it,
 * through the charge registry, inside their own transactions.
 */
@Module({
  imports: [EncounterModule, TenancyModule],
  controllers: [BillingController],
  providers: [InvoiceService, BillableItemService, FeeScheduleService],
  exports: [InvoiceService],
})
export class BillingModule implements OnModuleInit {
  constructor(
    private readonly charges: ChargeRegistry,
    private readonly invoices: InvoiceService,
    private readonly completion: EncounterCompletionRegistry,
  ) {}

  onModuleInit(): void {
    /**
     * BIL-F-02: consultations, medicines and procedures become lines.
     *
     * Registered rather than subscribed. Events here fire after commit
     * and a failing subscriber is only logged, which is fine for a
     * notification and not fine for money: a dispense that committed
     * and then failed to bill would take the medicine off the shelf and
     * charge nothing.
     */
    this.charges.register(
      (tx, ctx, input) => this.invoices.recordCharge(tx, ctx, input),
      (tx, ctx, source) => this.invoices.removeCharge(tx, ctx, source),
    );

    /**
     * BIL-F-17, half of it: a visit is not finished while its bill has
     * not been issued.
     *
     * The other half — an outstanding *balance* — is deliberately not
     * registered here, for the same reason the dispensing guard was not
     * registered by `RX`. Nothing can pay an invoice yet, so a balance
     * check today would mean no visit with any charge on it could ever
     * be completed. A guard nothing can satisfy is a trap, and it
     * belongs with the module that can clear it.
     *
     * `BIL-OPEN-16` tracks it; `v0-12-payment.md` registers it, along
     * with the administrator's "complete with outstanding" override
     * that BIL-F-17 also asks for.
     */
    this.completion.add('billing', async (tx, encounterId) => {
      const invoice = await tx.invoice.findFirst({
        where: { encounterId, status: { not: InvoiceStatus.VOID } },
        orderBy: { createdAt: 'desc' },
      });
      if (!invoice) return null;
      if (invoice.status !== InvoiceStatus.DRAFT) return null;

      // A draft with nothing on it is not an unpaid bill; it is a
      // cashier who opened the screen and walked away.
      const lines = await tx.invoiceLine.count({ where: { invoiceId: invoice.id } });
      if (lines === 0) return null;

      return { reason: 'invoice_not_issued', detail: 'the invoice has not been issued' };
    });
  }
}
