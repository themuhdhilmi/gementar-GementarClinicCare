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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors/domain-errors.js';
import type { TenantContext } from './tenant-context.js';
import { BranchService } from './branch.service.js';
import {
  CreateBranchDto,
  LetterheadDto,
  PatchSettingsDto,
  ReasonDto,
  UpdateBranchDto,
} from './dto/tenancy.dto.js';
import { MAX_LOGO_BYTES } from './letterhead.js';

@Controller('branches')
export class BranchesController {
  constructor(
    private readonly branches: BranchService,
    private readonly db: DbService,
  ) {}

  /** The branches this person can actually work at. */
  @Get()
  async mine(@Ctx() ctx: TenantContext) {
    return { items: await this.branches.listByIds(this.db.tx(), ctx.branchesWithRole) };
  }

  @Get('all')
  @RequirePermission('admin.settings')
  async all(@Ctx() ctx: TenantContext) {
    void ctx;
    return { items: await this.branches.listAll(this.db.tx()) };
  }

  @Post()
  @Audited(AuditAction.BranchCreated)
  @RequirePermission('admin.settings')
  @HttpCode(201)
  async create(@Ctx() ctx: TenantContext, @Body() dto: CreateBranchDto) {
    return this.branches.create(ctx, dto);
  }

  @Get(':id')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    // A branch you hold no role at is not yours to read, unless you administer
    // the clinic (TEN-F-16).
    if (!ctx.branchesWithRole.includes(id) && !ctx.permissions.has('admin.settings')) {
      throw new ForbiddenError('You do not have a role at that branch.');
    }
    return this.branches.getDetail(this.db.tx(), id);
  }

  @Patch(':id')
  @Audited(AuditAction.BranchUpdated)
  @RequirePermission('admin.settings')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: UpdateBranchDto) {
    return this.branches.update(ctx, id, dto);
  }

  @Patch(':id/settings')
  @Audited(AuditAction.BranchSettingsChanged)
  @RequirePermission('admin.settings')
  async patchSettings(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PatchSettingsDto,
  ) {
    return {
      settings: await this.branches.patchSettings(ctx, id, dto.settings, {
        acknowledge: dto.acknowledge,
      }),
    };
  }

  /** TEN-F-10: the text around a printed document. */
  @Patch(':id/letterhead')
  @Audited(AuditAction.BranchLetterheadChanged)
  @RequirePermission('admin.settings')
  async letterhead(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: LetterheadDto,
  ) {
    // Only what was actually sent: an absent field leaves the other one alone.
    const given = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    return this.branches.setLetterhead(ctx, id, given);
  }

  /**
   * TEN-F-10: the logo. Held in memory, capped before it reaches this method,
   * and checked by its bytes rather than by what the browser claims.
   */
  @Put(':id/letterhead/logo')
  @Audited(AuditAction.BranchLetterheadChanged)
  @RequirePermission('admin.settings')
  @UseInterceptors(
    FileInterceptor('logo', { limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }),
  )
  async uploadLogo(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype?: string } | undefined,
  ) {
    return this.branches.setLogo(ctx, id, file);
  }

  @Delete(':id/letterhead/logo')
  @Audited(AuditAction.BranchLetterheadChanged)
  @RequirePermission('admin.settings')
  async deleteLogo(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.branches.removeLogo(ctx, id);
  }

  /**
   * The image, for the settings screen's preview and for DOC. Anyone who works
   * at the branch may see it: it is printed on everything they hand a patient.
   */
  @Get(':id/letterhead/logo')
  @Header('Cache-Control', 'private, max-age=60')
  // An SVG is a document that can carry script, so it is never rendered in
  // this origin: no scripts, and a sandbox with nothing granted.
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  @Header('X-Content-Type-Options', 'nosniff')
  async logo(@Ctx() ctx: TenantContext, @Param('id') id: string, @Res() response: Response) {
    if (!ctx.branchesWithRole.includes(id) && !ctx.permissions.has('admin.settings')) {
      throw new ForbiddenError('You do not have a role at that branch.');
    }
    const logo = await this.branches.getLogo(this.db.tx(), id);
    if (!logo) throw new NotFoundError('Letterhead logo');
    response.type(logo.mime).send(logo.bytes);
  }

  @Post(':id/deactivate')
  @Audited(AuditAction.BranchDeactivated)
  @RequirePermission('admin.settings')
  @HttpCode(200)
  async deactivate(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.branches.deactivate(ctx, id, dto.reason);
  }

  @Post(':id/activate')
  @Audited(AuditAction.BranchActivated)
  @RequirePermission('admin.settings')
  @HttpCode(200)
  async activate(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.branches.activate(ctx, id);
  }
}
