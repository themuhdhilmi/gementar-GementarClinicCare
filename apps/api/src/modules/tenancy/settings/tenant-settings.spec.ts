import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  describeSettings,
  explainSettingsIssues,
  resolveSettings,
  settingsPatchSchema,
  SETTINGS_SCHEMA_VERSION,
} from './tenant-settings.js';
import {
  DEFAULT_MODULE_FLAGS,
  describeModuleFlags,
  MODULE_FLAGS,
  resolveModuleFlags,
} from './module-flags.js';

describe('Tenant settings (TEN-F-04, TEN-F-09)', () => {
  it('fills in every default rather than leaving the document hollow', () => {
    expect(DEFAULT_SETTINGS.billing.maxDiscountPctFrontdesk).toBe(10);
    expect(DEFAULT_SETTINGS.billing.roundCashTo5Sen).toBe(true);
    expect(DEFAULT_SETTINGS.queue.resetDaily).toBe(true);
    expect(DEFAULT_SETTINGS.clinical.requireDiagnosisToSign).toBe(false);
  });

  it('resolves branch over tenant over default', () => {
    const resolved = resolveSettings(
      { billing: { maxDiscountPctFrontdesk: 25 }, queue: { numberPrefix: 'A' } },
      { billing: { maxDiscountPctFrontdesk: 5 } },
    );
    expect(resolved.billing.maxDiscountPctFrontdesk).toBe(5);
    expect(resolved.queue.numberPrefix).toBe('A');
    expect(resolved.billing.roundCashTo5Sen).toBe(true);
  });

  it('treats an empty clinic and an unknown branch as all defaults', () => {
    expect(resolveSettings(null, null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({}, undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('stores only what was asked for, so a changed default still lands', () => {
    // The trap this guards: a patch schema built with `.partial()` keeps each
    // field's default, so patching one key writes today's value for all its
    // siblings and freezes the clinic on them forever.
    const patch = settingsPatchSchema.parse({ billing: { maxDiscountPctFrontdesk: 5 } });
    expect(patch).toEqual({ billing: { maxDiscountPctFrontdesk: 5 } });
    expect(applyPatch(null, patch)).toEqual({ billing: { maxDiscountPctFrontdesk: 5 } });
  });

  it('merges a patch into what is already stored, group by group', () => {
    const stored = { billing: { maxDiscountPctFrontdesk: 5 }, queue: { numberPrefix: 'A' } };
    const next = applyPatch(stored, settingsPatchSchema.parse({ billing: { roundCashTo5Sen: false } }));
    expect(next).toEqual({
      billing: { maxDiscountPctFrontdesk: 5, roundCashTo5Sen: false },
      queue: { numberPrefix: 'A' },
    });
  });

  it('clears an override with null rather than freezing the current value', () => {
    const stored = { billing: { maxDiscountPctFrontdesk: 5, roundCashTo5Sen: false } };
    const patch = settingsPatchSchema.parse({ billing: { maxDiscountPctFrontdesk: null } });
    expect(applyPatch(stored, patch)).toEqual({ billing: { roundCashTo5Sen: false } });

    // A group with nothing left in it goes away, so "overrides nothing" is {}.
    const emptied = applyPatch(
      { billing: { roundCashTo5Sen: false } },
      settingsPatchSchema.parse({ billing: { roundCashTo5Sen: null } }),
    );
    expect(emptied).toEqual({});

    // And the branch then follows the clinic, not the value it used to hold.
    expect(resolveSettings({ billing: { maxDiscountPctFrontdesk: 30 } }, emptied)
      .billing.maxDiscountPctFrontdesk).toBe(30);
  });

  it('names the key when one is not a setting (TEN-T-10)', () => {
    const bad = settingsPatchSchema.safeParse({ billing: { nonsense: true } });
    expect(bad.success).toBe(false);
    expect(explainSettingsIssues(bad.error!).join(' ')).toContain('billing.nonsense');

    const group = settingsPatchSchema.safeParse({ astrology: {} });
    expect(explainSettingsIssues(group.error!).join(' ')).toContain('astrology');

    const range = settingsPatchSchema.safeParse({ billing: { maxDiscountPctFrontdesk: 400 } });
    expect(explainSettingsIssues(range.error!).join(' ')).toContain(
      'billing.maxDiscountPctFrontdesk',
    );
  });

  it('describes every field for the settings screen', () => {
    const fields = describeSettings();
    expect(fields.length).toBe(
      Object.values(DEFAULT_SETTINGS).reduce((n, group) => n + Object.keys(group).length, 0),
    );
    for (const field of fields) {
      expect(field.help, `${field.group}.${field.key}`).not.toBe('');
      expect(field.default).toBeDefined();
      expect(['number', 'boolean', 'string']).toContain(field.type);
    }
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});

describe('Module flags (TEN-F-05)', () => {
  it('has every V1-and-later module, all off', () => {
    expect(Object.values(DEFAULT_MODULE_FLAGS).every((on) => on === false)).toBe(true);
    expect(Object.keys(DEFAULT_MODULE_FLAGS).length).toBe(Object.keys(MODULE_FLAGS).length);
    // The V0 modules are the product; they are deliberately not flags.
    expect(Object.keys(MODULE_FLAGS)).not.toContain('patient');
    expect(Object.keys(MODULE_FLAGS)).not.toContain('billing');
  });

  it('fills in unmentioned flags and ignores ones it no longer knows', () => {
    const flags = resolveModuleFlags({ appointments: true, retiredThing: true, loyalty: 'yes' });
    expect(flags.appointments).toBe(true);
    expect(flags.loyalty).toBe(false);
    expect('retiredThing' in flags).toBe(false);
  });

  it('survives rubbish in the column rather than refusing to start', () => {
    expect(resolveModuleFlags(null)).toEqual(DEFAULT_MODULE_FLAGS);
    expect(resolveModuleFlags('nonsense')).toEqual(DEFAULT_MODULE_FLAGS);
    expect(resolveModuleFlags([1, 2])).toEqual(DEFAULT_MODULE_FLAGS);
  });

  it('labels each flag for a person choosing what to buy', () => {
    for (const { key, label } of describeModuleFlags()) {
      expect(label.length, key).toBeGreaterThan(10);
    }
  });
});
