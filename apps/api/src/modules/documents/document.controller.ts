import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited, NotAudited } from '../audit/audit.decorators.js';
import type { Response } from 'express';
import { DocumentType } from '../../generated/prisma/enums.js';
import {
  Ctx,
  NoRequestTransaction,
  RequirePermission,
} from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DocumentService } from './document.service.js';
import {
  CancelDocumentDto,
  DocumentQueryDto,
  LetterDto,
  McDto,
  ReferralDto,
} from './dto/document.dto.js';

/**
 * Issuing routes opt out of the request transaction on purpose.
 *
 * DOC-R-07: the payload is read in one short transaction, the document
 * is rendered and written to disk with nothing open, and the number is
 * allocated in a second short transaction. Rendering inside the request
 * transaction would hold a database connection for the whole of it
 * (TEN-F-17), and writing the row first would leave a numbered
 * certificate pointing at a file that was never written.
 */
const RENDERS_OUTSIDE =
  'renders and stores a document outside any transaction (DOC-R-07)';

@Controller()
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  // ------------------------------------------------ issuing (DOC §8)

  @Post('consultations/:id/documents/mc')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueMc(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: McDto,
  ) {
    return this.documents.issueMc(ctx, id, body);
  }

  @Post('consultations/:id/documents/referral')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueReferral(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ReferralDto,
  ) {
    return this.documents.issueReferral(ctx, id, body);
  }

  @Post('consultations/:id/documents/letter')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueLetter(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: LetterDto,
  ) {
    return this.documents.issueLetter(ctx, id, body);
  }

  @Post('consultations/:id/documents/lab-request')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueLabRequest(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: LetterDto,
  ) {
    return this.documents.issueLetter(ctx, id, body, DocumentType.LAB_REQUEST);
  }

  @Post('prescriptions/:id/print')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueRxPrint(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.issueRxPrint(ctx, id);
  }

  @Post('invoices/:id/print')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueInvoicePrint(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.issueInvoicePrint(ctx, id);
  }

  @Post('dispense-items/:id/label-document')
  @Audited(AuditAction.DocumentIssued)
  @NoRequestTransaction(RENDERS_OUTSIDE)
  @RequirePermission('document.issue')
  issueLabel(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.issueLabel(ctx, id);
  }

  // ------------------------------------------------------- reading

  @Get('documents/:id')
  @RequirePermission('patient.read')
  read(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.read(ctx, id);
  }

  /**
   * The document itself, as it was stored.
   *
   * Served as HTML the browser prints — which is what DOC-F-03
   * specifies for receipts and labels, and allows for letters. The
   * watermark for a copy or a cancellation is added here rather than
   * baked into the stored file.
   */
  @Get('documents/:id/file')
  @NoRequestTransaction('reads a stored file from disk')
  @RequirePermission('patient.read')
  async file(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query('copy') copy: string | undefined,
    @Res() response: Response,
  ) {
    const document = await this.documents.file(ctx, id, {
      markCopy: copy !== 'false',
    });
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    // A medical certificate is not something to leave in a shared cache.
    response.setHeader('Cache-Control', 'no-store');
    response.send(document.html);
  }

  @Post('documents/:id/print')
  @Audited(AuditAction.DocumentReprinted)
  @HttpCode(200)
  @RequirePermission('document.reprint')
  markPrinted(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.markPrinted(ctx, id);
  }

  @Post('documents/:id/cancel')
  @Audited(AuditAction.DocumentCancelled)
  @HttpCode(200)
  @RequirePermission('document.issue')
  cancel(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: CancelDocumentDto,
  ) {
    return this.documents.cancel(ctx, id, body.reason);
  }

  // ------------------------------------------------ signature (DOC-F-16)

  @Put('me/signature')
  @Audited(AuditAction.DoctorSignatureUploaded)
  @NoRequestTransaction('writes an uploaded image to disk (TEN-F-17)')
  @UseInterceptors(
    FileInterceptor('file', { limits: { files: 1, fileSize: 1_000_000 } }),
  )
  @RequirePermission('clinical.sign')
  uploadSignature(
    @Ctx() ctx: TenantContext,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string } | undefined,
  ) {
    return this.documents.uploadSignature(
      ctx,
      file as { buffer: Buffer; mimetype?: string },
    );
  }

  @Get('me/signature')
  @RequirePermission('clinical.sign')
  mySignature(@Ctx() ctx: TenantContext) {
    return this.documents.mySignature(ctx);
  }

  /**
   * Deviation from DOC §8, which asks for `/patients/:id/documents`.
   *
   * PAT already owns that path, and it means something else there: the
   * files attached *to* a patient — a scanned identity card, a letter
   * from another clinic. These are the documents the clinic *issued*.
   * Two different things cannot share one name, and of the two, PAT's
   * was first. Recorded as `DOC-OPEN-01`.
   */
  @Get('patients/:id/issued-documents')
  @RequirePermission('patient.read')
  forPatient(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: DocumentQueryDto,
  ) {
    return this.documents.forPatient(ctx, id, query.type);
  }

  @Get('encounters/:id/documents')
  @RequirePermission('patient.read')
  forEncounter(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.documents.forEncounter(ctx, id);
  }
}
