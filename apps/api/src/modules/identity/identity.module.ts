import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthController } from './controllers/auth.controller.js';
import { MeController } from './controllers/me.controller.js';
import { UsersController } from './controllers/users.controller.js';
import { SessionGuard } from './guards/session.guard.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { ReauthGuard } from './guards/reauth.guard.js';
import { TenantScopeInterceptor } from './tenant-scope.interceptor.js';
import { AuthService } from './services/auth.service.js';
import { BreachedPasswordService } from './services/breached-password.service.js';
import { CookieService } from './services/cookie.service.js';
import { LoginThrottleService } from './services/login-throttle.service.js';
import { MailerService } from './services/mailer.service.js';
import { MfaService } from './services/mfa.service.js';
import { PasswordService } from './services/password.service.js';
import { SessionService } from './services/session.service.js';
import { TokenService } from './services/token.service.js';
import { TrustedDeviceService } from './services/trusted-device.service.js';
import { UserService } from './services/user.service.js';
import { IdentityCleanupJob } from './identity.cleanup.js';

/**
 * Identity and access. Depended on by every other module; depends on tenancy,
 * audit and events only.
 *
 * The guards are global on purpose: a route is protected unless it says
 * otherwise, which is the only default that survives a tired Friday deploy.
 * Order matters — session, then permission, then re-authentication.
 */
@Module({
  controllers: [AuthController, MeController, UsersController],
  providers: [
    AuthService,
    BreachedPasswordService,
    CookieService,
    LoginThrottleService,
    MailerService,
    MfaService,
    PasswordService,
    SessionService,
    TokenService,
    TrustedDeviceService,
    UserService,
    IdentityCleanupJob,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: ReauthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
  ],
  exports: [AuthService, UserService, SessionService, PasswordService, MfaService, CookieService],
})
export class IdentityModule {}
