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

// ---------------------------------------------------- triage (TRI, v0-05)

export type FlagLevel = 'NONE' | 'ABNORMAL' | 'CRITICAL';

export type VitalFlag = {
  param: string;
  level: 'ABNORMAL' | 'CRITICAL';
  value: number;
  threshold: string;
  label: string;
};

export type TriageRecord = {
  id: string;
  encounterId: string;
  patientId: string;
  sequence: number;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respRate: number | null;
  temperature: number | null;
  spo2: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  glucose: number | null;
  glucoseFasting: boolean | null;
  painScore: number | null;
  complaint: string | null;
  notes: string | null;
  flags: VitalFlag[];
  maxFlagLevel: FlagLevel;
  recordedAt: string;
  locked: boolean;
};

/** One reading's bands, in the units the form uses. */
export type Band = {
  low?: number;
  high?: number;
  criticalLow?: number;
  criticalHigh?: number;
};

export type TriageForm = {
  records: TriageRecord[];
  prefill: { heightCm: number | null; lastReading: TriageRecord | null };
  allergyPromptNeeded: boolean;
  thresholds: Record<string, Band | undefined>;
  isChild: boolean;
};

/**
 * The fields a nurse fills in, in the order they take them.
 *
 * `stored` is the key the thresholds come back under, which is in the
 * stored unit; `scale` converts what is typed into it so the screen can
 * colour a value with the same numbers the server will use.
 */
export const VITAL_FIELDS = [
  { key: 'systolic', stored: 'systolic', label: 'Systolic', unit: 'mmHg', scale: 1, step: 1 },
  { key: 'diastolic', stored: 'diastolic', label: 'Diastolic', unit: 'mmHg', scale: 1, step: 1 },
  { key: 'heartRate', stored: 'heartRate', label: 'Pulse', unit: 'bpm', scale: 1, step: 1 },
  { key: 'temperature', stored: 'temperatureDc', label: 'Temperature', unit: '°C', scale: 10, step: 0.1 },
  { key: 'spo2', stored: 'spo2', label: 'Oxygen saturation', unit: '%', scale: 1, step: 1 },
  { key: 'respRate', stored: 'respRate', label: 'Breathing rate', unit: '/min', scale: 1, step: 1 },
  { key: 'weightKg', stored: 'weightG', label: 'Weight', unit: 'kg', scale: 1000, step: 0.1 },
  { key: 'heightCm', stored: 'heightMm', label: 'Height', unit: 'cm', scale: 10, step: 0.1 },
  { key: 'glucose', stored: 'glucoseX10', label: 'Blood glucose', unit: 'mmol/L', scale: 10, step: 0.1 },
  { key: 'painScore', stored: 'painScore', label: 'Pain', unit: 'of 10', scale: 1, step: 1 },
] as const;

export type VitalFieldKey = (typeof VITAL_FIELDS)[number]['key'];

/**
 * Colours a value as it is typed, against the same bands the server holds.
 *
 * Advisory, exactly like the server's: it never prevents saving. A nurse
 * who cannot record what they measured will write it on paper instead.
 */
export function levelFor(
  value: number | null,
  band: Band | undefined,
  scale: number,
): 'NONE' | 'ABNORMAL' | 'CRITICAL' {
  if (value === null || !band) return 'NONE';
  const stored = Math.round(value * scale);
  if (band.criticalLow !== undefined && stored < band.criticalLow) return 'CRITICAL';
  if (band.criticalHigh !== undefined && stored > band.criticalHigh) return 'CRITICAL';
  if (band.low !== undefined && stored < band.low) return 'ABNORMAL';
  if (band.high !== undefined && stored > band.high) return 'ABNORMAL';
  return 'NONE';
}

export const FLAG_TONE: Record<'NONE' | 'ABNORMAL' | 'CRITICAL', string> = {
  NONE: '',
  ABNORMAL: 'border-warning text-warning',
  CRITICAL: 'border-danger text-danger',
};

// ---------------------------------------------- consultation (CON, v0-06)

