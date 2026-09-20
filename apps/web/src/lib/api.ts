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
