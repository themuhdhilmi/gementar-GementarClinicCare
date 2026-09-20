import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { ReauthRequiredError } from '../../../shared/errors/domain-errors.js';
import { Clock } from '../../../shared/time/clock.js';
import type { RequestWithContext } from '../../tenancy/tenant-context.js';
import { REAUTH_KEY } from '../decorators/auth.decorators.js';

/** IAM-F-11: sensitive actions need a fresh proof of identity, valid 5 minutes. */
@Injectable()
export class ReauthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const needed = this.reflector.getAllAndOverride<boolean>(REAUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!needed) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
    const ctx = request.tenantContext;
    const reauthAt = ctx?.reauthAt;
    if (!reauthAt) throw new ReauthRequiredError();

    const validUntil = reauthAt.getTime() + this.config.session.reauthMinutes * 60_000;
    if (validUntil <= this.clock.now().getTime()) throw new ReauthRequiredError();
    return true;
  }
}
