import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { firstValueFrom, from, Observable } from 'rxjs';
import { DbService } from '../../shared/prisma/db.service.js';
import type { RequestWithContext } from '../tenancy/tenant-context.js';
import { NO_REQUEST_TRANSACTION_KEY } from './decorators/auth.decorators.js';

/**
 * Runs the whole handler inside one tenant-scoped transaction, so services can
 * take the transaction from the scope instead of threading it through every
 * signature. Public routes open their own scopes, deliberately and narrowly.
 *
 * A route marked `@NoRequestTransaction(reason)` is left alone. That exists
 * for streaming: this interceptor takes the *first* value from the handler's
 * observable and then unsubscribes, which would close a stream after one
 * event, and it would hold a transaction open for as long as the connection
 * lasted. Both are wrong for an endpoint that stays open all afternoon.
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
    const ctx = request.tenantContext;
    if (!ctx) return next.handle();

    const streaming = this.reflector.getAllAndOverride<string | undefined>(
      NO_REQUEST_TRANSACTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (streaming) return next.handle();

    // Named, so TEN-N-05 can say which handler held the transaction too long.
    const label = `${context.getClass().name}.${context.getHandler().name}`;
    return from(
      this.db.withTenant(ctx.tenantId, () => firstValueFrom(next.handle()), { label }),
    );
  }
}
