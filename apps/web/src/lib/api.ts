/**
 * One fetch wrapper for the whole app.
 *
 * The API answers errors as RFC 7807 problem documents, so every failure has a
 * stable `code` the UI can branch on — `reauth_required`, `mfa_required`,
 * `password_rejected` — instead of matching on message text.
 */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  traceId: string;
  errors?: unknown;
};

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.problem.code;
  }

  get status(): number {
    return this.problem.status;
  }
}

type Options = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(
      payload ?? {
        type: 'about:blank',
        title: 'Request failed',
        status: response.status,
        detail: 'Something went wrong.',
        code: 'unknown',
        traceId: '',
      },
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------- contracts

export type Branch = {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  roles: Role[];
};

export type Role = 'ADMIN' | 'DOCTOR' | 'NURSE' | 'RECEPTION' | 'DISPENSER' | 'CASHIER';
export type UserStatus = 'INVITED' | 'ACTIVE' | 'DISABLED' | 'LOCKED';

export type Me = {
  user: { id: string; name: string; email: string; lastLoginAt: string | null };
  tenantId: string;
  activeBranchId: string;
  roles: Role[];
  permissions: string[];
  branches: Branch[];
  mfa: { enabled: boolean; required: boolean; verified: boolean; recoveryCodesRemaining: number };
  reauthValidUntil: string | null;
};

export type SessionRow = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  branchId: string;
  current: boolean;
};

export type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  defaultBranchId: string | null;
  roles: Array<{ branchId: string; role: Role }>;
};

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type StaffStatistics = {
  byStatus: Record<UserStatus, number>;
  byBranch: Array<{
    branchId: string;
    code: string;
    name: string;
    people: number;
    roles: Record<Role, number>;
  }>;
};

export type AuditRow = {
  id: string;
  action: string;
  actorName: string;
  actorRole: string | null;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  ip: string | null;
  after: unknown;
  occurredAt: string;
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTION: 'Reception',
  DISPENSER: 'Dispenser',
  CASHIER: 'Cashier',
};

/**
 * What each role is for, shown beside the checkboxes when assigning them. A
 * clinic where one person does all three ticks all three.
 */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: 'Manages staff and settings. Reads clinical records as break-glass, which is recorded.',
  DOCTOR: 'Consults, prescribes, signs and amends clinical records.',
  NURSE: 'Triage and vitals, assists with procedures, reads clinical records.',
  RECEPTION: 'Registers patients and runs the queue.',
  DISPENSER: 'Dispenses medicine and receives stock.',
  CASHIER: 'Issues invoices, takes payment and closes the day.',
};

// ------------------------------------------------------- tenancy (TEN, v0-02)

export type SettingValue = number | boolean | string;

/** One row of the settings form, generated from the schema the API serves. */
export type SettingField = {
  group: 'billing' | 'queue' | 'clinical';
  key: string;
  type: 'number' | 'boolean' | 'string';
  help: string;
  default: SettingValue;
};

/** `null` in a patch means "stop overriding this", never a stored value. */
export type SettingsDocument = Record<string, Record<string, SettingValue | null>>;

export type ModuleDescriptor = { key: string; label: string };

export type TenantOverview = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
    plan: string;
    timezone: string;
    currency: string;
    tin: string | null;
    businessRegNo: string | null;
  };
  settings: SettingsDocument;
  schema: { version: number; fields: SettingField[]; modules: ModuleDescriptor[] };
  modules: Record<string, boolean>;
};

/** `HH:MM` pairs, per weekday. A day the clinic is shut is simply absent. */
export type OperatingHours = Partial<Record<Weekday, Array<[string, string]>>>;

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const WEEKDAYS: Array<{ key: Weekday; label: string }> = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

export type BranchDetail = {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  email: string | null;
  licenceNo: string | null;
  timezone: string | null;
  operatingHours: OperatingHours;
  settings: SettingsDocument;
  letterhead: { headerText: string; footerText: string };
  hasLogo: boolean;
};

/**
 * Turns a settings key into a label. The schema is the source of truth for
 * what exists, so the screen must be able to render a setting nobody has
 * written a label for yet.
 */
const SETTING_LABEL: Record<string, string> = {
  maxDiscountPctFrontdesk: 'Largest discount the front desk may give',
  roundCashTo5Sen: 'Round cash totals to 5 sen',
  numberPrefix: 'Queue number prefix',
  resetDaily: 'Restart queue numbers each day',
  requireDiagnosisToSign: 'Require a diagnosis before signing',
};

export function settingLabel(key: string): string {
  const known = SETTING_LABEL[key];
  if (known) return known;
  const spaced = key.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const SETTINGS_GROUP_LABEL: Record<string, string> = {
  billing: 'Billing',
  queue: 'Queue',
  clinical: 'Clinical',
};

/**
 * Uploads go as multipart, which the JSON wrapper above cannot express, so
 * this is the one other way out of the browser.
 */
export async function upload<T>(path: string, field: string, file: File): Promise<T> {
  const body = new FormData();
  body.append(field, file);
  const response = await fetch(new URL(`/api/v1${path}`, window.location.origin), {
    method: 'PUT',
    credentials: 'same-origin',
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(
      payload ?? {
        type: 'about:blank',
        title: 'Upload failed',
        status: response.status,
        detail: 'The image could not be uploaded.',
        code: 'unknown',
        traceId: '',
      },
    );
  }
  return payload as T;
}
