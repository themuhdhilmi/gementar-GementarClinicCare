import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  AllowDuringMfaEnrolment,
  AllowPreMfa,
  Ctx,
  NoPermission,
  RequireReauth,
} from '../decorators/auth.decorators.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { AuthService } from '../services/auth.service.js';
import { ChangePasswordDto, MfaConfirmDto, SwitchBranchDto } from '../dto/auth.dto.js';

/** Everything a staff member can do to their own account (IAM §2, §8). */
@Controller('auth/me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Put('branch')
  @NoPermission('Switching your own active branch is validated against your roles.')
  @HttpCode(200)
  async switchBranch(@Ctx() ctx: TenantContext, @Body() dto: SwitchBranchDto) {
    return this.auth.switchBranch(ctx, dto.branchId);
  }

  @Get('sessions')
  async listSessions(@Ctx() ctx: TenantContext) {
    return { items: await this.auth.listSessions(ctx) };
  }

  @Delete('sessions/:id')
  @NoPermission('Revoking your own session needs no permission.')
  @HttpCode(204)
  async revokeSession(@Ctx() ctx: TenantContext, @Param('id') id: string) {
    await this.auth.revokeOwnSession(ctx, id);
  }

  @Post('mfa/enrol')
  @AllowDuringMfaEnrolment()
  @AllowPreMfa()
  @RequireReauth()
  @NoPermission('Managing your own second factor needs no permission, only re-authentication.')
  @HttpCode(200)
  async enrolMfa(@Ctx() ctx: TenantContext) {
    return this.auth.enrolMfa(ctx);
  }

  @Post('mfa/confirm')
  @AllowDuringMfaEnrolment()
  @AllowPreMfa()
  @NoPermission('Completes enrolment for your own account.')
  @HttpCode(200)
  async confirmMfa(@Ctx() ctx: TenantContext, @Body() dto: MfaConfirmDto) {
    return this.auth.confirmMfa(ctx, dto.code);
  }

  @Delete('mfa')
  @RequireReauth()
  @NoPermission('Managing your own second factor needs no permission, only re-authentication.')
  @HttpCode(204)
  async disableMfa(@Ctx() ctx: TenantContext) {
    await this.auth.disableMfa(ctx);
  }

  @Put('password')
  @RequireReauth()
  @NoPermission('Changing your own password needs no permission, only re-authentication.')
  @HttpCode(204)
  async changePassword(@Ctx() ctx: TenantContext, @Body() dto: ChangePasswordDto) {
    await this.auth.changeOwnPassword(ctx, dto.password);
  }
}
