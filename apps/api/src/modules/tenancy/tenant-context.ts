import type { Role } from '../../generated/prisma/enums.js';
import type { Permission } from '../../shared/access/permissions.js';

/**
 * Resolved once per request by the session guard, from the session and nothing
 * else (IAM-R-01 / TEN-R-01). No part of it is ever read from a request body,
 * query string, path parameter or header.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly userName: string;
  readonly userEmail: string;
  /** Roles at the active branch — the set permissions are computed from. */
  readonly roles: readonly Role[];
  /** Roles anywhere in the tenant. Used for MFA policy, never for permissions. */
  readonly rolesAnywhere: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  readonly permissionVersion: number;
  readonly mfaVerified: boolean;
  readonly reauthAt: Date | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

export type RequestWithContext = {
  tenantContext?: TenantContext;
  id?: string;
};
