import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { firstValueFrom, from, Observable } from 'rxjs';
import { DbService } from '../../shared/prisma/db.service.js';
import type { RequestWithContext } from '../tenancy/tenant-context.js';

/**
 * Runs the whole handler inside one tenant-scoped transaction, so services can
 * take the transaction from the scope instead of threading it through every
 * signature. Public routes open their own scopes, deliberately and narrowly.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
    const ctx = request.tenantContext;
    if (!ctx) return next.handle();

    return from(this.db.withTenant(ctx.tenantId, () => firstValueFrom(next.handle())));
  }
}
