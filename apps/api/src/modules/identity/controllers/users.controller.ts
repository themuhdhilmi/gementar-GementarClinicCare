import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Ctx, RequirePermission } from '../decorators/auth.decorators.js';
import { AuditAction } from '../../audit/audit.actions.js';
import { Audited, NotAudited } from '../../audit/audit.decorators.js';
import { DbService } from '../../../shared/prisma/db.service.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { UserService } from '../services/user.service.js';
import { MailerService } from '../services/mailer.service.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  ReasonDto,
  ReplaceRolesDto,
  UpdateUserDto,
} from '../dto/users.dto.js';

/** Staff administration. Every route needs `admin.users` (IAM §8). */
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UserService,
    private readonly mailer: MailerService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequirePermission('admin.users')
  async list(@Ctx() ctx: TenantContext, @Query() query: ListUsersQueryDto) {
    void ctx;
    return this.users.list(this.db.tx(), {
      status: query.status,
      branchId: query.branchId,
      role: query.role,
      query: query.q,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
    });
  }

  @Post()
  @Audited(AuditAction.UserCreated)
  @RequirePermission('admin.users')
  @HttpCode(201)
  async create(@Ctx() ctx: TenantContext, @Body() dto: CreateUserDto) {
    const result = await this.users.create(ctx, {
      name: dto.name,
      email: dto.email,
      phone: dto.phone ?? null,
      roles: dto.roles,
      defaultBranchId: dto.defaultBranchId ?? null,
    });
    return {
      user: result.user,
      invite: {
        expiresAt: result.inviteExpiresAt,
        // V0 has no transactional email provider yet (IAM-Q-03), so the
        // administrator can hand the link over directly (§14).
        link: this.mailer.linksAreNotDelivered ? result.inviteLink : undefined,
      },
    };
  }

  /** §16: active users by role and branch. Declared before `:id` so the path wins. */
  @Get('statistics')
  @RequirePermission('admin.users')
  async statistics(@Ctx() ctx: TenantContext) {
    void ctx;
    return this.users.statistics(this.db.tx());
  }

  @Get(':id')
  @RequirePermission('admin.users')
  async get(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    void ctx;
    return this.users.getOrThrow(this.db.tx(), id);
  }

  @Patch(':id')
  @Audited(AuditAction.UserUpdated)
  @RequirePermission('admin.users')
  async update(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(ctx, id, dto);
  }

  @Put(':id/roles')
  @Audited(AuditAction.UserRoleChanged)
  @RequirePermission('admin.users')
  async replaceRoles(
    @Ctx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ReplaceRolesDto,
  ) {
    return this.users.replaceRoles(ctx, id, dto.roles);
  }

  @Post(':id/disable')
  @Audited(AuditAction.UserDisabled)
  @RequirePermission('admin.users')
  @HttpCode(200)
  async disable(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.users.disable(ctx, id, dto.reason);
  }

  @Post(':id/enable')
  @Audited(AuditAction.UserEnabled)
  @RequirePermission('admin.users')
  @HttpCode(200)
  async enable(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.users.enable(ctx, id);
  }

  @Post(':id/unlock')
  @Audited(AuditAction.UserUnlocked)
  @RequirePermission('admin.users')
  @HttpCode(200)
  async unlock(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    return this.users.unlock(ctx, id);
  }

  @Post(':id/sessions/revoke-all')
  @Audited(AuditAction.SessionRevoked)
  @RequirePermission('admin.users')
  @HttpCode(200)
  async revokeSessions(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const revoked = await this.users.revokeAllSessions(ctx, id);
    return { revoked };
  }

  @Post(':id/password/force-reset')
  @Audited(AuditAction.UserPasswordForceReset)
  @RequirePermission('admin.users')
  @HttpCode(200)
  async forceReset(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    const result = await this.users.forcePasswordReset(ctx, id);
    return {
      expiresAt: result.expiresAt,
      link: this.mailer.linksAreNotDelivered ? result.link : undefined,
    };
  }

  /** §14: lost device, no recovery codes. Identity is verified out of band. */
  @Post(':id/mfa/reset')
  @Audited(AuditAction.UserMfaReset)
  @RequirePermission('admin.users')
  @HttpCode(204)
  async resetMfa(@Ctx() ctx: TenantContext, @Param('id') id: string, @Body() dto: ReasonDto) {
    await this.users.resetMfa(ctx, id, dto.reason);
  }
}
