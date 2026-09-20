import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { StorageService } from '../../shared/storage/storage.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../audit/audit.actions.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/domain-errors.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PatientService } from './patient.service.js';
import { PatientSearchService } from './patient-search.service.js';
import { PatientClinicalService } from './patient-clinical.service.js';
import { PatientRecordsService } from './patient-records.service.js';
import { PatientMergeService } from './patient-merge.service.js';
import { PatientImportService } from './patient-import.service.js';
import {
  AllergyDto,
  ConditionDto,
  ConsentsDto,
  ContactDto,
  DocumentTypeDto,
  MergeDto,
  NkdaDto,
  PatientBodyDto,
  ReasonBodyDto,
  SearchDto,
  UpdateContactDto,
  UpdatePatientDto,
} from './dto/patient.dto.js';

@Controller('patients')
export class PatientsController {
  constructor(
    private readonly patients: PatientService,
    private readonly search: PatientSearchService,
    private readonly clinical: PatientClinicalService,
    private readonly records: PatientRecordsService,
    private readonly merges: PatientMergeService,
    private readonly imports: PatientImportService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  // ---------------------------------------------------------------- search

  /**
   * A POST, deliberately, for a read.
   *
   * The text a receptionist types is very often an identity card number, and
   * PAT-N-06 says those never appear in a URL. A query string is written to
   * the access log, to browser history and to every proxy on the way, so the
   * search term travels in the body instead. §8 sketches this as a GET; the
   * compliance requirement wins.
   */
  @Post('search')
  @RequirePermission('patient.read')
  @HttpCode(200)
  async runSearch(@Ctx() ctx: TenantContext, @Body() dto: SearchDto) {
    void ctx;
    return { items: await this.search.search(dto.q) };
  }

  @Get('recent')
  @RequirePermission('patient.read')
  async recent(@Ctx() ctx: TenantContext) {
    return { items: await this.search.recent(ctx.userId, ctx.branchId) };
  }

  // ------------------------------------------------------------ the record

  @Post('check-duplicates')
  @RequirePermission('patient.write')
  @HttpCode(200)
  async checkDuplicates(@Ctx() ctx: TenantContext, @Body() dto: PatientBodyDto) {
    void ctx;
    return { candidates: await this.patients.findDuplicates(dto) };
  }

  @Post()
  @RequirePermission('patient.write')
  @HttpCode(201)
  async register(
    @Ctx() ctx: TenantContext,
    @Body() dto: PatientBodyDto,
    @Query('force') force?: string,
  ) {
    return this.patients.register(ctx, dto, force === 'true');
  }

  @Get(':id')
  @RequirePermission('patient.read')
  async get(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query('unmask') unmask?: string,
  ) {
    const patient = await this.patients.read(ctx, id, unmask === 'true');
    // PAT-F-19. Opening a record is what puts it on the list, and the list
    // is per person per counter.
    await this.search.remember(ctx.userId, ctx.branchId, id);
    await this.search.pruneRecent(ctx.userId, ctx.branchId);
    return patient;
  }

  @Patch(':id')
  @RequirePermission('patient.write')
  async update(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePatientDto,
  ) {
    const { reason, ...rest } = dto;
    return this.patients.update(ctx, id, rest, reason);
  }

  @Post(':id/delete')
  @RequirePermission('patient.merge')
  @HttpCode(200)
  async remove(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReasonBodyDto) {
    return this.patients.softDelete(ctx, id, dto.reason);
  }

  // --------------------------------------------------------------- clinical

  /**
   * PAT-T-11: gated on `clinical.read`, and the view is recorded.
   *
   * For an administrator this is break-glass: they may look, and the fact
   * that they looked appears on the audit screen. For a doctor it is
   * routine. The guard decides which, from the permission catalogue.
   */
  @Get(':id/clinical-summary')
  @RequirePermission('clinical.read')
  async clinicalSummary(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const tx = this.db.tx();
    const summary = await this.clinical.summary(tx, id);
    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.ClinicalViewed,
      entityType: 'patient',
      entityId: id,
      subjectPatientId: id,
    });
    return summary;
  }

  @Post(':id/allergies')
  @RequirePermission('triage.write')
  @HttpCode(201)
  async addAllergy(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: AllergyDto) {
    return this.clinical.addAllergy(ctx, id, dto);
  }

  @Post(':id/allergies/:allergyId/verify')
  @RequirePermission('clinical.write')
  @HttpCode(200)
  async verifyAllergy(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('allergyId') allergyId: string,
  ) {
    return this.clinical.verifyAllergy(ctx, id, allergyId);
  }

  @Post(':id/allergies/:allergyId/refute')
  @RequirePermission('clinical.write')
  @HttpCode(200)
  async refuteAllergy(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('allergyId') allergyId: string,
    @Body() dto: ReasonBodyDto,
  ) {
    return this.clinical.refuteAllergy(ctx, id, allergyId, dto.reason);
  }

  @Put(':id/nkda')
  @RequirePermission('triage.write')
  async setNkda(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: NkdaDto) {
    return this.clinical.recordNkda(ctx, id, dto.nkda);
  }

  @Post(':id/conditions')
  @RequirePermission('triage.write')
  @HttpCode(201)
  async addCondition(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ConditionDto,
  ) {
    return this.clinical.addCondition(ctx, id, dto);
  }

  @Patch(':id/conditions/:conditionId')
  @RequirePermission('triage.write')
  async updateCondition(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('conditionId') conditionId: string,
    @Body() dto: ConditionDto,
  ) {
    return this.clinical.updateCondition(ctx, id, conditionId, dto);
  }

  // ------------------------------------------------------- contacts, consents

  @Get(':id/contacts')
  @RequirePermission('patient.read')
  async listContacts(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return { items: await this.records.listContacts(this.db.tx(), id) };
  }

  @Post(':id/contacts')
  @RequirePermission('patient.write')
  @HttpCode(201)
  async addContact(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ContactDto) {
    return { items: await this.records.addContact(ctx, id, dto) };
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermission('patient.write')
  async updateContact(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return { items: await this.records.updateContact(ctx, id, contactId, dto) };
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermission('patient.write')
  async removeContact(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return { items: await this.records.removeContact(ctx, id, contactId) };
  }

  @Get(':id/consents')
  @RequirePermission('patient.read')
  async listConsents(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return { items: await this.records.listConsents(this.db.tx(), id) };
  }

  @Put(':id/consents')
  @RequirePermission('patient.write')
  async setConsents(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ConsentsDto) {
    return { items: await this.records.setConsents(ctx, id, dto.consents) };
  }

  // ------------------------------------------------------------- documents

  @Get(':id/documents')
  @RequirePermission('patient.read')
  async listDocuments(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return { items: await this.records.listDocuments(this.db.tx(), id) };
  }

  /**
   * The row is written inside the transaction; the bytes are written once it
   * has committed.
   *
   * Every handler runs inside a tenant transaction, and a twenty megabyte
   * write must not hold a database connection while it happens (TEN-F-17) —
   * the storage service refuses to run inside one at all. So the file lands
   * after the commit, through `afterCommit`.
   *
   * The order has a cost, and it is the right way round. If the write fails,
   * a row exists whose bytes do not, and downloading it answers "not found"
   * and logs loudly. The alternative, writing bytes first, would need the
   * transaction held open across the write, which is the thing being avoided.
   * Re-uploading the document is the fix, and the clinic still has the paper.
   */
  @Post(':id/documents')
  @RequirePermission('patient.write')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1 } }))
  async addDocument(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DocumentTypeDto,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string; originalname?: string } | undefined,
  ) {
    const prepared = await this.records.prepareUpload(file!);
    const key = this.storage.newKey(ctx.tenantId, 'patient-document', prepared.extension);

    const items = await this.records.recordDocument(ctx, id, dto.type, {
      mime: prepared.mime,
      filename: prepared.filename,
      sizeBytes: prepared.bytes.length,
      storageKey: key,
    });

    // Registered, not awaited: the transaction has to commit first, and
    // awaiting here would wait for a commit that cannot happen until this
    // handler returns. A failure still surfaces as this request's error.
    this.db.deferUntilCommitted(() => this.storage.put(key, ctx.tenantId, prepared.bytes));
    return { items };
  }

  @Get(':id/documents/:documentId')
  @RequirePermission('patient.read')
  async documentLink(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.records.issueDocumentLink(ctx, id, documentId);
  }

  @Get(':id/documents/:documentId/content')
  @RequirePermission('patient.read')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  async documentContent(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Query('token') token: string,
    @Res() response: Response,
  ) {
    const document = await this.records.fetchDocument(ctx, id, documentId, token ?? '');
    const bytes = await this.storage.get(document.storageKey, ctx.tenantId);
    response
      .type(document.mime)
      // An attachment, never rendered in this origin: a PDF is a program.
      .setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    response.send(bytes);
  }

  @Delete(':id/documents/:documentId')
  @RequirePermission('patient.write')
  async deleteDocument(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return { items: await this.records.deleteDocument(ctx, id, documentId) };
  }

  // ----------------------------------------------------------------- merge

  @Post(':id/merge')
  @RequirePermission('patient.merge')
  @HttpCode(200)
  async merge(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: MergeDto) {
    return this.merges.merge(ctx, id, dto.loserId);
  }

  /**
   * PAT-F-27: a copy of everything held about this patient.
   *
   * Contains the identity number in full, because the person asking is the
   * patient and masking it would defeat the request. Restricted to
   * `patient.export`, and every export is recorded.
   */
  @Post(':id/export')
  @RequirePermission('patient.export')
  @HttpCode(200)
  async exportPatient(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.records.exportPatient(ctx, id);
  }

  // ---------------------------------------------------------------- import

  /**
   * PAT-F-28: the pilot's existing patients.
   *
   * A dry run writes nothing and returns a verdict per row. That report is
   * the artefact the clinic actually reviews, and agreeing it is what makes
   * the real run boring.
   */
  @Post('import')
  @RequirePermission('admin.settings')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: 50_000_000 } }))
  async importCsv(
    @Ctx() ctx: TenantContext,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Query('dryRun') dryRun?: string,
    @Query('startMrnAt') startMrnAt?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestError('No file was uploaded.', 'file_missing');
    }
    return this.imports.run(ctx, file.originalname ?? 'patients.csv', file.buffer.toString('utf8'), {
      // Safe by default: an import only writes when it is asked to in so
      // many words, so a mistyped request cannot create ten thousand rows.
      dryRun: dryRun !== 'false',
      startMrnAt: startMrnAt ? Number(startMrnAt) : undefined,
    });
  }

  @Get('import/:batchId')
  @RequirePermission('admin.settings')
  async importReport(@Ctx() ctx: TenantContext, @Param('batchId') batchId: string) {
    void ctx;
    const batch = await this.imports.getBatch(batchId);
    if (!batch) throw new NotFoundError('Import batch');
    return batch;
  }

  @Post(':id/unmerge')
  @RequirePermission('patient.merge')
  @HttpCode(200)
  async unmerge(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.merges.unmerge(ctx, id);
  }
}
