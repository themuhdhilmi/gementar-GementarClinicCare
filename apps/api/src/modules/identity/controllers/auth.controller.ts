import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditAction } from '../../audit/audit.actions.js';
import { Audited } from '../../audit/audit.decorators.js';
import {
  AllowDuringMfaEnrolment,
  AllowPreMfa,
  Ctx,
  Meta,
  NoPermission,
  Public,
} from '../decorators/auth.decorators.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import { AuthService, type RequestMeta } from '../services/auth.service.js';
import { CookieService } from '../services/cookie.service.js';
import {
  ForgotPasswordDto,
  LoginDto,
  MfaVerifyDto,
  ReauthDto,
  ResetPasswordDto,
} from '../dto/auth.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
  ) {}

  @Post('login')
  @Audited(AuditAction.AuthLogin)
  @Public()
  @NoPermission('Public entry point; protected by rate limiting and lockout instead.')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, this.cookies.metaFrom(req));
    this.cookies.setSession(res, result.sessionToken, result.expiresAt);
    return {
      mfaRequired: result.mfaRequired,
      mfaEnrolmentRequired: result.mfaEnrolmentRequired,
      user: result.user,
      tenant: result.tenant,
      activeBranchId: result.activeBranchId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('mfa/verify')
  @Audited(AuditAction.AuthLogin)
  @AllowPreMfa()
  @NoPermission('Completes authentication for the current session.')
  @HttpCode(200)
  async verifyMfa(
    @Ctx() ctx: TenantContext,
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyMfa(ctx, dto, this.cookies.metaFrom(req));
    if (result.trustedDeviceToken && result.trustedDeviceExpiresAt) {
      this.cookies.setTrustedDevice(res, result.trustedDeviceToken, result.trustedDeviceExpiresAt);
    }
    return { verified: true, deviceTrusted: Boolean(result.trustedDeviceToken) };
  }

  @Post('logout')
  @Audited(AuditAction.AuthLogout)
  @AllowPreMfa()
  @AllowDuringMfaEnrolment()
  @NoPermission('Ending your own session needs no permission.')
  @HttpCode(204)
  async logout(@Ctx() ctx: TenantContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    this.cookies.clearSession(res);
  }

  @Post('password/forgot')
  @Audited(AuditAction.AuthPasswordResetRequested)
  @Public()
  @NoPermission('Public; always answers the same way to avoid confirming who exists.')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto.email, this.cookies.metaFrom(req));
    return {
      message: 'If that account exists, we have sent a link to reset its password.',
    };
  }

  @Post('password/reset')
  @Audited(AuditAction.AuthPasswordReset)
  @Public()
  @NoPermission('Authorised by the single-use token in the request body.')
  @HttpCode(200)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.resetPassword(dto, this.cookies.metaFrom(req));
    // Every session was just revoked, including this browser's.
    this.cookies.clearSession(res);
    return { message: 'Password updated. Sign in with your new password.' };
  }

  @Post('reauth')
  @Audited(AuditAction.AuthReauth)
  @AllowPreMfa()
  @AllowDuringMfaEnrolment()
  @NoPermission('Proves identity for the current session.')
  @HttpCode(200)
  async reauth(@Ctx() ctx: TenantContext, @Body() dto: ReauthDto) {
    const result = await this.auth.reauthenticate(ctx, dto);
    return { reauthAt: result.reauthAt };
  }

  @Get('me')
  @AllowPreMfa()
  @AllowDuringMfaEnrolment()
  async me(@Ctx() ctx: TenantContext, @Meta() _meta: RequestMeta) {
    return this.auth.describeContext(ctx);
  }
}
