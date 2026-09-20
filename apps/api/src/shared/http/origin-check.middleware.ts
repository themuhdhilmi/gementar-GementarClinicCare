import { ForbiddenException, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cross-site request forgery defence, layer two. SameSite=Lax cookies already
 * stop the common case; this rejects a state-changing request whose `Origin`
 * is not ours, which also covers older browsers and odd proxies.
 */
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (!MUTATING.has(req.method)) return next();

    const origin = req.get('origin');
    if (!origin) return next(); // non-browser client, e.g. curl or a test runner
    if (this.config.webOrigins.includes(origin)) return next();

    throw new ForbiddenException('Request origin is not allowed.');
  }
}
