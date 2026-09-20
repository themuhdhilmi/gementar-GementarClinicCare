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
  /** Every branch this person holds a role at, which is where they may work. */
  readonly branchesWithRole: readonly string[];
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

/**
 * A context for work the system does on its own behalf, in reaction to
 * something a person did.
 *
 * Routing an encounter after a consultation is signed is not a request: it
 * happens after the doctor's transaction has committed, with no session in
 * scope. The audit entry still has to say who caused it, which is why the
 * doctor's own id and a plain description of the cause are carried through
 * rather than inventing a "system" user nobody can ask about.
 *
 * It holds no permissions, deliberately. Anything reachable this way must
 * be a service method whose rules are checked in the service, not a
 * permission check that a fabricated context could satisfy.
 */
export function systemContext(input: {
  tenantId: string;
  branchId: string;
  causedByUserId: string;
  because: string;
}): TenantContext {
  return {
    tenantId: input.tenantId,
    branchId: input.branchId,
    userId: input.causedByUserId,
    sessionId: 'system',
    userName: input.because,
    userEmail: '',
    roles: [],
    rolesAnywhere: [],
    branchesWithRole: [input.branchId],
    permissions: new Set(),
    permissionVersion: 0,
    mfaVerified: true,
    reauthAt: null,
    ip: null,
    userAgent: null,
    requestId: 'system',
  };
}
