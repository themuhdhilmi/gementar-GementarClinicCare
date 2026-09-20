import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { DbService } from '../../shared/prisma/db.service.js';
import { toPage } from '../../shared/pagination/page.js';
import { Clock } from '../../shared/time/clock.js';

export class AuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  actorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/**
 * The slice of the audit trail IAM's definition of done needs: break-glass
 * access and failed logins, visible on the admin dashboard. The full `AUD`
 * module owns everything else.
 */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
  ) {}

  @Get('events')
  @RequirePermission('audit.read')
  async events(@Ctx() ctx: TenantContext, @Query() query: AuditQueryDto) {
    void ctx;
    const tx = this.db.tx();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.days ? { occurredAt: { gt: this.clock.agoDays(query.days) } } : {}),
    };

    const [items, total] = await Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          action: true,
          actorId: true,
          actorName: true,
          actorRole: true,
          entityType: true,
          entityId: true,
          branchId: true,
          reason: true,
          ip: true,
          diff: true,
          after: true,
          occurredAt: true,
        },
      }),
      tx.auditLog.count({ where }),
    ]);
    return toPage(items, total, page, pageSize);
  }

  /** Counters for the admin dashboard (IAM §16). */
  @Get('summary')
  @RequirePermission('audit.read')
  async summary(@Ctx() ctx: TenantContext) {
    void ctx;
    const tx = this.db.tx();
    const [breakGlass24h, breakGlass7d, failed24h, failed7d] = await Promise.all([
      tx.auditLog.count({
        where: { action: 'audit.break_glass', occurredAt: { gt: this.clock.agoDays(1) } },
      }),
      tx.auditLog.count({
        where: { action: 'audit.break_glass', occurredAt: { gt: this.clock.agoDays(7) } },
      }),
      tx.auditLog.count({
        where: { action: 'auth.login_failed', occurredAt: { gt: this.clock.agoDays(1) } },
      }),
      tx.auditLog.count({
        where: { action: 'auth.login_failed', occurredAt: { gt: this.clock.agoDays(7) } },
      }),
    ]);
    return {
      breakGlass: { last24h: breakGlass24h, last7d: breakGlass7d },
      failedLogins: { last24h: failed24h, last7d: failed7d },
    };
  }
}
