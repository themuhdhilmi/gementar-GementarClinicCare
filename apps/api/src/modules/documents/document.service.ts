import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ConsultationStatus,
  DocumentStatus,
  DocumentType,
  InvoiceStatus,
  PrescriptionStatus,
  ProductStatus,
  SignatureKind,
} from '../../generated/prisma/enums.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/domain-errors.js';
import { newId } from '../../shared/ids/uuid.js';
import { Clock } from '../../shared/time/clock.js';
import { DbService, type Tx } from '../../shared/prisma/db.service.js';
import { requireTenantId } from '../../shared/prisma/tenant-scope.js';
import { StorageService } from '../../shared/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { EventBus } from '../events/event-bus.service.js';
import { DomainEvent } from '../events/domain-events.js';
import { ChargeRegistry } from '../events/charge.registry.js';
import { resolveLetterhead } from '../tenancy/letterhead.js';
import { formatSen } from '../billing/money.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  NUMBERED,
  TARGET_FOR,
  TEMPLATE_VERSION,
  TYPE_CODE,
  render,
  stampNumber,
  withOverlay,
  type DocumentPayload,
  type Letterhead,
  type SignatureBlock,
} from './templates.js';

export type McInput = {
  fromDate?: string;
  days: number;
  lightDuty?: boolean;
  includeDiagnosis?: boolean;
  language?: string;
  /** Required when the certificate is backdated (§14). */
  backdateReason?: string | null;
};

export type ReferralInput = {
  to: string;
  reason: string;
  summary?: string;
  urgency?: string;
};

export type LetterInput = {
  title?: string;
  body: string;
  /** DOC-F-11: bill it, if the clinic has an item for it. */
  billableItemCode?: string | null;
};

/** DOC §12 unless the clinic says otherwise. */
const MAX_MC_DAYS = 30;
const MAX_BACKDATE_DAYS = 7;
/**
 * DOC-F-11: what a clinic charges for a piece of paper, if it charges.
 *
 * The clinic creates a billable item with one of these codes and the
 * document starts carrying a fee; it creates none and documents are
 * free. There is no separate switch to forget: the presence of the
 * priced item *is* the configuration.
 */
const FEE_ITEM_CODE: Partial<Record<DocumentType, string>> = {
  [DocumentType.MC]: 'DOC_MC',
  [DocumentType.REFERRAL]: 'DOC_REFERRAL',
  [DocumentType.MEDICAL_LETTER]: 'DOC_LETTER',
  [DocumentType.LAB_REQUEST]: 'DOC_LAB_REQUEST',
};

/** A signature is a few strokes of ink; anything larger is a scan of a page. */
const MAX_SIGNATURE_BYTES = 500_000;

