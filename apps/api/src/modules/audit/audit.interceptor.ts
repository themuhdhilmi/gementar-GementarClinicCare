import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, firstValueFrom, Observable } from 'rxjs';
import { DbService } from '../../shared/prisma/db.service.js';
import { currentScope } from '../../shared/prisma/tenant-scope.js';
import type { RequestWithContext } from '../tenancy/tenant-context.js';
import type { AuditActionName } from './audit.actions.js';
import { AUDITED_KEY } from './audit.decorators.js';
import { AuditService } from './audit.service.js';
import { trackAuditWrites } from './audit.request.js';

type AuditedMeta = { action: AuditActionName; entityType?: string };

/**
 * The backstop behind `@Audited` (AUD-F-03).
 *
 * The specification imagines an interceptor that audits every mutating
 * request on its own, reconstructing `before` and `after` from the route.
 * That is not what this does, and the difference is worth stating.
 *
 * An interceptor sees a request and a response body. It does not see
 * that a discount was applied inside an invoice update, or that a
 * prescriber overrode an interaction warning, or which of four rows a
 * transition touched — all of which the services already record, inside
 * the transaction, where AUD-R-02 requires them to be. Replacing that
 * with route-level inference would trade real detail for uniformity.
 *
 * So this runs *after* the handler and asks one question: did anything
 * reach the audit trail during this request? If yes, it stays out of the
 * way. If no, it writes the entry the route declared. The result is that
 * "every mutating route is audited" is true by construction rather than
 * by everyone having remembered — and the lint rule (`AUD-R-03`) makes
 * the declaration itself mandatory.
 *
 * It runs inside the request's transaction, which is what makes the
 * fallback entry share the fate of the change, exactly as an explicit
 * one would.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const declared = this.reflector.getAllAndOverride<AuditedMeta | undefined>(
      AUDITED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!declared) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<Request & RequestWithContext>();
    const ctx = request.tenantContext;
    if (!ctx) return next.handle();

    return from(
      trackAuditWrites(async (state) => {
        const result = await firstValueFrom(next.handle());
        // A handler that threw never gets here, which is the point: a
        // rejected request changed nothing, so there is nothing to record
        // (§4 — 4xx are not audited).
        if (state.written > 0) return result;

        const entry = {
          action: declared.action,
          entityType: declared.entityType ?? entityTypeFrom(declared.action),
          entityId: idFrom(result),
          after: summarise(result),
        };
        const actor = this.audit.actorFromContext(ctx);

        // Usually there is a request transaction and the entry joins it,
        // which is what makes the fallback share the fate of the change.
        // A route marked `@NoRequestTransaction` has none — it has
        // already committed whatever it did in scopes of its own — so the
        // entry opens one. Recording it late is worse than recording it
        // atomically and better than not recording it.
        if (currentScope()) {
          await this.audit.record(this.db.tx(), actor, entry);
        } else {
          await this.db.withTenant(ctx.tenantId, (tx) =>
            this.audit.record(tx, actor, entry),
          );
        }
        return result;
      }),
    );
  }
}

/** `invoice.voided` describes an invoice. */
function entityTypeFrom(action: string): string {
  return action.split('.')[0] ?? 'unknown';
}

/**
 * Responses in this system are either an entity, `{ entity: {...} }` or
 * `{ items: [...] }`. Anything else contributes no id, which is not a
 * failure — the entry still records who did what and when.
 */
function idFrom(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (typeof record['id'] === 'string') return record['id'];
  for (const value of Object.values(record)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string'
    ) {
      return (value as { id: string }).id;
    }
  }
  return null;
}

/**
 * A fallback entry carries the response, not the entity: the interceptor
 * never saw the entity. The service-written entries are the ones with
 * before-and-after, and they are the overwhelming majority.
 */
function summarise(result: unknown): unknown {
  if (result === undefined || result === null) return { ok: true };
  if (typeof result !== 'object') return { result };
  return result;
}
