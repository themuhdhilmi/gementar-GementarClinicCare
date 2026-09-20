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
  BranchCreated: 'branch.created',
  BranchUpdated: 'branch.updated',
  BranchDeactivated: 'branch.deactivated',
  TenantSettingsChanged: 'tenant.settings_changed',
  TenantSuspended: 'tenant.suspended',

  // Patient registry (PAT, v0-03).
  PatientRegistered: 'patient.registered',
  PatientUpdated: 'patient.updated',
  PatientMerged: 'patient.merged',
  PatientDeleted: 'patient.deleted',
  PatientAllergyAdded: 'patient.allergy_added',
  PatientAllergyVerified: 'patient.allergy_verified',
  PatientAllergyRefuted: 'patient.allergy_refuted',
  PatientConditionChanged: 'patient.condition_changed',
  PatientConsentChanged: 'patient.consent_changed',
  PatientImported: 'patient.imported',

  // Encounter and queue (ENC, v0-04).
  EncounterCreated: 'encounter.created',
  EncounterStatusChanged: 'encounter.status_changed',
  EncounterCalled: 'encounter.called',
  EncounterSkipped: 'encounter.skipped',
  EncounterPriorityChanged: 'encounter.priority_changed',
  EncounterReassigned: 'encounter.reassigned',
  EncounterCompleted: 'encounter.completed',
  EncounterCancelled: 'encounter.cancelled',
  EncounterNoShow: 'encounter.no_show',
  EncounterReopened: 'encounter.reopened',
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
