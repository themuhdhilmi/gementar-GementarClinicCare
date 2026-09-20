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

// ------------------------------------------------ patient registry (PAT, v0-03)

export type IdType = 'MYKAD' | 'MYKID' | 'PASSPORT' | 'ARMY' | 'POLICE' | 'OTHER' | 'NONE';
export type Sex = 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
export type PatientStatus = 'ACTIVE' | 'DECEASED' | 'MERGED' | 'DELETED';
export type AllergyStatus = 'UNVERIFIED' | 'VERIFIED' | 'REFUTED';
export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';

/**
 * The three states of "what do we know about this patient's allergies".
 * `NOT_RECORDED` is the one that matters: nobody has asked, which is not the
 * same as there being none, and every clinical screen shows it in amber.
 */
export type AllergyState = 'NOT_RECORDED' | 'NKDA' | 'SOME' | 'SEVERE';

export type SearchHit = {
  id: string;
  mrn: string;
  name: string;
  idType: IdType;
  idNumberMasked: string | null;
  gender: Sex;
  age: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  lastVisitAt: string | null;
  status: PatientStatus;
  allergyState: AllergyState;
  allergyCount: number;
  matchedOn: 'mrn' | 'id' | 'phone' | 'name';
};

export type PatientRecord = {
  id: string;
  mrn: string;
  name: string;
  idType: IdType;
  idNumber: string | null;
  idNumberMasked: string | null;
  unmasked: boolean;
  passportCountry: string | null;
  dateOfBirth: string | null;
  dobEstimated: boolean;
  age: string | null;
  gender: Sex;
  nationality: string;
  race: string | null;
  religion: string | null;
  maritalStatus: string | null;
  occupation: string | null;
  preferredLanguage: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  phoneAlt: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postcode: string | null;
  city: string | null;
  state: string | null;
  bloodGroup: string | null;
  nkdaRecorded: boolean | null;
  notes: string | null;
  status: PatientStatus;
  mergedIntoId: string | null;
  lastVisitAt: string | null;
  createdAt: string;
};

export type Allergy = {
  id: string;
  type: 'DRUG' | 'FOOD' | 'ENVIRONMENT' | 'OTHER';
  substance: string;
  reaction: string | null;
  severity: AllergySeverity | null;
  status: AllergyStatus;
  recordedAt: string;
  verifiedAt: string | null;
  refutedAt: string | null;
  refutedReason: string | null;
  notes: string | null;
};

export type Condition = {
  id: string;
  condition: string;
  icd10Code: string | null;
  onsetDate: string | null;
  status: 'ACTIVE' | 'RESOLVED';
  resolvedAt: string | null;
  notes: string | null;
};

export type ClinicalSummary = {
  allergies: Allergy[];
  conditions: Condition[];
  nkdaRecorded: boolean | null;
  nkdaRecordedAt: string | null;
  allergyState: AllergyState;
  allergyCount: number;
};

export type PatientContact = {
  id: string;
  name: string;
  relationship: string | null;
  phone: string;
  isPrimary: boolean;
};

export type PatientConsent = {
  id: string;
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  purpose: 'REMINDERS' | 'MARKETING';
  granted: boolean;
  recordedAt: string;
};

export type PatientDocument = {
  id: string;
  type: 'ID_COPY' | 'REFERRAL_IN' | 'LAB_RESULT' | 'CONSENT' | 'PHOTO' | 'OTHER';
  filename: string;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
};

export type DuplicateCandidate = {
  id: string;
  mrn: string;
  name: string;
  idNumberMasked: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  reason: string;
  certain: boolean;
};

export const ID_TYPE_LABEL: Record<IdType, string> = {
  MYKAD: 'MyKad',
  MYKID: 'MyKid',
  PASSPORT: 'Passport',
  ARMY: 'Army',
  POLICE: 'Police',
  OTHER: 'Other',
  NONE: 'No document',
};

export const SEX_LABEL: Record<Sex, string> = {
  MALE: 'M',
  FEMALE: 'F',
  OTHER: 'Other',
  UNKNOWN: '?',
};

/** What the allergy badge says, and how loudly. */
export const ALLERGY_BADGE: Record<AllergyState, { label: string; tone: string }> = {
  SEVERE: { label: 'Severe allergy', tone: 'bg-danger-soft text-danger' },
  SOME: { label: 'Allergies', tone: 'bg-warning-soft text-warning' },
  NKDA: { label: 'No known allergies', tone: 'bg-success-soft text-success' },
  NOT_RECORDED: { label: 'Allergies not recorded', tone: 'bg-warning-soft text-warning' },
};