export type ConsultationStatus = 'DRAFT' | 'SIGNED' | 'CANCELLED';
export type DiagnosisRank = 'PRIMARY' | 'SECONDARY';
export type DiagnosisCertainty = 'PROVISIONAL' | 'CONFIRMED';
export type AmendmentType = 'ADDENDUM' | 'CORRECTION';

/** The sections a doctor writes, and the only fields a correction can name. */
export const CLINICAL_SECTIONS = [
  { key: 'chiefComplaint', label: 'What brought them in', soap: 'S', rows: 2 },
  { key: 'hpi', label: 'History of the present illness', soap: 'S', rows: 5 },
  { key: 'history', label: 'Relevant history', soap: 'S', rows: 4 },
  { key: 'examination', label: 'Examination', soap: 'O', rows: 5 },
  { key: 'planText', label: 'Plan', soap: 'P', rows: 4 },
] as const;

export type ClinicalSection = (typeof CLINICAL_SECTIONS)[number]['key'];

export type Consultation = {
  id: string;
  encounterId: string;
  patientId: string;
  branchId: string;
  doctorId: string;
  sequence: number;
  status: ConsultationStatus;
  chiefComplaint: string | null;
  hpi: string | null;
  history: string | null;
  examination: string | null;
  planText: string | null;
  templateId: string | null;
  copiedFromId: string | null;
  followUpDue: string | null;
  followUpNote: string | null;
  startedAt: string;
  lastAutosaveAt: string | null;
  signedAt: string | null;
  signedBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  contentHash: string | null;
  editable: boolean;
  routedTo?: string;
};

export type Diagnosis = {
  id: string;
  rank: DiagnosisRank;
  description: string;
  icd10Code: string | null;
  icd10Label: string | null;
  certainty: DiagnosisCertainty;
  isChronic: boolean;
};

export type ConsultationAmendment = {
  id: string;
  type: AmendmentType;
  field: string | null;
  previous: Record<string, string | null> | null;
  current: { text: string };
  reason: string;
  amendedBy: string;
  amendedAt: string;
};

export type ConsultationView = {
  consultation: Consultation;
  diagnoses: Diagnosis[];
  amendments: ConsultationAmendment[];
};

export type ConsultationSummary = {
  id: string;
  signedAt: string | null;
  doctorId: string;
  chiefComplaint: string | null;
  planSummary: string | null;
  primaryDiagnosis: string | null;
  icd10Code: string | null;
};

export type ClinicalTemplate = {
  id: string;
  scope: 'TENANT' | 'USER';
  ownerId: string | null;
  name: string;
  keywords: string[];
  content: Partial<Record<ClinicalSection, string>> & {
    diagnoses?: Array<{ description: string; icd10Code?: string | null }>;
  };
  active: boolean;
};

export type DraftSummary = {
  id: string;
  encounterId: string;
  patientId: string;
  startedAt: string;
  lastAutosaveAt: string | null;
  chiefComplaint: string | null;
  patient: { name: string; mrn: string };
  hoursOpen: number;
  stale: boolean;
};

export type QuickPhrase = { id: string; trigger: string; expansion: string };

/**
 * Expands `.nad` into what it stands for, as the doctor types.
 *
 * Only on a word boundary and only for a trigger that is complete, so that
 * typing a sentence containing a full stop does not detonate at random.
 */
export function expandPhrases(text: string, phrases: QuickPhrase[]): string {
  if (phrases.length === 0) return text;
  let out = text;
  for (const phrase of phrases) {
    const escaped = phrase.trigger.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replaceAll(new RegExp(`${escaped}(?=\\s|$)`, 'g'), phrase.expansion);
  }
  return out;
}

// ---------------------------------------------- prescription (RX, v0-07)

export type PrescriptionStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export type PrescriptionItemStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PARTIAL'
  | 'DISPENSED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'SUPERSEDED';

export type AllergyMatchLevel = 'EXACT' | 'CLASS' | 'UNLINKED';