/**
 * Documents (DOC, v0-13-documents.md).
 *
 * The shape of every issue here is the same, and it is the shape
 * DOC-R-07 asks for:
 *
 *   1. read what the document needs, inside a short transaction;
 *   2. render it, outside any transaction, because rendering is slow
 *      work and TEN-F-17 says slow work does not hold a connection;
 *   3. write the file, still outside;
 *   4. allocate the number and write the row, in a second short
 *      transaction.
 *
 * The order matters. If the renderer or the disk fails, nothing has
 * been written and — crucially — no number has been consumed, so a
 * retry is safe and the series stays gapless. Doing it the other way
 * round, which is what the patient-document upload does, leaves a row
 * pointing at a file that was never written (`PAT-OPEN-05`).
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly storage: StorageService,
    private readonly charges: ChargeRegistry,
  ) {}

  // -------------------------------------------------------------------
  // Medical certificate (DOC-F-05)
  // -------------------------------------------------------------------

  async issueMc(ctx: TenantContext, consultationId: string, input: McInput) {
    const days = Math.trunc(input.days);
    if (!(days >= 1 && days <= MAX_MC_DAYS)) {
      throw new BadRequestError(
        `A certificate covers between 1 and ${MAX_MC_DAYS} days.`,
        'invalid_days',
      );
    }

    const today = this.today();
    const from = input.fromDate ? this.parseDate(input.fromDate) : today;
    const offset = Math.round((from.getTime() - today.getTime()) / 86_400_000);
    if (offset < -MAX_BACKDATE_DAYS) {
      throw new BadRequestError(
        `A certificate cannot start more than ${MAX_BACKDATE_DAYS} days ago.`,
        'too_far_back',
      );
    }
    // §14: backdating is allowed and recorded, never silent.
    if (offset < 0 && !(input.backdateReason ?? '').trim()) {
      throw new BadRequestError(
        'Say why this certificate starts before today.',
        'backdate_reason_required',
      );
    }
    const to = new Date(from.getTime() + (days - 1) * 86_400_000);

    // --- 1. What it needs, read in one short transaction.
    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const consultation = await this.signedConsultation(
        tx,
        ctx,
        consultationId,
      );
      const patient = await tx.patient.findFirstOrThrow({
        where: { id: consultation.patientId },
        select: { id: true, name: true, idNumber: true, dateOfBirth: true },
      });
      const diagnoses = input.includeDiagnosis
        ? await tx.diagnosis.findMany({
            where: { consultationId },
            orderBy: { rank: 'asc' },
            select: { description: true },
          })
        : [];
      return {
        consultation,
        patient,
        diagnosis: diagnoses.map((d) => d.description).join('; ') || null,
        letterhead: await this.letterheadFor(tx, consultation.branchId),
        signature: await this.signatureFor(tx, ctx, consultation.doctorId),
      };
    });

    const verificationCode = randomBytes(8)
      .toString('base64url')
      .slice(0, 10)
      .toUpperCase();
    const payload: DocumentPayload = {
      kind: 'MC',
      letterhead: source.letterhead,
      patientName: source.patient.name,
      // DOC-R-08: full, because a certificate is an identity document.
      patientIdNumber: source.patient.idNumber,
      fromDate: iso(from),
      toDate: iso(to),
      days,
      lightDuty: input.lightDuty ?? false,
      diagnosis: source.diagnosis,
      signature: source.signature.block,
      issuedAt: this.stamp(),
      verificationCode,
    };

    return this.finish(ctx, {
      type: DocumentType.MC,
      branchId: source.consultation.branchId,
      patientId: source.patient.id,
      encounterId: source.consultation.encounterId,
      sourceType: 'consultation',
      sourceId: consultationId,
      language: input.language ?? 'MS',
      payload,
      signatureKind: source.signature.kind,
      verificationCode,
      audit: {
        days,
        fromDate: iso(from),
        toDate: iso(to),
        lightDuty: input.lightDuty ?? false,
        diagnosisIncluded: Boolean(source.diagnosis),
        backdatedBy: offset < 0 ? -offset : 0,
        backdateReason: input.backdateReason ?? null,
      },
      afterWrite: async (tx, documentId) => {
        await tx.mcDetail.create({
          data: {
            documentId,
            tenantId: requireTenantId(),
            fromDate: from,
            toDate: to,
            days,
            lightDuty: input.lightDuty ?? false,
            diagnosisIncluded: Boolean(source.diagnosis),
          },
        });
      },
    });
  }

  // -------------------------------------------------------------------
  // Referral, letter, lab request (DOC-F-06, F-11, F-12)
  // -------------------------------------------------------------------

  async issueReferral(
    ctx: TenantContext,
    consultationId: string,
    input: ReferralInput,
  ) {
    if ((input.to ?? '').trim().length < 2) {
      throw new BadRequestError(
        'Say who this is being referred to.',
        'recipient_required',
      );
    }
    if ((input.reason ?? '').trim().length < 2) {
      throw new BadRequestError('Say why.', 'reason_required');
    }

    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const consultation = await this.signedConsultation(
        tx,
        ctx,
        consultationId,
      );
      const patient = await tx.patient.findFirstOrThrow({
        where: { id: consultation.patientId },
        select: { id: true, name: true, idNumber: true, dateOfBirth: true },
      });
      const diagnoses = await tx.diagnosis.findMany({
        where: { consultationId },
        select: { description: true },
      });
      return {
        consultation,
        patient,
        diagnoses: diagnoses.map((d) => d.description),
        letterhead: await this.letterheadFor(tx, consultation.branchId),
        signature: await this.signatureFor(tx, ctx, consultation.doctorId),
      };
    });

    // Prefilled from the record, and editable — a referral the doctor
    // cannot reword is one they will write out by hand instead.
    const summary =
      input.summary?.trim() ||
      [
        source.consultation.chiefComplaint &&
          `Complaint: ${source.consultation.chiefComplaint}`,
        source.consultation.examination &&
          `Examination: ${source.consultation.examination}`,
        source.diagnoses.length > 0 &&
          `Diagnosis: ${source.diagnoses.join('; ')}`,
      ]
        .filter(Boolean)
        .join('\n\n');

    const payload: DocumentPayload = {
      kind: 'REFERRAL',
      letterhead: source.letterhead,
      patientName: source.patient.name,
      patientIdMasked: maskIdentity(source.patient.idNumber),
      patientAge: ageOf(source.patient.dateOfBirth, this.clock.now()),
      to: input.to.trim(),
      urgency: (input.urgency ?? 'ROUTINE').toUpperCase(),
      reason: input.reason.trim(),
      summary,
      signature: source.signature.block,
      issuedAt: this.stamp(),
    };

    return this.finish(ctx, {
      type: DocumentType.REFERRAL,
      branchId: source.consultation.branchId,
      patientId: source.patient.id,
      encounterId: source.consultation.encounterId,
      sourceType: 'consultation',
      sourceId: consultationId,
      language: 'EN',
      payload,
      signatureKind: source.signature.kind,
      audit: {
        to: input.to.trim(),
        urgency: payload.kind === 'REFERRAL' ? payload.urgency : null,
      },
    });
  }

  async issueLetter(
    ctx: TenantContext,
    consultationId: string,
    input: LetterInput,
    type: DocumentType = DocumentType.MEDICAL_LETTER,
  ) {
    if ((input.body ?? '').trim().length < 2) {
      throw new BadRequestError(
        'There is nothing in this letter.',
        'body_required',
      );
    }
    if (input.body.length > 10_000) {
      throw new BadRequestError(
        'That letter is too long to print.',
        'body_too_long',
      );
    }

    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const consultation = await this.signedConsultation(
        tx,
        ctx,
        consultationId,
      );
      const patient = await tx.patient.findFirstOrThrow({
        where: { id: consultation.patientId },
        select: { id: true, name: true, idNumber: true },
      });
      const billable = input.billableItemCode
        ? await tx.billableItem.findFirst({
            where: { code: input.billableItemCode },
          })
        : null;
      return {
        consultation,
        patient,
        billable,
        letterhead: await this.letterheadFor(tx, consultation.branchId),
        signature: await this.signatureFor(tx, ctx, consultation.doctorId),
      };
    });

    const payload: DocumentPayload = {
      kind: 'LETTER',
      letterhead: source.letterhead,
      title:
        input.title?.trim() ||
        (type === DocumentType.LAB_REQUEST
          ? 'Laboratory Request'
          : 'Medical Letter'),
      patientName: source.patient.name,
      patientIdMasked: maskIdentity(source.patient.idNumber),
      body: input.body.trim(),
      signature: source.signature.block,
      issuedAt: this.stamp(),
    };

    return this.finish(ctx, {
      type,
      branchId: source.consultation.branchId,
      patientId: source.patient.id,
      encounterId: source.consultation.encounterId,
      sourceType: 'consultation',
      sourceId: consultationId,
      language: 'EN',
      payload,
      signatureKind: source.signature.kind,
      audit: { title: payload.kind === 'LETTER' ? payload.title : null },
      // DOC-F-11: a document with a fee becomes a line on the bill.
      charge: source.billable
        ? {
            description: source.billable.name,
            unitPriceSen: source.billable.defaultPrice,
          }
        : null,
    });
  }

  // -------------------------------------------------------------------
  // Printouts of things other modules own (DOC-F-07, F-08)
  // -------------------------------------------------------------------

  async issueRxPrint(ctx: TenantContext, prescriptionId: string) {
    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const prescription = await tx.prescription.findFirst({
        where: { id: prescriptionId },
      });
      if (!prescription) throw new NotFoundError('Prescription');
      // DOC-R-01: only from a prescription that has actually been made.
      if (prescription.status === PrescriptionStatus.DRAFT) {
        throw new ConflictError(
          'This prescription has not been signed yet.',
          'prescription_not_signed',
        );
      }

      const items = await tx.prescriptionItem.findMany({
        where: { prescriptionId, isCurrent: true },
        orderBy: { createdAt: 'asc' },
      });
      const patient = await tx.patient.findFirstOrThrow({
        where: { id: prescription.patientId },
        select: { id: true, name: true, idNumber: true },
      });
      return {
        prescription,
        items,
        patient,
        letterhead: await this.letterheadFor(tx, prescription.branchId),
        signature: await this.signatureFor(tx, ctx, prescription.prescribedBy),
      };
    });

    const controlled = source.items.some((item) => item.isControlled);
    const payload: DocumentPayload = {
      kind: 'RX_PRINT',
      letterhead: source.letterhead,
      patientName: source.patient.name,
      // DOC-R-08: the full number only where it is required, which for a
      // prescription means one carrying a controlled drug.
      patientIdNumber: controlled
        ? source.patient.idNumber
        : maskIdentity(source.patient.idNumber),
      items: source.items.map((item) => ({
        displayName: item.displayName,
        quantity: `${Number(item.quantity)} ${item.quantityUnit}`,
        labelText: item.labelText,
        controlled: item.isControlled,
      })),
      signature: source.signature.block,
      issuedAt: this.stamp(),
    };

    return this.finish(ctx, {
      type: DocumentType.RX_PRINT,
      branchId: source.prescription.branchId,
      patientId: source.patient.id,
      encounterId: source.prescription.encounterId,
      sourceType: 'prescription',
      sourceId: prescriptionId,
      language: source.prescription.language,
      payload,
      signatureKind: source.signature.kind,
      audit: { items: source.items.length, controlled },
    });
  }

  async issueInvoicePrint(ctx: TenantContext, invoiceId: string) {
    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundError('Invoice');
      if (invoice.status === InvoiceStatus.DRAFT) {
        throw new ConflictError(
          'This invoice has not been issued yet.',
          'invoice_not_issued',
        );
      }
      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId },
        orderBy: { lineNo: 'asc' },
      });
      return {
        invoice,
        lines,
        letterhead: await this.letterheadFor(tx, invoice.branchId),
      };
    });

    const payload: DocumentPayload = {
      kind: 'INVOICE',
      letterhead: source.letterhead,
      invoiceNo: source.invoice.invoiceNo ?? '',
      patientName:
        source.invoice.patientNameSnapshot ?? source.invoice.walkupName ?? '',
      patientIdMasked: source.invoice.patientIdMaskedSnapshot,
      lines: source.lines.map((line) => ({
        description: line.description,
        quantity: String(Number(line.quantity)),
        unitPrice: formatSen(line.unitPrice),
        lineTotal: formatSen(line.lineTotal),
      })),
      subtotal: formatSen(source.invoice.subtotal),
      discountTotal: formatSen(source.invoice.discountTotal),
      taxTotal: formatSen(source.invoice.taxTotal),
      grandTotal: formatSen(source.invoice.grandTotal),
      amountPaid: formatSen(source.invoice.amountPaid),
      balance: formatSen(source.invoice.balance),
      issuedAt: this.stamp(),
    };

    return this.finish(ctx, {
      type: DocumentType.INVOICE,
      branchId: source.invoice.branchId,
      patientId: source.invoice.patientId,
      encounterId: source.invoice.encounterId,
      sourceType: 'invoice',
      sourceId: invoiceId,
      language: 'EN',
      payload,
      signatureKind: SignatureKind.NONE,
      audit: { invoiceNo: source.invoice.invoiceNo },
    });
  }

  /**
   * PAY-F-14, DOC-F-08: the receipt for one payment.
   *
   * It does **not** take a document number. A receipt already has one —
   * `receipt_no`, allocated gaplessly by `PAY` inside the payment
   * transaction, which is the number the patient quotes and the
   * accountant reconciles. Giving it a second, different number from
   * the document series would be two identifiers for one piece of paper
   * and a guaranteed argument about which is real.
   */
  async issueReceipt(ctx: TenantContext, paymentId: string) {
    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId } });
      if (!payment) throw new NotFoundError('Payment');
      const invoice = await tx.invoice.findFirstOrThrow({ where: { id: payment.invoiceId } });
      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId: invoice.id },
        orderBy: { lineNo: 'asc' },
      });
      const [branch, tenant] = await Promise.all([
        tx.branch.findFirstOrThrow({
          where: { id: payment.branchId },
          select: { name: true, phone: true, letterhead: true },
        }),
        tx.tenant.findFirstOrThrow({ select: { name: true } }),
      ]);
      return { payment, invoice, lines, branch, tenant };
    });

    const stored = resolveLetterhead(source.branch.letterhead);
    const payload: DocumentPayload = {
      kind: 'RECEIPT',
      clinicName: source.tenant.name,
      branchName: source.branch.name,
      branchPhone: source.branch.phone,
      headerText: stored.headerText,
      footerText: stored.footerText,
      receiptNo: source.payment.receiptNo,
      invoiceNo: source.invoice.invoiceNo,
      patientName: source.invoice.patientNameSnapshot ?? source.invoice.walkupName,
      lines: source.lines.map((line) => ({
        description: line.description,
        quantity: String(Number(line.quantity)),
        lineTotal: formatSen(line.lineTotal),
      })),
      subtotal: formatSen(source.invoice.subtotal),
      discountTotal: formatSen(source.invoice.discountTotal),
      taxTotal: formatSen(source.invoice.taxTotal),
      grandTotal: formatSen(source.invoice.grandTotal),
      // Shown only when there was any, because "Rounding 0.00" on every
      // receipt teaches people to stop reading the line.
      rounding:
        source.payment.roundingApplied === 0n
          ? null
          : formatSen(source.payment.roundingApplied),
      method: source.payment.method.replace('_', ' '),
      paid: formatSen(source.payment.amount),
      tendered: source.payment.tendered === null ? null : formatSen(source.payment.tendered),
      change: source.payment.changeGiven === null ? null : formatSen(source.payment.changeGiven),
      balance: formatSen(source.invoice.balance),
      cashier: source.payment.receivedName,
      paidAt: this.stamp(),
      outstanding: source.invoice.balance > 0n,
    };

    return this.finish(ctx, {
      type: DocumentType.RECEIPT,
      branchId: source.payment.branchId,
      patientId: source.invoice.patientId,
      encounterId: source.invoice.encounterId,
      sourceType: 'payment',
      sourceId: paymentId,
      language: 'EN',
      payload,
      signatureKind: SignatureKind.NONE,
      audit: {
        receiptNo: source.payment.receiptNo,
        method: source.payment.method,
        amount: source.payment.amount.toString(),
      },
    });
  }

  /** DOC-F-09: the bag label, from what the pharmacy actually handed over. */
  async issueLabel(ctx: TenantContext, dispenseItemId: string) {
    const source = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const item = await tx.dispenseItem.findFirst({
        where: { id: dispenseItemId },
        include: { batches: true },
      });
      if (!item) throw new NotFoundError('Dispense item');
      const session = await tx.dispense.findFirstOrThrow({
        where: { id: item.dispenseId },
      });
      const [product, patient, branch, tenant, batches] = await Promise.all([
        item.productId
          ? tx.product.findFirst({ where: { id: item.productId } })
          : Promise.resolve(null),
        tx.patient.findFirstOrThrow({
          where: { id: session.patientId },
          select: { id: true, name: true },
        }),
        tx.branch.findFirstOrThrow({
          where: { id: session.branchId },
          select: { name: true, phone: true },
        }),
        tx.tenant.findFirstOrThrow({ select: { name: true } }),
        tx.productBatch.findMany({
          where: { id: { in: item.batches.map((b) => b.batchId) } },
          select: { batchNo: true, expiryDate: true },
        }),
      ]);
      return { item, session, product, patient, branch, tenant, batches };
    });

    const payload: DocumentPayload = {
      kind: 'LABEL',
      clinicName: source.tenant.name,
      branchPhone: source.branch.phone,
      patientName: source.patient.name,
      product: [source.product?.name, source.product?.strengthText]
        .filter(Boolean)
        .join(' '),
      quantity: `${Number(source.item.quantity)} ${source.item.quantityUnit}`,
      instructions: source.item.labelText,
      batches: source.batches
        .map(
          (b) =>
            `Lot ${b.batchNo}${b.expiryDate ? ` exp ${b.expiryDate.toISOString().slice(0, 7)}` : ''}`,
        )
        .join(' · '),
      warnings: [
        'Simpan jauh dari jangkauan kanak-kanak.',
        ...(source.product?.isControlled ? ['Ubat terkawal'] : []),
        ...(source.product?.isColdChain ? ['Simpan 2–8 °C'] : []),
      ],
      dispensedAt: iso(source.item.dispensedAt),
    };

    return this.finish(ctx, {
      type: DocumentType.LABEL,
      branchId: source.session.branchId,
      patientId: source.patient.id,
      encounterId: source.session.encounterId,
      sourceType: 'dispense_item',
      sourceId: dispenseItemId,
      language: 'MS',
      payload,
      signatureKind: SignatureKind.NONE,
      audit: { product: source.product?.name ?? null },
    });
  }

  // -------------------------------------------------------------------
  // The shared tail: render, store, number, record (DOC-R-07)
  // -------------------------------------------------------------------

  private async finish(
    ctx: TenantContext,
    input: {
      type: DocumentType;
      branchId: string;
      patientId: string | null;
      encounterId: string | null;
      sourceType: string;
      sourceId: string;
      language: string;
      payload: DocumentPayload;
      signatureKind: SignatureKind;
      verificationCode?: string;
      audit: Record<string, unknown>;
      charge?: { description: string; unitPriceSen: bigint } | null;
      afterWrite?: (tx: Tx, documentId: string) => Promise<void>;
    },
  ) {
    const id = newId();
    const numbered = NUMBERED.has(input.type);
    const charge = input.charge ?? (await this.feeFor(ctx, input.type));

    // --- 2 and 3. Rendering and writing the file happen out here, where
    // no transaction is open. If either fails, nothing has been written
    // and no number has been taken.
    //
    // The number is not in the HTML: it is not known yet, and putting it
    // there would mean rendering twice. It is stamped by the reader.
    const html = render(input.payload, null);
    const bytes = Buffer.from(html, 'utf8');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const storageKey = this.storage.newKey(ctx.tenantId, 'document', 'html');
    await this.storage.put(storageKey, ctx.tenantId, bytes);

    // --- 4. The number and the row, in a short transaction.
    const now = this.clock.now();
    const documentNo = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const number = numbered
        ? await this.nextNumber(
            tx,
            input.branchId,
            input.type,
            now.getUTCFullYear(),
          )
        : null;

      await tx.document.create({
        data: {
          id,
          tenantId: requireTenantId(),
          branchId: input.branchId,
          patientId: input.patientId,
          encounterId: input.encounterId,
          type: input.type,
          status: DocumentStatus.ISSUED,
          documentNo: number?.documentNo ?? null,
          seriesYear: number?.year ?? null,
          seriesSeq: number?.seq ?? null,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          templateKey: input.payload.kind,
          templateVersion: TEMPLATE_VERSION,
          target: TARGET_FOR[input.type],
          language: input.language.slice(0, 2).toUpperCase(),
          storageKey,
          contentHash,
          payload: input.payload as unknown as object,
          verificationCode: input.verificationCode ?? null,
          issuedBy: ctx.userId,
          issuedByName: ctx.userName,
          issuedAt: now,
          signatureKind: input.signatureKind,
        },
      });

      await input.afterWrite?.(tx, id);

      if (charge && input.encounterId && input.patientId) {
        await this.charges.record(tx, ctx, {
          encounterId: input.encounterId,
          branchId: input.branchId,
          patientId: input.patientId,
          lineType: 'DOCUMENT',
          sourceType: 'document',
          sourceId: id,
          description: charge.description,
          quantity: 1,
          unitPriceSen: charge.unitPriceSen,
          occurredAt: now,
        });
      }

      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.DocumentIssued,
        entityType: 'document',
        entityId: id,
        subjectPatientId: input.patientId,
        after: {
          type: input.type,
          documentNo: number?.documentNo ?? null,
          ...input.audit,
        },
      });

      return number?.documentNo ?? null;
    });

    this.events.publish({
      name: DomainEvent.DocumentIssued,
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: {
        documentId: id,
        type: input.type,
        documentNo,
        patientId: input.patientId,
      },
    });

    // Not `read`: that one reads inside the request's transaction, and
    // an issuing route deliberately has none open (DOC-R-07).
    return this.db.withTenant(ctx.tenantId, async (tx) =>
      this.present(await tx.document.findFirstOrThrow({ where: { id } })),
    );
  }

  /**
   * The clinic's price for this kind of document, if it has set one.
   *
   * Read in its own short transaction, before the number is allocated,
   * because a fee that cannot be resolved should not consume a
   * certificate number.
   */
  private async feeFor(
    ctx: TenantContext,
    type: DocumentType,
  ): Promise<{ description: string; unitPriceSen: bigint } | null> {
    const code = FEE_ITEM_CODE[type];
    if (!code) return null;
    const item = await this.db.withTenant(ctx.tenantId, (tx) =>
      tx.billableItem.findFirst({
        where: { code, status: ProductStatus.ACTIVE },
      }),
    );
    if (!item || item.defaultPrice <= 0n) return null;
    return { description: item.name, unitPriceSen: item.defaultPrice };
  }

  /** DOC-R-03. Locked, so twenty at once get twenty consecutive numbers. */
  private async nextNumber(
    tx: Tx,
    branchId: string,
    type: DocumentType,
    year: number,
  ) {
    await tx.$executeRaw`
      INSERT INTO document_series (tenant_id, branch_id, type, year, next_seq)
      VALUES (${requireTenantId()}::uuid, ${branchId}::uuid, ${type}::"DocumentType", ${year}, 1)
      ON CONFLICT (branch_id, type, year) DO NOTHING
    `;
    const rows = await tx.$queryRaw<Array<{ next_seq: number }>>`
      UPDATE document_series
         SET next_seq = next_seq + 1
       WHERE branch_id = ${branchId}::uuid AND type = ${type}::"DocumentType" AND year = ${year}
      RETURNING next_seq - 1 AS next_seq
    `;
    const seq = rows[0]?.next_seq;
    if (seq === undefined) throw new NotFoundError('Document series');

    const branch = await tx.branch.findFirst({
      where: { id: branchId },
      select: { code: true },
    });
    return {
      seq,
      year,
      documentNo: `${branch?.code ?? 'DOC'}-${TYPE_CODE[type]}-${year}-${String(seq).padStart(6, '0')}`,
    };
  }

  // -------------------------------------------------------------------
  // The doctor's own signature (DOC-F-16)
  // -------------------------------------------------------------------

  /**
   * A doctor uploads their signature once and every certificate carries
   * it. Nobody uploads it *for* them: a signature somebody else can put
   * on the system is not a signature, and there is no route that takes a
   * user id. It is always the caller's own.
   */
  async uploadSignature(
    ctx: TenantContext,
    file: { buffer: Buffer; mimetype?: string },
  ): Promise<{ uploadedAt: Date; bytes: number }> {
    if (!file?.buffer?.length) {
      throw new BadRequestError('No image was uploaded.', 'file_required');
    }
    if (file.buffer.length > MAX_SIGNATURE_BYTES) {
      throw new BadRequestError(
        'That image is too large. A signature should be well under 500 KB.',
        'file_too_large',
      );
    }
    const mime = detectImage(file.buffer);
    if (!mime) {
      // The browser's content type is a claim, not a fact. What counts is
      // the first few bytes, because this image ends up inside a data URI
      // in a document the clinic prints.
      throw new BadRequestError(
        'A signature must be a PNG or a JPEG image.',
        'unsupported_image',
      );
    }

    const storageKey = this.storage.newKey(
      ctx.tenantId,
      'signature',
      mime.extension,
    );
    await this.storage.put(storageKey, ctx.tenantId, file.buffer);

    const now = this.clock.now();
    const previous = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.doctorSignature.findFirst({
        where: { userId: ctx.userId },
      });
      await tx.doctorSignature.upsert({
        where: { userId: ctx.userId },
        create: {
          userId: ctx.userId,
          tenantId: requireTenantId(),
          storageKey,
          mime: mime.type,
          uploadedAt: now,
          active: true,
        },
        update: { storageKey, mime: mime.type, uploadedAt: now, active: true },
      });

      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.DoctorSignatureUploaded,
        entityType: 'doctor_signature',
        entityId: ctx.userId,
        after: { mime: mime.type, bytes: file.buffer.length },
      });

      return existing?.storageKey ?? null;
    });

    // Documents already issued hold their signature as bytes inside the
    // stored HTML, so replacing this file changes nothing that has been
    // handed over. The old one is no longer referenced by anything.
    if (previous && previous !== storageKey) {
      await this.storage.remove(previous, ctx.tenantId).catch(() => undefined);
    }

    return { uploadedAt: now, bytes: file.buffer.length };
  }

  async mySignature(ctx: TenantContext) {
    const tx = this.db.tx();
    const row = await tx.doctorSignature.findFirst({
      where: { userId: ctx.userId },
    });
    return row
      ? {
          present: true,
          mime: row.mime,
          uploadedAt: row.uploadedAt,
          active: row.active,
        }
      : { present: false, mime: null, uploadedAt: null, active: false };
  }

  // -------------------------------------------------------------------
  // Reading, printing, cancelling
  // -------------------------------------------------------------------

  async read(ctx: TenantContext, documentId: string) {
    const tx = this.db.tx();
    const document = await tx.document.findFirst({ where: { id: documentId } });
    if (!document) throw new NotFoundError('Document');
    this.assertMayRead(ctx, document.type);
    return this.present(document);
  }

  /**
   * DOC-F-04, DOC-R-02, DOC-T-03: serve what was stored.
   *
   * The overlay is added here rather than baked in, so the stored bytes
   * stay equal to what was handed over on the day and the hash keeps
   * meaning something.
   */
  async file(
    ctx: TenantContext,
    documentId: string,
    options: { markCopy?: boolean } = {},
  ) {
    const document = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.document.findFirst({ where: { id: documentId } });
      if (!row) throw new NotFoundError('Document');
      this.assertMayRead(ctx, row.type);
      return row;
    });

    const stored = await this.storage.get(document.storageKey, ctx.tenantId);
    const html = stored.toString('utf8');

    const overlay =
      document.status === DocumentStatus.CANCELLED
        ? ('CANCELLED' as const)
        : options.markCopy && document.printCount > 0
          ? ('COPY' as const)
          : null;

    return {
      html: withOverlay(stampNumber(html, document.documentNo), overlay),
      documentNo: document.documentNo,
      type: document.type,
      target: document.target,
      overlay,
    };
  }

  /** DOC-F-18: every print is counted, and every reprint is audited. */
  async markPrinted(ctx: TenantContext, documentId: string) {
    const tx = this.db.tx();
    const document = await tx.document.findFirst({ where: { id: documentId } });
    if (!document) throw new NotFoundError('Document');
    this.assertMayRead(ctx, document.type);

    const now = this.clock.now();
    await tx.document.update({
      where: { id: documentId },
      data: { printCount: document.printCount + 1, lastPrintedAt: now },
    });

    // The first print is the document being handed over. Every one after
    // that is a reprint, and a document printed five times is worth
    // being able to ask about.
    if (document.printCount > 0) {
      await this.audit.record(tx, this.audit.actorFromContext(ctx), {
        action: AuditAction.DocumentReprinted,
        entityType: 'document',
        entityId: documentId,
        subjectPatientId: document.patientId,
        after: {
          print: document.printCount + 1,
          documentNo: document.documentNo,
        },
      });
    }

    return { printCount: document.printCount + 1 };
  }

  /** DOC-F-19, DOC-R-04: the number stays, the paper is marked. */
  async cancel(ctx: TenantContext, documentId: string, reason: string) {
    if ((reason ?? '').trim().length < 10) {
      throw new BadRequestError(
        'Say what happened, in a sentence. A cancelled document is read later.',
        'reason_required',
      );
    }

    const tx = this.db.tx();
    const document = await tx.document.findFirst({ where: { id: documentId } });
    if (!document) throw new NotFoundError('Document');
    if (document.status === DocumentStatus.CANCELLED) {
      throw new ConflictError(
        'This document is already cancelled.',
        'already_cancelled',
      );
    }
    // DOC-R-05: whoever issued it, or an administrator.
    if (
      document.issuedBy !== ctx.userId &&
      !ctx.permissions.has('admin.settings')
    ) {
      throw new ForbiddenError(
        'This document was issued by somebody else.',
        {},
      );
    }

    const now = this.clock.now();
    await tx.document.update({
      where: { id: documentId },
      data: {
        status: DocumentStatus.CANCELLED,
        cancelledBy: ctx.userId,
        cancelledAt: now,
        cancelReason: reason.trim(),
      },
    });

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.DocumentCancelled,
      entityType: 'document',
      entityId: documentId,
      subjectPatientId: document.patientId,
      reason: reason.trim(),
      before: { documentNo: document.documentNo, type: document.type },
    });

    this.events.publish({
      name: DomainEvent.DocumentCancelled,
      tenantId: ctx.tenantId,
      branchId: document.branchId,
      actorId: ctx.userId,
      occurredAt: now,
      payload: { documentId, type: document.type, reason: reason.trim() },
    });

    return this.present(
      await tx.document.findFirstOrThrow({ where: { id: documentId } }),
    );
  }

  /** The replacement points back at what it replaced, and vice versa. */
  async linkReplacement(
    ctx: TenantContext,
    cancelledId: string,
    replacementId: string,
  ) {
    const tx = this.db.tx();
    const cancelled = await tx.document.findFirst({
      where: { id: cancelledId },
    });
    if (!cancelled) throw new NotFoundError('Document');
    if (cancelled.status !== DocumentStatus.CANCELLED) {
      throw new ConflictError(
        'That document has not been cancelled.',
        'not_cancelled',
      );
    }
    void ctx;
    await tx.document.update({
      where: { id: cancelledId },
      data: { replacedById: replacementId },
    });
    return this.present(
      await tx.document.findFirstOrThrow({ where: { id: cancelledId } }),
    );
  }

  async forPatient(ctx: TenantContext, patientId: string, type?: DocumentType) {
    const tx = this.db.tx();
    const rows = await tx.document.findMany({
      where: { patientId, ...(type ? { type } : {}) },
      orderBy: { issuedAt: 'desc' },
      take: 200,
    });
    return {
      items: rows
        .filter((row) => this.mayRead(ctx, row.type))
        .map((row) => this.present(row)),
    };
  }

  async forEncounter(ctx: TenantContext, encounterId: string) {
    const tx = this.db.tx();
    const rows = await tx.document.findMany({
      where: { encounterId },
      orderBy: { issuedAt: 'desc' },
    });
    return {
      items: rows
        .filter((row) => this.mayRead(ctx, row.type))
        .map((row) => this.present(row)),
    };
  }

  /** DOC-R-06: every stored file still matches the hash taken at issue. */
  async verifyIntegrity(ctx: TenantContext, limit = 2000) {
    const documents = await this.db.withTenant(ctx.tenantId, (tx) =>
      tx.document.findMany({
        select: {
          id: true,
          documentNo: true,
          storageKey: true,
          contentHash: true,
        },
        orderBy: { issuedAt: 'desc' },
        take: limit,
      }),
    );

    const mismatched: Array<{
      id: string;
      documentNo: string | null;
      why: string;
    }> = [];
    for (const document of documents) {
      try {
        const bytes = await this.storage.get(document.storageKey, ctx.tenantId);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== document.contentHash) {
          mismatched.push({
            id: document.id,
            documentNo: document.documentNo,
            why: 'the stored file no longer matches what was issued',
          });
        }
      } catch {
        mismatched.push({
          id: document.id,
          documentNo: document.documentNo,
          why: 'the stored file is missing',
        });
      }
    }
    return { checked: documents.length, mismatched };
  }

  // -------------------------------------------------------------------

  /** DOC-R-01: only from a record somebody has signed. */
  private async signedConsultation(
    tx: Tx,
    ctx: TenantContext,
    consultationId: string,
  ) {
    const consultation = await tx.consultation.findFirst({
      where: { id: consultationId },
    });
    if (!consultation) throw new NotFoundError('Consultation');
    if (consultation.status !== ConsultationStatus.SIGNED) {
      throw new ConflictError(
        'This consultation has not been signed. A document can only be issued from the record, ' +
          'not from a draft of it.',
        'consultation_not_signed',
      );
    }
    // DOC-R-05: the doctor who signed it, or an administrator standing in.
    if (
      consultation.doctorId !== ctx.userId &&
      !ctx.permissions.has('admin.settings')
    ) {
      throw new ForbiddenError(
        'This consultation was signed by another doctor, and a certificate carries their name.',
        {},
      );
    }
    return consultation;
  }

  private async letterheadFor(tx: Tx, branchId: string): Promise<Letterhead> {
    const [branch, tenant] = await Promise.all([
      tx.branch.findFirstOrThrow({
        where: { id: branchId },
        select: {
          name: true,
          phone: true,
          addressLine1: true,
          addressLine2: true,
          letterhead: true,
          letterheadLogo: true,
          letterheadLogoMime: true,
        },
      }),
      tx.tenant.findFirstOrThrow({ select: { name: true } }),
    ]);
    const stored = resolveLetterhead(branch.letterhead);
    return {
      clinicName: tenant.name,
      branchName: branch.name,
      // TEN-F-10: inlined rather than linked, because a stored document
      // has to still render years later without reaching for a file
      // whose branch may have been renamed or closed.
      logoDataUri:
        branch.letterheadLogo && branch.letterheadLogoMime
          ? `data:${branch.letterheadLogoMime};base64,${Buffer.from(branch.letterheadLogo).toString('base64')}`
          : null,
      headerText: stored.headerText,
      footerText: stored.footerText,
      addressLine1: branch.addressLine1,
      addressLine2: branch.addressLine2,
      phone: branch.phone,
    };
  }

  /** DOC-F-16: an image if there is one, a typed block if not. */
  private async signatureFor(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
  ): Promise<{ block: SignatureBlock; kind: SignatureKind }> {
    const [user, signature] = await Promise.all([
      tx.user.findFirst({ where: { id: userId }, select: { name: true } }),
      tx.doctorSignature.findFirst({ where: { userId, active: true } }),
    ]);

    let imageDataUri: string | null = null;
    if (signature) {
      try {
        const bytes = await this.storage.get(
          signature.storageKey,
          ctx.tenantId,
        );
        imageDataUri = `data:${signature.mime};base64,${bytes.toString('base64')}`;
      } catch {
        // A missing signature file is not a reason to refuse a
        // certificate; the typed block says the same thing.
        this.logger.warn(
          `signature file missing for ${userId}; falling back to a typed block`,
        );
      }
    }

    return {
      block: {
        name: user?.name ?? 'Doctor',
        // The registration number lives on the employee record, which
        // does not exist yet (IAM-OPEN-13). Until it does, a certificate
        // carries the doctor's name and no number.
        registrationNo: null,
        imageDataUri,
      },
      kind: imageDataUri ? SignatureKind.IMAGE : SignatureKind.TYPED,
    };
  }

  /** DOC §15: a referral carries clinical detail; a receipt does not. */
  private mayRead(ctx: TenantContext, type: DocumentType): boolean {
    return CLINICAL_TYPES.has(type)
      ? ctx.permissions.has('clinical.read')
      : true;
  }

  private assertMayRead(ctx: TenantContext, type: DocumentType) {
    if (!this.mayRead(ctx, type)) {
      throw new ForbiddenError('This is a clinical document.', { type });
    }
  }

  private present(row: {
    id: string;
    type: DocumentType;
    status: DocumentStatus;
    documentNo: string | null;
    patientId: string | null;
    encounterId: string | null;
    sourceType: string | null;
    sourceId: string | null;
    target: string;
    language: string;
    issuedAt: Date;
    issuedByName: string | null;
    printCount: number;
    lastPrintedAt: Date | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    replacedById: string | null;
    verificationCode: string | null;
    contentHash: string;
  }) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      documentNo: row.documentNo,
      patientId: row.patientId,
      encounterId: row.encounterId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      target: row.target,
      language: row.language,
      issuedAt: row.issuedAt,
      issuedByName: row.issuedByName,
      printCount: row.printCount,
      lastPrintedAt: row.lastPrintedAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      replacedById: row.replacedById,
      verificationCode: row.verificationCode,
      contentHash: row.contentHash,
    };
  }

  private today(): Date {
    const now = this.clock.now();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private parseDate(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestError(`"${value}" is not a date.`, 'invalid_date');
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestError(`"${value}" is not a date.`, 'invalid_date');
    }
    return parsed;
  }

  private stamp(): string {
    return this.clock.now().toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** DOC §15: these carry clinical information and need `clinical.read`. */
const CLINICAL_TYPES: ReadonlySet<DocumentType> = new Set([
  DocumentType.MC,
  DocumentType.REFERRAL,
  DocumentType.MEDICAL_LETTER,
  DocumentType.LAB_REQUEST,
  DocumentType.CONSULT_RECORD,
  DocumentType.RX_PRINT,
]);

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function maskIdentity(idNumber: string | null): string | null {
  if (!idNumber) return null;
  const digits = idNumber.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••••-••-${digits.slice(-4)}`;
}

function ageOf(dateOfBirth: Date | null, now: Date): string | null {
  if (!dateOfBirth) return null;
  const years = Math.floor(
    (now.getTime() - dateOfBirth.getTime()) / (365.25 * 86_400_000),
  );
  return `${years} y`;
}

/**
 * What the file actually is, from its first bytes.
 *
 * A signature ends up base64'd into a data URI inside a document the
 * clinic prints and hands to a patient's employer. Trusting the
 * browser's `Content-Type` would let an SVG — which is a script host —
 * through on a claim of being a PNG.
 */
function detectImage(
  bytes: Buffer,
): { type: string; extension: string } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return { type: 'image/png', extension: 'png' };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { type: 'image/jpeg', extension: 'jpg' };
  }
  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