/** Multipart POST, for uploads that are not a whole-file replacement. */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(new URL(`/api/v1${path}`, window.location.origin), {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(
      payload ?? {
        type: 'about:blank',
        title: 'Upload failed',
        status: response.status,
        detail: 'The file could not be uploaded.',
        code: 'unknown',
        traceId: '',
      },
    );
  }
  return payload as T;
}

// ------------------------------------------- encounters and queue (ENC, v0-04)

export type EncounterStatus =
  | 'REGISTERED'
  | 'TRIAGE_WAITING'
  | 'TRIAGE_IN_PROGRESS'
  | 'DOCTOR_WAITING'
  | 'IN_CONSULTATION'
  | 'PROCEDURE_WAITING'
  | 'PROCEDURE_DONE'
  | 'PHARMACY_WAITING'
  | 'DISPENSING'
  | 'PAYMENT_WAITING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export type EncounterPriority = 'NORMAL' | 'URGENT' | 'EMERGENCY';
export type Station = 'reception' | 'triage' | 'doctor' | 'pharmacy' | 'cashier' | 'procedure';

export type QueueRow = {
  id: string;
  queueNo: string;
  encounterNo: string;
  status: EncounterStatus;
  priority: EncounterPriority;
  priorityReason: string | null;
  patient: { id: string; name: string; age: string | null; gender: string };
  attendingDoctorId: string | null;
  attendingDoctorName: string | null;
  roomName: string | null;
  statusSince: string;
  waitingMinutes: number;
  waitTone: 'normal' | 'amber' | 'red';
  callCount: number;
  skipCount: number;
  calledAt: string | null;
};

export type Encounter = {
  id: string;
  branchId: string;
  patientId: string;
  encounterNo: string;
  queueNo: string;
  type: string;
  status: EncounterStatus;
  priority: EncounterPriority;
  priorityReason: string | null;
  attendingDoctorId: string | null;
  roomId: string | null;
  registeredAt: string;
  statusSince: string;
  callCount: number;
  skipCount: number;
  waitingMinutes: number;
  station: Station | null;
  open: boolean;
  allowedNext: Array<{ to: EncounterStatus; label: string; note: string | null }>;
  followUpDue: string | null;
  followUpNote: string | null;
};

export type EncounterEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  action: string;
  actorName: string;
  note: string | null;
  occurredAt: string;
};

export type EncounterChart = {
  encounter: Encounter;
  timeline: EncounterEvent[];
  completionBlockers: Array<{ reason: string; detail: string }>;
};

export type QueueStats = {
  waiting: number;
  longestWaitMinutes: number;
  seenToday: number;
  averageVisitMinutes: number;
  noShows: number;
};

export type BranchRoom = {
  id: string;
  name: string;
  code: string;
  type: string;
  active: boolean;
};

export type DisplayView = {
  branch: { name: string; code: string };
  nowServing: Array<{ queueNo: string; label: string | null; where: string }>;
  waiting: Array<{ queueNo: string; label: string | null }>;
  recentlyCalled: Array<{ queueNo: string; label: string | null; where: string; at: string }>;
  waitingCount: number;
  at: string;
};

/** What each status is called on a screen a receptionist reads. */
export const STATUS_LABEL: Record<EncounterStatus, string> = {
  REGISTERED: 'Just arrived',
  TRIAGE_WAITING: 'Waiting for triage',
  TRIAGE_IN_PROGRESS: 'In triage',
  DOCTOR_WAITING: 'Waiting for the doctor',
  IN_CONSULTATION: 'With the doctor',
  PROCEDURE_WAITING: 'Waiting for a procedure',
  PROCEDURE_DONE: 'Procedure done',
  PHARMACY_WAITING: 'Waiting for medicine',
  DISPENSING: 'At the pharmacy',
  PAYMENT_WAITING: 'Waiting to pay',
  COMPLETED: 'Finished',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Did not answer',
};

export const STATION_LABEL: Record<Station, string> = {
  reception: 'Reception',
  triage: 'Triage',
  doctor: 'Doctor',
  procedure: 'Procedures',
  pharmacy: 'Pharmacy',
  cashier: 'Payment',
};

export const PRIORITY_TONE: Record<EncounterPriority, string> = {
  EMERGENCY: 'bg-danger-soft text-danger',
  URGENT: 'bg-warning-soft text-warning',
  NORMAL: 'bg-surface-muted text-muted',
};

/** The colour a row turns as somebody waits (ENC-F-22). */
export const WAIT_TONE: Record<'normal' | 'amber' | 'red', string> = {
  normal: 'text-muted',
  amber: 'text-warning font-medium',
  red: 'text-danger font-semibold',
};
