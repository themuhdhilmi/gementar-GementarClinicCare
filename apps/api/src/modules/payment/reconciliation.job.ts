import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InvoiceStatus, PaymentStatus } from '../../generated/prisma/enums.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { formatSen } from '../billing/money.js';

/**
 * PAY-N-04: every invoice's `amount_paid` is the sum of its posted
 * payments.
 *
 * The service maintains this inside every transaction that touches a
 * payment, so it should never be wrong. That is exactly why the check
 * exists: an invariant nothing verifies is an invariant that has
 * quietly stopped holding. The failure mode this catches is a future
 * code path — a migration, a fix applied by hand at eight in the
 * evening, a bug in a branch nobody re-read — and the cost of finding
 * it the next morning rather than at an audit is the whole point.
 *
 * It reads; it never corrects. A job that silently repaired the total
 * would hide the thing it was built to find.
 */
@Injectable()
export class PaymentReconciliationJob {
  private readonly logger = new Logger(PaymentReconciliationJob.name);

  constructor(private readonly db: DbService) {}

  @Cron('15 20 * * *', { name: 'payment-reconciliation' }) // 04:15 Asia/Kuala_Lumpur
  async run(): Promise<{
    tenants: number;
    checked: number;
    mismatched: number;
  }> {
    const tenants = await this.db.withPlatform(
      'list tenants for the payment check',
      (tx) => tx.tenant.findMany({ select: { id: true, slug: true } }),
    );

    let checked = 0;
    let mismatched = 0;

    for (const tenant of tenants) {
      const result = await this.db.withTenant(tenant.id, (tx) =>
        this.verify(tx),
      );
      checked += result.checked;
      mismatched += result.mismatched.length;

      for (const row of result.mismatched) {
        this.logger.error(
          `PAYMENT MISMATCH ${tenant.slug}: invoice ${row.invoiceNo ?? row.invoiceId} ` +
            `says ${formatSen(row.recorded)} paid, its payments sum to ${formatSen(row.actual)}.`,
        );
      }
    }

    if (mismatched === 0) {
      this.logger.log(`payment reconciliation: ${checked} invoices, all agree`);
    }
    return { tenants: tenants.length, checked, mismatched };
  }

  /** Exposed so a test can prove the check is not vacuous. */
  async verify(tx: Tx): Promise<{
    checked: number;
    mismatched: Array<{
      invoiceId: string;
      invoiceNo: string | null;
      recorded: bigint;
      actual: bigint;
    }>;
  }> {
    const invoices = await tx.invoice.findMany({
      where: { status: { not: InvoiceStatus.DRAFT } },
      select: { id: true, invoiceNo: true, amountPaid: true },
    });

    const sums = await tx.payment.groupBy({
      by: ['invoiceId'],
      where: { status: PaymentStatus.POSTED },
      _sum: { amount: true },
    });

    const byInvoice = new Map(
      sums.map((row) => [row.invoiceId, row._sum.amount ?? 0n]),
    );

    const mismatched: Array<{
      invoiceId: string;
      invoiceNo: string | null;
      recorded: bigint;
      actual: bigint;
    }> = [];
    for (const invoice of invoices) {
      const actual = byInvoice.get(invoice.id) ?? 0n;
      if (actual !== invoice.amountPaid) {
        mismatched.push({
          invoiceId: invoice.id,
          invoiceNo: invoice.invoiceNo,
          recorded: invoice.amountPaid,
          actual,
        });
      }
    }
    return { checked: invoices.length, mismatched };
  }
}
