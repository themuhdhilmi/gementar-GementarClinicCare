import { z } from 'zod';

/**
 * Tenant and branch settings (TEN-F-04, TEN-F-09).
 *
 * One schema, three layers: a branch setting wins over a tenant setting, which
 * wins over the default here. Only differences are stored, so a changed
 * default reaches every clinic that never expressed an opinion.
 *
 * **Adding a setting.** Put it in the group that owns it, give it a default
 * that is right for a small Malaysian practice, and describe it for whoever
 * runs the clinic rather than for whoever wrote the module — the description
 * is the inline help on the settings screen.
 *
 * Unknown keys are rejected rather than ignored (§12). A mistyped setting is a
 * setting that silently does nothing, which is worse than an error.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

const billing = z
  .object({
    maxDiscountPctFrontdesk: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(10)
      .describe('Largest discount the front desk may give without an administrator, in percent.'),
    roundCashTo5Sen: z
      .boolean()
      .default(true)
      .describe('Round cash totals to the nearest 5 sen, as Malaysian coinage requires.'),
  })
  .strict();

const queue = z
  .object({
    numberPrefix: z
      .string()
      .regex(/^[A-Z]{0,4}$/, 'Up to four capital letters, or empty.')
      .default('')
      .describe('Letters in front of the queue number, for example "A" giving A001.'),
    resetDaily: z
      .boolean()
      .default(true)
      .describe('Start queue numbers again at 1 each morning.'),
    triageRequired: z
      .enum(['ALWAYS', 'OPTIONAL', 'NEVER'])
      .default('OPTIONAL')
      .describe(
        'Whether every patient is triaged before seeing the doctor. "Optional" lets the front desk decide per patient.',
      ),
    paymentBeforeDispense: z
      .boolean()
      .default(false)
      .describe('Patients pay first and collect medicine afterwards, rather than the other way round.'),
    requireDispenseBeforeComplete: z
      .boolean()
      .default(true)
      .describe('A visit cannot be finished while prescribed medicine has not been handed over.'),
    requirePaymentBeforeComplete: z
      .boolean()
      .default(true)
      .describe('A visit cannot be finished while there is still something to pay.'),
    displayShowFirstName: z
      .boolean()
      .default(true)
      .describe(
        'Show a first name beside the queue number on the waiting-room screen. Turn off for number only.',
      ),
    waitAmberMinutes: z
      .number()
      .int()
      .min(5)
      .max(240)
      .default(30)
      .describe('How long someone waits at one station before the board turns their row amber.'),
    waitRedMinutes: z
      .number()
      .int()
      .min(5)
      .max(480)
      .default(60)
      .describe('And red. Should be longer than the amber threshold.'),
    noShowAfterCalls: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe('How many times a patient is called before the front desk is asked to mark them absent.'),
  })
  .strict();

const clinical = z
  .object({
    requireDiagnosisToSign: z
      .boolean()
      .default(false)
      .describe('Refuse to sign a consultation that has no diagnosis recorded.'),
  })
  .strict();

const patient = z
  .object({
    mrnPrefix: z
      .string()
      .regex(/^[A-Z]{0,6}$/, 'Up to six capital letters, or empty.')
      .default('P')
      .describe('Letters in front of the patient number, for example "GC" giving GC-000123.'),
    mrnDigits: z
      .number()
      .int()
      .min(4)
      .max(10)
      .default(6)
      .describe('How many digits the patient number is padded to. Six allows a million patients.'),
  })
  .strict();

const GROUPS = { billing, queue, clinical, patient } as const;

/**
 * Settings that must not differ between branches.
 *
 * A patient belongs to the clinic company rather than to a building
 * (PAT-R-08), so their number cannot depend on where they happened to walk
 * in. `SettingsService.clinicWide` resolves these without the branch layer.
 */
export const TENANT_ONLY_GROUPS: ReadonlySet<keyof typeof GROUPS> = new Set(['patient']);

export const tenantSettingsSchema = z.object(GROUPS).strict();
export type TenantSettings = { [K in keyof typeof GROUPS]: z.infer<(typeof GROUPS)[K]> };

