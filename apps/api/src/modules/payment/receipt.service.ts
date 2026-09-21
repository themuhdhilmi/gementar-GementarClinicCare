import { Injectable } from '@nestjs/common';
import { DocumentType } from '../../generated/prisma/enums.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { NotFoundError } from '../../shared/errors/domain-errors.js';
import { DocumentService } from '../documents/document.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * PAY-F-14 … F-16, as a thin seam onto `DOC`.
 *
 * The receipt is a document like a certificate is: rendered once,
 * stored, hashed, reprintable, and served as the bytes that were handed
 * over. All of that belongs to `DOC` and none of it is worth a second
 * implementation here. What this adds is the one payment-shaped
 * behaviour — a receipt is issued once per payment, and asking again
 * gives back the same one rather than making another.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly db: DbService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * The receipt for a payment, making it the first time and returning
   * it every time after.
   *
   * Not idempotent by accident: a second receipt for one payment would
   * be a second piece of paper claiming the same money was taken, and
   * §14's "power cut after payment saved but before receipt printed"
   * case is exactly somebody asking again.
   */
  async build(ctx: TenantContext, paymentId: string) {
    // Its own short scope: the route has no request transaction, because
    // issuing renders and writes a file and neither may hold a
    // connection (DOC-R-07, TEN-F-17).
    const found = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId } });
      if (!payment) throw new NotFoundError('Payment');
      const already = await tx.document.findFirst({
        where: {
          type: DocumentType.RECEIPT,
          sourceType: 'payment',
          sourceId: paymentId,
        },
      });
      return { payment, already };
    });
    const { payment, already } = found;
    if (already) {
      // `read` takes the transaction from the scope, and this route has
      // none — so it gets one of its own, the same way `file` does.
      return {
        document: await this.db.withTenant(ctx.tenantId, () =>
          this.documents.read(ctx, already.id),
        ),
        receiptNo: payment.receiptNo,
        reissued: true,
      };
    }

    // Rendering and storing happen outside a transaction (DOC-R-07), so
    // the caller is a route that has opted out of the request one.
    const document = await this.documents.issueReceipt(ctx, paymentId);
    return { document, receiptNo: payment.receiptNo, reissued: false };
  }
}
