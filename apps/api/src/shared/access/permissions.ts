import { Role } from '../../generated/prisma/enums.js';

/**
 * The V0 permission catalogue, exactly as published in
 * `documents/modules/README.md`. Permissions are strings checked at the API
 * layer; V1's `RBC` module makes the role mapping configurable per tenant, so
 * everything here is deliberately data rather than code.
 *
 * IAM owns this catalogue. It lives in `shared` because every module reads it.
 */
export const PERMISSIONS = [
  'patient.read',
  'patient.write',
  'patient.unmask_id',
  'patient.merge',
  'patient.export',
  'encounter.create',
  'encounter.transition',
  'encounter.cancel',
  'encounter.priority',
  'triage.write',
  'clinical.read',
  'clinical.write',
  'clinical.sign',
  'clinical.amend',
  'rx.write',
  'rx.override_warning',
  'dispense.perform',
  'dispense.substitute',
  'dispense.cancel',
  'stock.read',
  'stock.receive',
  'stock.adjust',
  'stock.count',
  'catalogue.write',
  'procedure.order',
  'procedure.perform',
  'invoice.read',
  'invoice.issue',
  'invoice.discount',
  'invoice.void',
  'payment.take',
  'payment.void',
  'eod.close',
  'document.issue',
  'document.reprint',
  'audit.read',
  'report.operational',
  'report.financial',
  'admin.users',
  'admin.settings',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ADMIN: [
    'patient.read',
    'patient.write',
    'patient.unmask_id',
    'patient.merge',
    'patient.export',
    'encounter.create',
    'encounter.transition',
    'encounter.cancel',
    'encounter.priority',
    'triage.write',
    'clinical.read', // break-glass, see BREAK_GLASS_PERMISSIONS
    'dispense.perform',
    'dispense.substitute',
    'dispense.cancel',
    'stock.read',
    'stock.receive',
    'stock.adjust',
    'stock.count',
    'catalogue.write',
    'procedure.perform',
    'invoice.read',
    'invoice.issue',
    'invoice.discount',
    'invoice.void',
    'payment.take',
    'payment.void',
    'eod.close',
    'document.issue',
    'document.reprint',
    'audit.read',
    'report.operational',
    'report.financial',
    'admin.users',
    'admin.settings',
  ],
  DOCTOR: [
    'patient.read',
    'patient.write',
    'patient.unmask_id',
    'encounter.create',
    'encounter.transition',
    'encounter.cancel',
    'encounter.priority',
    'triage.write',
    'clinical.read',
    'clinical.write',
    'clinical.sign',
    'clinical.amend',
    'rx.write',
    'rx.override_warning',
    'dispense.perform',
    'dispense.substitute',
    'dispense.cancel',
    'stock.read',
    'procedure.order',
    'procedure.perform',
    'invoice.read',
    'document.issue',
    'document.reprint',
    'report.operational',
  ],
  NURSE: [
    'patient.read',
    'patient.write',
    'encounter.create',
    'encounter.transition',
    'encounter.priority',
    'triage.write',
    'clinical.read',
    'dispense.perform',
    'stock.read',
    'stock.receive',
    'stock.count',
    'procedure.perform',
    'document.reprint',
    'report.operational',
  ],
  FRONTDESK: [
    'patient.read',
    'patient.write',
    'patient.unmask_id',
    'encounter.create',
    'encounter.transition',
    'encounter.cancel',
    'encounter.priority',
    'dispense.perform',
    'dispense.substitute',
    'stock.read',
    'stock.receive',
    'stock.count',
    'invoice.read',
    'invoice.issue',
    'invoice.discount', // capped by billing.max_discount_pct_frontdesk (BIL)
    'payment.take',
    'eod.close',
    'document.issue',
    'document.reprint',
    'report.operational',
  ],
};

/**
 * Permissions a role holds but should not use casually. Granted, allowed, and
 * every use recorded as `audit.break_glass` (IAM-F-23).
 */
export const BREAK_GLASS_PERMISSIONS: Readonly<Partial<Record<Role, readonly Permission[]>>> = {
  ADMIN: ['clinical.read'],
};

/** Roles for which MFA is mandatory in V0 (IAM-F-09). */
export const MFA_REQUIRED_ROLES: readonly Role[] = [Role.ADMIN];

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  return [...out].sort();
}

/**
 * True when the only reason the user holds this permission is a break-glass
 * grant. A doctor reading clinical data is routine; an administrator doing it
 * is not.
 */
export function isBreakGlass(roles: readonly Role[], permission: Permission): boolean {
  let viaBreakGlass = false;
  for (const role of roles) {
    const normal = (ROLE_PERMISSIONS[role] ?? []).filter(
      (p) => !(BREAK_GLASS_PERMISSIONS[role] ?? []).includes(p),
    );
    if (normal.includes(permission)) return false;
    if ((BREAK_GLASS_PERMISSIONS[role] ?? []).includes(permission)) viaBreakGlass = true;
  }
  return viaBreakGlass;
}

export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
}
