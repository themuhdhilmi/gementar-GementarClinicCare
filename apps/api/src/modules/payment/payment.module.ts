import { Module, type OnModuleInit } from '@nestjs/common';
import { InvoiceStatus } from '../../generated/prisma/enums.js';
import { formatSen } from '../billing/money.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { EncounterModule } from '../encounter/encounter.module.js';
import { EncounterCompletionRegistry } from '../encounter/encounter.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CashSessionService } from './cash-session.service.js';
import { PaymentController } from './payment.controller.js';
import { PaymentService } from './payment.service.js';
import { PaymentReconciliationJob } from './reconciliation.job.js';
import { ReceiptService } from './receipt.service.js';

/**
 * Payment (PAY, v0-12-payment.md).
 *
 * The last module of V0, and the one four others were waiting for.
 */
@Module({
  imports: [EncounterModule, TenancyModule, DocumentsModule],
  controllers: [PaymentController],
  providers: [
    CashSessionService,
    PaymentService,
    ReceiptService,
    PaymentReconciliationJob,
  ],
  exports: [PaymentService, CashSessionService],
})
export class PaymentModule implements OnModuleInit {
  constructor(private readonly completion: EncounterCompletionRegistry) {}

  onModuleInit(): void {
    /**
     * BIL-F-17, the half `BIL` deliberately left unregistered, and
     * `BIL-OPEN-16` has been tracking since.
     *
     * Billing wrote the "bill not issued" guard and stopped, because a
     * balance check with nothing able to clear it would have made every
     * visit with a charge impossible to finish — a guard nothing can
     * satisfy is a trap. Payment can clear it, so payment registers it.
     *
     * The override BIL-F-17 also asks for is ENC's, not this module's:
     * an administrator forcing a visit closed goes through
     * `encounter.force`, which is audited as such. This guard simply
     * says what is owed; who may overrule it is ENC's business.
     */
    this.completion.add('payment', async (tx, encounterId) => {
      const invoice = await tx.invoice.findFirst({
        where: {
          encounterId,
          status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL] },
          balance: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!invoice) return null;

      return {
        reason: 'balance_outstanding',
        detail: `${formatSen(invoice.balance)} is still owed on ${invoice.invoiceNo ?? 'the bill'}`,
      };
    });
  }
}
