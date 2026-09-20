/**
 * Domain event names are a stable contract (documents/modules/README.md).
 * In V0 they are dispatched in-process, after the owning transaction commits.
 */
export const DomainEvent = {
  UserCreated: 'user.created',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserRoleChanged: 'user.role_changed',
  AuthLogin: 'auth.login',
  AuthLoginFailed: 'auth.login_failed',
  AuthLogout: 'auth.logout',
  AuthLocked: 'auth.locked',
  SessionRevoked: 'session.revoked',
  MfaEnrolled: 'mfa.enrolled',
  MfaDisabled: 'mfa.disabled',
  BreakGlass: 'audit.break_glass',
} as const;

export type DomainEventName = (typeof DomainEvent)[keyof typeof DomainEvent];

export type DomainEventEnvelope<T = Record<string, unknown>> = {
  name: DomainEventName;
  tenantId: string;
  branchId: string | null;
  actorId: string | null;
  occurredAt: Date;
  payload: T;
};