/**
 * A patch may name any subset of the schema, at either level.
 *
 * The defaults have to be stripped out to build it, not merely made optional.
 * `.partial()` leaves each field a `ZodDefault`, which fills itself in when
 * the key is absent — so patching one billing setting would write down today's
 * value for every *other* billing setting too. The clinic would then be frozen
 * on those values, and a later change to a default would never reach them.
 * Only what was actually asked for is stored.
 *
 * `null` means "stop overriding this", which is different from every value the
 * setting can take. A branch that stops overriding the discount goes back to
 * following the clinic, including any later change to it — which is not the
 * same as writing down the clinic's value as it stands today.
 */
export function patchGroup<T extends z.ZodObject<z.ZodRawShape>>(
  group: T,
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(group.shape)) {
    shape[key] = (field as z.ZodDefault<z.ZodTypeAny>).def.innerType.nullable().optional();
  }
  return z.object(shape).strict();
}

export const settingsPatchSchema = z
  .object({
    billing: patchGroup(billing).optional(),
    queue: patchGroup(queue).optional(),
    clinical: patchGroup(clinical).optional(),
    patient: patchGroup(patient).optional(),
  })
  .strict();

export type SettingsPatch = {
  [K in keyof typeof GROUPS]?: {
    [F in keyof z.infer<(typeof GROUPS)[K]>]?: z.infer<(typeof GROUPS)[K]>[F] | null;
  };
};

export const DEFAULT_SETTINGS: TenantSettings = {
  billing: billing.parse({}),
  queue: queue.parse({}),
  clinical: clinical.parse({}),
  patient: patient.parse({}),
};

type Layer = Record<string, unknown> | null | undefined;

/**
 * TEN-F-09: branch over tenant over default, one group at a time, so a branch
 * that overrides one billing setting keeps the tenant's other ones.
 */
export function resolveSettings(tenant: Layer, branch: Layer): TenantSettings {
  const merged: Record<string, unknown> = {};
  for (const group of Object.keys(GROUPS)) {
    merged[group] = {
      ...(DEFAULT_SETTINGS as Record<string, Record<string, unknown>>)[group],
      ...(tenant?.[group] as Record<string, unknown> | undefined),
      ...(branch?.[group] as Record<string, unknown> | undefined),
    };
  }
  return tenantSettingsSchema.parse(merged) as TenantSettings;
}

/**
 * Applies a patch to a stored layer, group by group.
 *
 * A `null` removes the key rather than storing it, and a group left with
 * nothing in it is removed too — so a layer that overrides nothing is `{}`
 * rather than a shell of empty groups.
 */
export function applyPatch(stored: Layer, patch: SettingsPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const [group, values] of Object.entries(patch)) {
    if (values === undefined) continue;
    const merged: Record<string, unknown> = { ...(next[group] as Record<string, unknown>) };
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    if (Object.keys(merged).length === 0) delete next[group];
    else next[group] = merged;
  }
  return next;
}

/**
 * Turns a validation failure into the key a person can act on, such as
 * `billing.nonsense` (TEN-T-10). Zod reports an unknown key against the group
 * it was found in, so the two halves have to be put back together.
 */
export function explainSettingsIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys: string[] }).keys.join(', ');
      return `${path ? `${path}.` : ''}${keys} is not a setting`;
    }
    return `${path}: ${issue.message}`;
  });
}

/** The schema as data, so a settings screen can build itself. */
export type SettingDescriptor = {
  group: string;
  key: string;
  type: 'number' | 'boolean' | 'string';
  help: string;
  default: unknown;
};

export function describeSettings(): SettingDescriptor[] {
  const out: SettingDescriptor[] = [];
  for (const [group, schema] of Object.entries(GROUPS)) {
    for (const [key, field] of Object.entries(schema.shape)) {
      const withDefault = field as z.ZodDefault<z.ZodTypeAny>;
      const kind = withDefault.def.innerType.def.type;
      out.push({
        group,
        key,
        type: kind === 'number' ? 'number' : kind === 'boolean' ? 'boolean' : 'string',
        help: (field as { description?: string }).description ?? '',
        default: (DEFAULT_SETTINGS as Record<string, Record<string, unknown>>)[group]?.[key],
      });
    }
  }
  return out;
}