export type RxWarning =
  | {
      type: 'ALLERGY';
      level: AllergyMatchLevel;
      severity: 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING' | null;
      status: 'UNVERIFIED' | 'VERIFIED' | 'REFUTED';
      allergyId: string;
      substance: string;
      reaction: string | null;
      message: string;
    }
  | {
      type: 'DUPLICATE';
      itemId: string;
      genericName: string;
      prescribedAt: string;
      doctorName: string | null;
      branchName: string | null;
      sameVisit: boolean;
      message: string;
    }
  | { type: 'NO_ALLERGY_RECORD'; message: string }
  | { type: 'MAX_DOSE'; dailyDose: number; maxDailyDose: number; unit: string; message: string }
  | { type: 'OUT_OF_STOCK'; onHand: number; message: string };

export type PrescriptionItem = {
  id: string;
  version: number;
  supersedesId: string | null;
  isCurrent: boolean;
  productId: string | null;
  externalName: string | null;
  genericName: string;
  drugClass: string | null;
  strength: string | null;
  displayName: string;
  doseValue: number;
  doseUnit: string;
  route: string;
  frequencyCode: string;
  frequencyPerDay: number | null;
  isPrn: boolean;
  prnIndication: string | null;
  durationDays: number | null;
  untilFinished: boolean;
  quantity: number;
  quantityUnit: string;
  quantityAuto: boolean;
  instructions: string | null;
  labelText: string;
  isExternal: boolean;
  isControlled: boolean;
  status: PrescriptionItemStatus;
  warnings: RxWarning[];
  overrideReason: string | null;
  overriddenAt: string | null;
  cancelledReason: string | null;
  createdAt: string;
};

export type Prescription = {
  id: string;
  status: PrescriptionStatus;
  language: string;
  notesToDispenser: string | null;
  signedAt: string | null;
  completedAt: string | null;
  consultationId: string;
  encounterId: string;
  patientId: string;
};

export type PrescriptionView = {
  prescription: Prescription | null;
  items: PrescriptionItem[];
  patient: {
    id: string;
    nkdaRecorded: boolean | null;
    allergies: Array<{ id: string; substance: string; severity: string | null }>;
    allergiesUnknown: boolean;
  };
};

export type PrescriptionItemInput = {
  productId?: string;
  externalName?: string;
  doseValue: number;
  doseUnit: string;
  route: string;
  frequencyCode: string;
  frequencyPerDay?: number;
  isPrn?: boolean;
  prnIndication?: string;
  durationDays?: number;
  untilFinished?: boolean;
  quantity?: number;
  instructions?: string;
};

export type RxOptions = {
  doseUnits: string[];
  routes: string[];
  frequencies: Array<{ code: string; perDay: number | null; ms: string; en: string }>;
};

export type RxFavourite = {
  id: string;
  productId: string;
  uses: number;
  lastUsedAt: string;
  defaults: Partial<PrescriptionItemInput> | null;
  product: {
    id: string;
    name: string;
    genericName: string | null;
    strengthText: string | null;
    dispenseUnit: string;
    defaultDose: number | null;
    defaultDoseUnit: string | null;
    defaultRoute: string | null;
    defaultFrequency: string | null;
    isControlled: boolean;
  };
};

/**
 * How loud a warning is on screen.
 *
 * Red is reserved for the two cases that could hurt somebody. Everything
 * else is amber, because a screen where everything is red is a screen
 * where nothing is.
 */
export function warningTone(warning: RxWarning): 'danger' | 'warning' | 'info' {
  if (warning.type === 'ALLERGY') {
    if (warning.level === 'UNLINKED') return 'warning';
    return warning.level === 'EXACT' ? 'danger' : 'warning';
  }
  if (warning.type === 'NO_ALLERGY_RECORD') return 'warning';
  // RX-F-04: the shelf is a logistics problem, not a safety one.
  if (warning.type === 'OUT_OF_STOCK') return 'warning';
  return 'info';
}

