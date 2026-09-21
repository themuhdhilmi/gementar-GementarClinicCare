import { Body, Controller, Get, Patch } from '@nestjs/common';
import { AuditAction } from '../audit/audit.actions.js';
import { Audited } from '../audit/audit.decorators.js';
import { Ctx, RequirePermission } from '../identity/decorators/auth.decorators.js';
import { DbService } from '../../shared/prisma/db.service.js';
import type { TenantContext } from './tenant-context.js';
import { TenantService } from './tenant.service.js';
import { PatchSettingsDto, UpdateTenantDto } from './dto/tenancy.dto.js';

/** The clinic company, and the settings that apply where the user is working. */
@Controller('tenant')
export class TenancyController {
  constructor(
    private readonly tenants: TenantService,
    private readonly db: DbService,
  ) {}

  @Get()
  async current(@Ctx() ctx: TenantContext) {
    return this.tenants.describe(this.db.tx(), ctx.branchId);
  }

  @Patch()
  @Audited(AuditAction.TenantUpdated)
  @RequirePermission('admin.settings')
  async update(@Ctx() ctx: TenantContext, @Body() dto: UpdateTenantDto) {
    return this.tenants.updateProfile(ctx, dto);
  }

  @Patch('settings')
  @Audited(AuditAction.TenantSettingsChanged)
  @RequirePermission('admin.settings')
  async patchSettings(@Ctx() ctx: TenantContext, @Body() dto: PatchSettingsDto) {
    return {
      settings: await this.tenants.patchSettings(ctx, dto.settings, {
        acknowledge: dto.acknowledge,
      }),
    };
  }
}
