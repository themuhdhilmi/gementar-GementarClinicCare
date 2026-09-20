import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Permission } from '../../../shared/access/permissions.js';
import type { RequestWithContext, TenantContext } from '../../tenancy/tenant-context.js';
import type { RequestMeta } from '../services/auth.service.js';
import { clientIp } from '../../../shared/http/client-ip.js';

export const IS_PUBLIC_KEY = 'iam:public';
export const PERMISSION_KEY = 'iam:permission';
export const NO_PERMISSION_KEY = 'iam:no-permission';
export const REAUTH_KEY = 'iam:reauth';
export const PRE_MFA_KEY = 'iam:pre-mfa';
export const MFA_ENROLMENT_KEY = 'iam:mfa-enrolment';
export const NO_REQUEST_TRANSACTION_KEY = 'iam:no-request-transaction';

/** No session required. Use sparingly; every use is a route an attacker can reach. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * IAM-F-22. Every mutating endpoint carries one of these, or an explicit
 * `@NoPermission(reason)`. `npm run lint:routes` fails the build otherwise, and
 * the permission guard refuses the request at runtime as well.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

/** Declares, on the record, that a mutating route needs no permission. */
export const NoPermission = (reason: string) => SetMetadata(NO_PERMISSION_KEY, reason);

/** IAM-F-11: the caller must have proved their identity in the last few minutes. */
export const RequireReauth = () => SetMetadata(REAUTH_KEY, true);

/** Reachable by a session that has not yet passed its second factor. */
export const AllowPreMfa = () => SetMetadata(PRE_MFA_KEY, true);

/** Reachable by a session that still has to enrol in MFA before anything else. */
export const AllowDuringMfaEnrolment = () => SetMetadata(MFA_ENROLMENT_KEY, true);

/**
 * Do not wrap this route in the per-request transaction.
 *
 * Every other authenticated route runs inside one, which is what lets a
 * service take the transaction from the scope instead of threading it
 * through every signature. A streaming route cannot: it is open for hours,
 * and holding a database connection for that long would exhaust the pool
 * after a few dozen clients and breach the transaction cap (TEN-N-05) on
 * the first one.
 *
 * A route marked this way opens its own short scopes, explicitly, for each
 * thing it needs to read. The reason is required and shows up in the lint
 * output, because this is a thing to do deliberately and rarely.
 */
export const NoRequestTransaction = (reason: string) =>
  SetMetadata(NO_REQUEST_TRANSACTION_KEY, reason);

export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<Request & RequestWithContext>();
  if (!request.tenantContext) {
    throw new Error('No tenant context on the request. Is the route marked @Public()?');
  }
  return request.tenantContext;
});

export const Meta = createParamDecorator((_data: unknown, context: ExecutionContext): RequestMeta => {
  const request = context.switchToHttp().getRequest<
    Request & RequestWithContext & { cookies?: Record<string, string> }
  >();
  return {
    ip: clientIp(request),
    userAgent: request.get('user-agent') ?? null,
    requestId: request.id ?? 'unknown',
  };
});