/** RX-R-04: the one that needs a second, explicit yes at signing. */
export function needsSignConfirmation(item: PrescriptionItem): boolean {
  return item.warnings.some(
    (w) =>
      w.type === 'ALLERGY' &&
      w.level === 'EXACT' &&
      (w.severity === 'SEVERE' || w.severity === 'LIFE_THREATENING'),
  );
}

/** Whether the item cannot be signed until a reason has been given. */
export function needsOverride(item: PrescriptionItem): boolean {
  return item.warnings.some((w) => w.type === 'ALLERGY' && w.level !== 'UNLINKED');
}

// ------------------------------------- product catalogue (INV, v0-09 §1)

export type ProductType = 'MEDICINE' | 'CONSUMABLE' | 'SUPPLY' | 'SERVICE_ITEM';

export type Product = {
  id: string;
  sku: string;
  name: string;
  type: ProductType;
  brand: string | null;
  genericName: string | null;
  drugClass: string | null;
  form: string | null;
  strengthText: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  dispenseUnit: string;
  packSize: number;
  isControlled: boolean;
  maxDailyDose: number | null;
  maxDailyDoseUnit: string | null;
  defaultDose: number | null;
  defaultDoseUnit: string | null;
  defaultRoute: string | null;
  defaultFrequency: string | null;
  sellingPrice: number;
  status: 'ACTIVE' | 'INACTIVE';
  /** Name, strength and form together — what a prescription line calls it. */
  label: string;
  /** On hand at the caller's branch. Null when stock is not known at all. */
  onHand?: number | null;
  nearestExpiry?: string | null;
};

// ------------------------------------------------ stock (INV, v0-09 §2)

export type BatchStatus = 'ACTIVE' | 'DEPLETED' | 'EXPIRED' | 'BLOCKED';

export type ProductBatch = {
  id: string;
  productId: string;
  branchId: string;
  batchNo: string;
  expiryDate: string | null;
  costPrice: string;
  sellingPrice: string | null;
  quantityOnHand: number;
  quantityQuarantined: number;
  status: BatchStatus;
  receivedAt: string;
  barcode: string | null;
};

export type StockRow = {
  product: {
    id: string;
    sku: string;
    name: string;
    genericName: string | null;
    strengthText: string | null;
    dispenseUnit: string;
    isColdChain: boolean;
    isControlled: boolean;
  };
  onHand: number;
  minStock: number | null;
  reorderLevel: number | null;
  belowMin: boolean;
  belowReorder: boolean;
  nearestExpiry: string | null;
  batches: ProductBatch[];
};

export type StockMovementRow = {
  id: string;
  type: string;
  label: string;
  quantity: number;
  balanceAfter: number;
  unitCost: string;
  referenceType: string | null;
  referenceId: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  performedByName: string | null;
  occurredAt: string;
  batch: { id: string; batchNo: string; expiryDate: string | null } | null;
  product: { id: string; name: string; dispenseUnit: string } | null;
};

export type StockOptions = {
  reasonCodes: string[];
  movementTypes: Array<{ type: string; label: string }>;
};

/**
 * How near a batch is to being a problem.
 *
 * Deliberately blunt: expired or blocked is red, within ninety days is
 * amber, everything else is not worth colouring. A shelf view where half
 * the rows are tinted tells nobody anything.
 */
