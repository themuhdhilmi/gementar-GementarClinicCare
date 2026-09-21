import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  Ctx,
  RequirePermission,
  RequireReauth,
} from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { toPage } from '../../shared/pagination/page.js';
import { AUDIT_ACTION_GROUPS, AuditAction } from './audit.actions.js';
import { Audited } from './audit.decorators.js';
import { AuditService } from './audit.service.js';
import { AuditQueryService, type AuditFilter } from './audit.query.service.js';
import {
  AccessHistoryDto,
  AuditExportDto,
  AuditSearchDto,
} from './dto/audit.dto.js';

/**
 * Reading the audit trail (AUD §8).
 *
 * There are no write endpoints, and there is no route that takes an
 * entry id and changes it. That is not an omission to be filled in
 * later: the table refuses an `UPDATE` and a `DELETE` at the database
 * (AUD-R-01), so a write endpoint could not work even if somebody added
 * one by mistake.
 */
@Controller()
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly queries: AuditQueryService,
  ) {}

  @Get('audit')
  @RequirePermission('audit.read')
  async search(@Ctx() ctx: TenantContext, @Query() query: AuditSearchDto) {
    void ctx;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const result = await this.queries.search(
      this.db.tx(),
      filterOf(query),
      page,
      pageSize,
    );
    return {
      ...toPage(result.items, result.total, page, pageSize),
      from: result.from,
      to: result.to,
    };
  }

  /** The groups the filter bar offers, so the screen does not hard-code them. */
  @Get('audit/action-groups')
  @RequirePermission('audit.read')
  groups() {
    return { groups: Object.keys(AUDIT_ACTION_GROUPS) };
  }

  @Get('audit/dashboard')
  @RequirePermission('audit.read')
  dashboard(@Ctx() ctx: TenantContext) {
    void ctx;
    return this.queries.dashboard(this.db.tx());
  }

  /**
   * Kept from the shape IAM's dashboard already calls. It is the same
   * data as `/audit/dashboard` in the narrower form that screen wants.
   */
  @Get('audit/summary')
  @RequirePermission('audit.read')
  async summary(@Ctx() ctx: TenantContext) {
    const { breakGlass, failedLogins } = await this.dashboard(ctx);
    return { breakGlass, failedLogins };
  }

  /** The route IAM's admin dashboard already calls; kept working. */
  @Get('audit/events')
  @RequirePermission('audit.read')
  async events(@Ctx() ctx: TenantContext, @Query() query: AuditSearchDto) {
    return this.search(ctx, query);
  }

  @Get('audit/:id')
  @RequirePermission('audit.read')
  entry(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return this.queries.byId(this.db.tx(), id);
  }

  @Get('patients/:id/access-history')
  @RequirePermission('audit.read')
  accessHistory(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: AccessHistoryDto,
  ) {
    void ctx;
    return this.queries.accessHistory(this.db.tx(), id, query.days ?? 366);
  }

  /**
   * AUD-F-13. `POST` because it takes a filter too long for a URL and
   * because it writes — the export records itself.
   */
  @Post('audit/export')
  @HttpCode(200)
  @Audited(AuditAction.AuditExported)
  @RequirePermission('audit.read')
  @RequireReauth()
  async export(
    @Ctx() ctx: TenantContext,
    @Body() body: AuditExportDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const tx = this.db.tx();
    const filter = filterOf(body);
    const result = await this.queries.exportCsv(tx, filter);

    await this.audit.record(tx, this.audit.actorFromContext(ctx), {
      action: AuditAction.AuditExported,
      entityType: 'audit_log',
      after: {
        rows: result.rows,
        truncated: result.truncated,
        from: result.from.toISOString(),
        to: result.to.toISOString(),
        filter,
      },
    });

    const stamp = result.from.toISOString().slice(0, 10);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${stamp}.csv"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    // Returned, not sent: `response.send()` would put the file on the
    // wire before this request's transaction commits, and the entry
    // recording the export is in that transaction. The caller must not
    // be able to hold a copy of the audit trail that the audit trail
    // does not know about.
    return result.csv;
  }
}

function filterOf(query: AuditSearchDto | AuditExportDto): AuditFilter {
  const days = 'days' in query ? query.days : undefined;
  return {
    from: query.from
      ? new Date(query.from)
      : days
        ? new Date(Date.now() - days * 86_400_000)
        : undefined,
    to: query.to ? new Date(query.to) : undefined,
    actorId: query.actorId,
    action: query.action,
    actionGroup: query.actionGroup,
    entityType: 'entityType' in query ? query.entityType : undefined,
    entityId: 'entityId' in query ? query.entityId : undefined,
    patientId: query.patientId,
    branchId: query.branchId,
  };
}
