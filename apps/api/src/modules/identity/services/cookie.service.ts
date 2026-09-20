import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { clientIp } from '../../../shared/http/client-ip.js';
import type { RequestMeta } from './auth.service.js';

/**
 * One place that knows how auth cookies are set (IAM-F-02).
 *
 * httpOnly     script on the page cannot read the token, so an XSS bug does not
 *              immediately become an account takeover
 * Secure       never sent over plain http outside local development
 * SameSite=Lax it does not ride along on cross-site POSTs, which is most of CSRF
 */
@Injectable()
export class CookieService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private options(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.cookie.secure,
      sameSite: 'lax',
      path: '/',
      ...(this.config.cookie.domain ? { domain: this.config.cookie.domain } : {}),
      ...(expires ? { expires } : {}),
    };
  }

  setSession(res: Response, token: string, expiresAt: Date): void {
    res.cookie(this.config.cookie.sessionName, token, this.options(expiresAt));
  }

  clearSession(res: Response): void {
    res.clearCookie(this.config.cookie.sessionName, this.options());
  }

  setTrustedDevice(res: Response, token: string, expiresAt: Date): void {
    res.cookie(this.config.cookie.deviceName, token, this.options(expiresAt));
  }

  readDeviceToken(req: Request & { cookies?: Record<string, string> }): string | undefined {
    return req.cookies?.[this.config.cookie.deviceName];
  }

  metaFrom(req: Request & { id?: string; cookies?: Record<string, string> }): RequestMeta {
    return {
      ip: clientIp(req),
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id ?? 'unknown',
      deviceToken: this.readDeviceToken(req),
    };
  }
}