export function expiryTone(
  expiry: string | null,
  status?: BatchStatus,
): 'danger' | 'warning' | null {
  if (status === 'BLOCKED' || status === 'EXPIRED') return 'danger';
  if (!expiry) return null;
  const days = (new Date(expiry).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return 'danger';
  if (days <= 90) return 'warning';
  return null;
}

// ------------------------------------------- procedures (PRC, v0-10)

export type ProcedureCategory =
  | 'INJECTION'
  | 'NEBULISER'
  | 'DRESSING'
  | 'MINOR_SURGERY'
  | 'VACCINATION'
  | 'SCREENING'
  | 'OTHER';

export const PROCEDURE_CATEGORY_LABEL: Record<ProcedureCategory, string> = {
  INJECTION: 'Injection',
  NEBULISER: 'Nebuliser',
  DRESSING: 'Dressing',
  MINOR_SURGERY: 'Minor surgery',
  VACCINATION: 'Vaccination',
  SCREENING: 'Screening',
  OTHER: 'Other',
};

export type ProcedureStatus = 'ORDERED' | 'PERFORMED' | 'CANCELLED' | 'VOIDED';
export type Laterality = 'LEFT' | 'RIGHT' | 'BILATERAL' | 'NA';

export type ProcedureCatalogItem = {
  id: string;
  code: string;
  name: string;
  category: ProcedureCategory;
  price: string;
  priceSen: number;
  requiresConsent: boolean;
  requiresDoctor: boolean;
  vaccineProductId: string | null;
  defaultDurationMin: number | null;
  protocol: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  consumables: Array<{
    id: string;
    productId: string;
    quantity: number;
    optional: boolean;
    product: { id: string; name: string; dispenseUnit: string; isBatched: boolean } | null;
  }>;
};

export type EncounterProcedure = {
  id: string;
  encounterId: string;
  patientId: string;
  procedureId: string;
  name: string;
  price: string;
  category: ProcedureCategory;
  requiresConsent: boolean;
  requiresDoctor: boolean;
  vaccineProductId: string | null;
  protocol: string | null;
  status: ProcedureStatus;
  orderedAt: string;
  nurseInitiated: boolean;
  performedBy: string | null;
  performedAt: string | null;
  site: string | null;
  laterality: Laterality | null;
  consentGiven: boolean | null;
  consentBy: string | null;
  notes: string | null;
  complications: string | null;
  cancelReason: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  planned: Array<{
    productId: string;
    quantity: number;
    optional: boolean;
    product: { id: string; name: string; dispenseUnit: string; isBatched: boolean; isColdChain: boolean } | null;
    onHand: number;
  }>;
  used: Array<{
    id: string;
    productId: string;
    batchId: string;
    quantity: number;
    reversed: boolean;
    product: { id: string; name: string; dispenseUnit: string } | null;
  }>;
};

export type ProcedureQueueRow = {
  encounterId: string;
  queueNo: string | null;
  patient: { id: string; name: string; mrn: string; dateOfBirth: string } | null;
  items: Array<{
    id: string;
    name: string;
    category: ProcedureCategory;
    requiresConsent: boolean;
    requiresDoctor: boolean;
    orderedAt: string;
    nurseInitiated: boolean;
  }>;
};

export type VaccinationRow = {
  id: string;
  vaccineName: string;
  batchNo: string;
  expiry: string | null;
  doseNumber: number | null;
  site: string | null;
  givenAt: string;
  givenByName: string | null;
  withdrawn: boolean;
  withdrawnReason: string | null;
};

/** Which procedures have to say where on the body (PRC §12). */
export function siteRequired(category: ProcedureCategory): boolean {
  return category === 'INJECTION' || category === 'VACCINATION' || category === 'DRESSING';
}

// ---------------------------------------------- dispensing (DSP, v0-08)

export type DispenseStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';

export type DispenseOutcome =
  | 'DISPENSED'
  | 'PARTIAL'
  | 'EXTERNAL'
  | 'DECLINED'
  | 'SUBSTITUTED_OUT';

export type PharmacyQueueRow = {
  encounterId: string;
  prescriptionId: string;
  dispenseId: string | null;
  queueNo: string | null;
  status: string;
  patient: { id: string; name: string; mrn: string; dateOfBirth: string } | null;
  items: number;
  hasControlled: boolean;
  amended: boolean;
  waitingMinutes: number;
};

export type BatchPick = {
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  quantity: number;
  available: number;
};

export type DispensedRecord = {
  id: string;
  quantity: number;
  outcome: DispenseOutcome;
  outcomeReason: string | null;
  packRounded: boolean;
  lineTotal: string;
  labelPrints: number;
  dispensedAt: string;
  canUndo: boolean;
  batches: Array<{
    batchId: string;
    quantity: number;
    wasSuggested: boolean;
    overrideReason: string | null;
  }>;
};

export type DispenseSessionItem = {
  prescriptionItemId: string;
  version: number;
  displayName: string;
  genericName: string;
  strength: string | null;
  productId: string | null;
  externalName: string | null;
  isExternal: boolean;
  isControlled: boolean;
  prescribedQuantity: number;
  quantityUnit: string;
  labelText: string;
  status: string;
  amendedSinceOpen: boolean;
  newSinceOpen: boolean;
  dispensed: DispensedRecord | null;
  suggestion: BatchPick[];
  shortfall: number;
  unitPrice: string | null;
};

export type DispenseSession = {
  id: string;
  status: DispenseStatus;
  encounterId: string;
  prescriptionId: string;
  branchId: string;
  openedAt: string;
  completedAt: string | null;
  counselled: boolean | null;
  notes: string | null;
  patient: { id: string; name: string; mrn: string; dateOfBirth: string } | null;
  allergies: Array<{
    id: string;
    substance: string;
    severity: string | null;
    status: string;
    reaction: string | null;
  }>;
  language: string;
  notesToDispenser: string | null;
  items: DispenseSessionItem[];
};

export type DispenseLabel = {
  clinic: string;
  branch: string;
  phone: string | null;
  patientName: string;
  patientMrn: string;
  dispensedAt: string;
  product: string;
  strength: string | null;
  quantity: number;
  quantityUnit: string;
  instructions: string;
  batches: Array<{ batchNo: string; expiry: string | null }>;
  warnings: string[];
  printCount: number;
};

export type ControlledRegisterRow = {
  id: string;
  occurredAt: string;
  entryType: string;
  product: { id: string; name: string; strengthText: string | null; dispenseUnit: string } | null;
  patientName: string | null;
  patientIc: string | null;
  prescriberName: string | null;
  batchNo: string | null;
  quantityIn: number;
  quantityOut: number;
  balanceAfter: number;
  performedByName: string | null;
  witnessName: string | null;
};

/**
 * A key that survives a retry but not a second, deliberate dispense.
 *
 * Generated when the button is armed rather than when it is pressed, so
 * a double click or a dropped response replays instead of handing over
 * twice (DSP-F-11).
 */
export function idempotencyKey(): string {
  return `dsp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ------------------------------------------------- billing (BIL, v0-11)

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIAL' | 'PAID' | 'VOID';
export type InvoiceKind = 'ENCOUNTER' | 'STANDALONE';
export type InvoiceLineType =
  | 'CONSULTATION'
  | 'MEDICINE'
  | 'PROCEDURE'
  | 'DOCUMENT'
  | 'ITEM'
  | 'MANUAL';

export const LINE_TYPE_LABEL: Record<InvoiceLineType, string> = {
  CONSULTATION: 'Consultation',
  MEDICINE: 'Medicine',
  PROCEDURE: 'Procedure',
  DOCUMENT: 'Document',
  ITEM: 'Item',
  MANUAL: 'Added',
};

export type InvoiceLine = {
  id: string;
  lineNo: number;
  lineType: InvoiceLineType;
  sourceType: string | null;
  sourceId: string | null;
  description: string;
  quantity: number;
  quantityUnit: string | null;
  unitPrice: string;
  gross: string;
  grossSen: number;
  discountPct: number | null;
  discountAmount: string;
  discountAmountSen: number;
  discountSource: string | null;
  discountReason: string | null;
  taxCode: string;
  taxAmount: string;
  lineTotal: string;
  lineTotalSen: number;
  feeRule: string | null;
  isAuto: boolean;
};

export type Invoice = {
  id: string;
  invoiceNo: string | null;
  status: InvoiceStatus;
  kind: InvoiceKind;
  branchId: string;
  encounterId: string | null;
  patientId: string | null;
  walkupName: string | null;
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE';
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  roundingAdjustment: string;
  grandTotal: string;
  amountPaid: string;
  balance: string;
  subtotalSen: number;
  grandTotalSen: number;
  invoiceDiscountPct: number | null;
  invoiceDiscountReason: string | null;
  invoiceDiscountSource: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  reissuedFromId: string | null;
  reissuedAsId: string | null;
  patientNameSnapshot: string | null;
};

export type InvoiceView = { invoice: Invoice | null; lines: InvoiceLine[] };

export type BillableItemRow = {
  id: string;
  code: string;
  name: string;
  defaultPrice: string;
  taxCode: string;
  category: string | null;
  status: 'ACTIVE' | 'INACTIVE';
};

export type InvoiceSummary = {
  id: string;
  invoiceNo: string | null;
  status: InvoiceStatus;
  kind: InvoiceKind;
  patient: { id: string; name: string; mrn: string } | null;
  walkupName: string | null;
  grandTotal: string;
  amountPaid: string;
  balance: string;
  issuedAt: string | null;
  encounterId: string | null;
};

/** What a cashier's row should look like at a glance. */
export function invoiceTone(status: InvoiceStatus): 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'VOID':
      return 'danger';
    case 'DRAFT':
      return 'info';
    default:
      return 'warning';
  }
}

// ------------------------------ counts, alerts and reordering (INV §2)

export type StockCountType = 'OPENING' | 'FULL' | 'CYCLE' | 'ADHOC';
export type StockCountStatus = 'OPEN' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED';
export type StockAlertKind =
  | 'LOW'
  | 'CRITICAL'
  | 'EXPIRING_90'
  | 'EXPIRING_60'
  | 'EXPIRING_30'
  | 'EXPIRED';

export const ALERT_LABEL: Record<StockAlertKind, string> = {
  CRITICAL: 'Below the minimum',
  LOW: 'Running low',
  EXPIRED: 'Expired stock on the shelf',
  EXPIRING_30: 'Expires within a month',
  EXPIRING_60: 'Expires within two months',
  EXPIRING_90: 'Expires within three months',
};

/** Red is for stock that is gone or unusable; amber for what is coming. */
export function alertTone(kind: StockAlertKind): 'danger' | 'warning' {
  return kind === 'EXPIRED' || kind === 'CRITICAL' ? 'danger' : 'warning';
}

export type StockAlertRow = {
  kind: StockAlertKind;
  productId: string;
  product: { id: string; sku: string; name: string; dispenseUnit: string } | null;
  observed: number | null;
  firstSeen: string;
  lastSeen: string;
  acknowledgedAt: string | null;
};

export type StockCountSummary = {
  lines: number;
  agreed: number;
  over: number;
  under: number;
  netUnits: number;
};

export type StockCountLine = {
  id: string;
  batchId: string | null;
  productId: string;
  product: { id: string; sku: string; name: string; strengthText: string | null; dispenseUnit: string } | null;
  batch: { id: string; batchNo: string; expiryDate: string | null; status: string } | null;
  newBatchNo: string | null;
  newExpiry: string | null;
  newCost: string | null;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  note: string | null;
  countedAt: string | null;
};

export type StockCountView = {
  count: {
    id: string;
    branchId: string;
    type: StockCountType;
    status: StockCountStatus;
    blind: boolean;
    frozenAt: string | null;
    submittedAt: string | null;
    approvedAt: string | null;
    notes: string | null;
  };
  lines: StockCountLine[];
  summary: StockCountSummary | null;
};

export type StockCountRow = {
  id: string;
  type: StockCountType;
  status: StockCountStatus;
  blind: boolean;
  frozenAt: string | null;
  approvedAt: string | null;
  notes: string | null;
};

export type ReorderRow = {
  product: {
    id: string;
    sku: string;
    name: string;
    strengthText: string | null;
    dispenseUnit: string;
  };
  onHand: number;
  usedInWindow: number;
  perDay: number;
  /** Null when nothing has moved — which is not the same as "forever". */
  daysOfCover: number | null;
  reorderLevel: number | null;
  suggestedQty: number | null;
  belowReorder: boolean;
};

export type QuarantineRow = ProductBatch & {
  product: { id: string; sku: string; name: string; dispenseUnit: string } | null;
};
