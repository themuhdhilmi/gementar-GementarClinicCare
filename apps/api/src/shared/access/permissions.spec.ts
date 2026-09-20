import { describe, expect, it } from 'vitest';
import {
  BREAK_GLASS_PERMISSIONS,
  FRONT_DESK_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  isBreakGlass,
  permissionsFor,
  requiresMfa,
} from './permissions.js';
import { Role } from '../../generated/prisma/enums.js';

describe('permission catalogue', () => {
  it('every role grants only permissions that exist in the catalogue', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(known.has(permission), `${role} grants unknown ${permission}`).toBe(true);
      }
    }
  });

  it('matches the published mapping for the sharp cases', () => {
    // Clinical writing belongs to doctors alone.
    expect(ROLE_PERMISSIONS.DOCTOR).toContain('clinical.write');
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('clinical.write');
    expect(ROLE_PERMISSIONS.NURSE).not.toContain('clinical.write');

    // Money that can be undone is administrator-only.
    expect(ROLE_PERMISSIONS.ADMIN).toContain('invoice.void');
    expect(ROLE_PERMISSIONS.CASHIER).not.toContain('invoice.void');
    expect(ROLE_PERMISSIONS.CASHIER).toContain('payment.take');
    expect(ROLE_PERMISSIONS.DOCTOR).not.toContain('payment.take');

    // The counter is divided: taking money and handing out medicine are
    // different jobs, and a clinic that separates them can now say so.
    expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('dispense.perform');
    expect(ROLE_PERMISSIONS.RECEPTION).not.toContain('payment.take');
    expect(ROLE_PERMISSIONS.DISPENSER).toContain('dispense.perform');
    expect(ROLE_PERMISSIONS.DISPENSER).not.toContain('payment.take');

    // Stock adjustment moves value without a transaction behind it.
    expect(ROLE_PERMISSIONS.ADMIN).toContain('stock.adjust');
    expect(ROLE_PERMISSIONS.NURSE).not.toContain('stock.adjust');
  });

  it('combines roles held at the same branch', () => {
    const both = permissionsFor([Role.CASHIER, Role.NURSE]);
    expect(both).toContain('payment.take');
    expect(both).toContain('triage.write');
    expect(new Set(both).size).toBe(both.length);
  });

  it('the three front-desk roles together are exactly the old single one', () => {
    // IAM-Q-01 split FRONTDESK three ways. Nobody should have gained or lost
    // anything in the process; this is the list as it stood before the split.
    const before = [
      'patient.read', 'patient.write', 'patient.unmask_id',
      'encounter.create', 'encounter.transition', 'encounter.cancel', 'encounter.priority',
      'dispense.perform', 'dispense.substitute',
      'stock.read', 'stock.receive', 'stock.count',
      'invoice.read', 'invoice.issue', 'invoice.discount',
      'payment.take', 'eod.close',
      'document.issue', 'document.reprint', 'report.operational',
    ].sort();
    expect(permissionsFor(FRONT_DESK_ROLES)).toEqual(before);
  });

  it('treats administrator clinical reads as break-glass, and nobody else', () => {
    expect(BREAK_GLASS_PERMISSIONS.ADMIN).toEqual(['clinical.read']);
    expect(isBreakGlass([Role.ADMIN], 'clinical.read')).toBe(true);
    expect(isBreakGlass([Role.DOCTOR], 'clinical.read')).toBe(false);
    expect(isBreakGlass([Role.NURSE], 'clinical.read')).toBe(false);
    // Somebody who is both an administrator and a doctor is reading as a doctor.
    expect(isBreakGlass([Role.ADMIN, Role.DOCTOR], 'clinical.read')).toBe(false);
    expect(isBreakGlass([Role.ADMIN], 'admin.users')).toBe(false);
  });

  it('requires MFA of administrators only, in V0', () => {
    expect(requiresMfa([Role.ADMIN])).toBe(true);
    expect(requiresMfa([Role.CASHIER, Role.ADMIN])).toBe(true);
    expect(requiresMfa([Role.DOCTOR, Role.NURSE, ...FRONT_DESK_ROLES])).toBe(false);
  });
});
