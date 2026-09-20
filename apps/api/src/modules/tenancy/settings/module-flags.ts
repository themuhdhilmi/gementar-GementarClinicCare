import { z } from 'zod';

/**
 * TEN-F-05: which modules this clinic has switched on.
 *
 * Only V1 and later appear here. The V0 modules are the product — a clinic
 * cannot turn off patients or billing and still have anything — so making them
 * flags would only invite someone to try. Everything here defaults to `false`,
 * because a module that has not been built yet is off for everyone, and a
 * module that has been built is still off until the clinic has bought it and
 * been trained on it.
 *
 * **Adding a module.** Add its key here when its specification is picked up,
 * not when it ships. A flag that exists and is off is a question already
 * answered; a flag invented late is a migration.
 */
export const MODULE_FLAGS = {
  membership: 'Membership plans and member pricing',
  panelCorporate: 'Panel and corporate client billing',
  appointments: 'Appointment booking and reminders',
  supplierPurchasing: 'Suppliers and purchase orders',
  einvoice: 'e-Invoice submission to MyInvois',
  finance: 'Finance: ledgers, payouts and reconciliation',
  notifications: 'Outbound SMS and WhatsApp notifications',
  adminSettings: 'Self-service administration of settings',
  rbacAdvanced: 'Custom roles and an editable permission map',
  multiBranch: 'More than one branch, with transfers between them',
  loyalty: 'Loyalty points and rewards',
  patientWallet: 'Patient wallet and stored credit',
  packages: 'Prepaid treatment packages',
  staffHr: 'Staff records, leave and payroll links',
  doctorManagement: 'Doctor scheduling and commission',
  patientPortal: 'Patient-facing portal',
  labIntegration: 'Laboratory ordering and results',
  analytics: 'Advanced analytics and reporting',
  mobileApps: 'Mobile applications',
  telemedicine: 'Video consultations',
  integrationLayer: 'Integration layer for third-party systems',
  publicApi: 'Public API for the clinic’s own integrations',
  securityAdvanced: 'Advanced security: SSO, IP allow lists, key management',
} as const;

export type ModuleKey = keyof typeof MODULE_FLAGS;

export type ModuleFlags = Record<ModuleKey, boolean>;

const shape = Object.fromEntries(
  Object.keys(MODULE_FLAGS).map((key) => [key, z.boolean().default(false)]),
) as Record<ModuleKey, z.ZodDefault<z.ZodBoolean>>;

export const moduleFlagsSchema = z.object(shape).strict();

/** Everything off, which is what a V0 clinic runs. */
export const DEFAULT_MODULE_FLAGS: ModuleFlags = moduleFlagsSchema.parse({}) as ModuleFlags;

/**
 * Stored flags, filled out with the defaults. Unknown keys are dropped rather
 * than refused: a flag removed from the product should not stop a clinic that
 * still has it written down from starting up.
 */
export function resolveModuleFlags(stored: unknown): ModuleFlags {
  const known: Record<string, unknown> = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (key in MODULE_FLAGS && typeof value === 'boolean') known[key] = value;
    }
  }
  return moduleFlagsSchema.parse(known) as ModuleFlags;
}

export function describeModuleFlags(): Array<{ key: ModuleKey; label: string }> {
  return (Object.keys(MODULE_FLAGS) as ModuleKey[]).map((key) => ({
    key,
    label: MODULE_FLAGS[key],
  }));
}
