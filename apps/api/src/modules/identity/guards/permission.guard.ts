import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { ForbiddenError } from '../../../shared/errors/domain-errors.js';
import { isBreakGlass, type Permission } from '../../../shared/access/permissions.js';
import { DbService } from '../../../shared/prisma/db.service.js';
import { Clock } from '../../../shared/time/clock.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditAction } from '../../audit/audit.actions.js';
import { EventBus } from '../../events/event-bus.service.js';
import { DomainEvent } from '../../events/domain-events.js';
import type { RequestWithContext } from '../../tenancy/tenant-context.js';
import {
  IS_PUBLIC_KEY,
  NO_PERMISSION_KEY,
  PERMISSION_KEY,
} from '../decorators/auth.decorators.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Checks `(user, branch, permission)` (IAM-F-20) and enforces IAM-R-03 at
 * runtime: a mutating route with no declaration is refused rather than allowed.
 * The CI check catches it earlier; this catches the case where CI was skipped.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
    const ctx = request.tenantContext;
    if (!ctx) throw new ForbiddenError();

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      targets,
    );

    if (!required) {
      const exempt = this.reflector.getAllAndOverride<string | undefined>(
        NO_PERMISSION_KEY,
        targets,
      );
      if (MUTATING.has(request.method) && !exempt) {
        this.logger.error(
          `${request.method} ${request.route?.path ?? request.originalUrl} has no @RequirePermission`,
        );
        throw new ForbiddenError('This endpoint is not configured for authorisation.');
      }
      return true;
    }

    if (!ctx.permissions.has(required)) {
      throw new ForbiddenError('You do not have permission to do that.', {
        permission: required,
        branchId: ctx.branchId,
      });
    }

    if (isBreakGlass(ctx.roles, required)) {
      // IAM-F-23: allowed, and visible. An administrator reading clinical data
      // is a legitimate act that somebody should be able to review later.
      await this.db.withTenant(ctx.tenantId, (tx) =>
        this.audit.record(tx, this.audit.actorFromContext(ctx), {
          action: AuditAction.BreakGlass,
          entityType: 'route',
          entityId: null,
          after: {
            permission: required,
            method: request.method,
            path: request.originalUrl,
            params: request.params,
          },
        }),
      );
      this.events.publish({
        name: DomainEvent.BreakGlass,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        actorId: ctx.userId,
        occurredAt: this.clock.now(),
        payload: { permission: required, path: request.originalUrl },
      });
    }

    return true;
  }
}
