import type { AdminRole } from './types';

// Who may do what in the problem-report inbox, and the closed code lists the
// inbox shares with the report tables. The Reports actions have their own
// route and vocabulary; the case console's policy is separate and unchanged.

export const REPORT_ACTION_IDS = [
  'reveal_contact',
  'view_screenshot',
  'set_status',
  'set_note',
  'update_settings',
] as const;
export type ReportActionId = (typeof REPORT_ACTION_IDS)[number];

export const REPORT_CAPABILITIES = [
  'view_list',
  'view_detail',
  'view_settings',
  ...REPORT_ACTION_IDS,
] as const;
export type ReportCapability = (typeof REPORT_CAPABILITIES)[number];

const EVERY_ROLE: readonly AdminRole[] = ['admin_readonly', 'admin_ops', 'admin_superadmin'];
// The roles that may change reports. Contact reveals and screenshot links are
// limited to them as well.
const MUTATING_ROLES: readonly AdminRole[] = ['admin_ops', 'admin_superadmin'];
const SUPERADMIN_ONLY: readonly AdminRole[] = ['admin_superadmin'];

const CAPABILITY_ROLES: Readonly<Record<ReportCapability, readonly AdminRole[]>> = {
  view_list: EVERY_ROLE,
  view_detail: EVERY_ROLE,
  view_settings: SUPERADMIN_ONLY,
  reveal_contact: MUTATING_ROLES,
  view_screenshot: MUTATING_ROLES,
  set_status: MUTATING_ROLES,
  set_note: MUTATING_ROLES,
  update_settings: SUPERADMIN_ONLY,
};

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function canReport(role: AdminRole, capability: ReportCapability): boolean {
  return isOneOf(REPORT_CAPABILITIES, capability) && CAPABILITY_ROLES[capability].includes(role);
}

export function reportCapabilities(role: AdminRole): ReportCapability[] {
  return REPORT_CAPABILITIES.filter((capability) => canReport(role, capability));
}

export function isReportActionId(value: unknown): value is ReportActionId {
  return isOneOf(REPORT_ACTION_IDS, value);
}

// --- Code lists (the report tables' CHECK constraints) ----------------------

export const REPORT_STATUSES = ['new', 'looking', 'fixed', 'wont_fix'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  new: 'New',
  looking: 'Looking',
  fixed: 'Fixed',
  wont_fix: "Won't fix",
};

export const REPORT_ROLES = ['worker', 'employer', 'unknown'] as const;
export type ReportRole = (typeof REPORT_ROLES)[number];

export const REPORT_ROLE_LABELS: Readonly<Record<ReportRole, string>> = {
  worker: 'Worker',
  employer: 'Employer',
  unknown: 'Unknown role',
};

export const WORKER_REPORT_CATEGORIES = [
  'sign_in',
  'finding_jobs',
  'applying',
  'uploads',
  'profile',
  'whatsapp',
  'other',
] as const;

export const EMPLOYER_REPORT_CATEGORIES = [
  'account',
  'job_posting',
  'applicants',
  'messages',
  'billing',
  'emails',
  'company_profile',
  'other',
] as const;

export const REPORT_CATEGORIES = [
  'sign_in',
  'finding_jobs',
  'applying',
  'uploads',
  'profile',
  'whatsapp',
  'account',
  'job_posting',
  'applicants',
  'messages',
  'billing',
  'emails',
  'company_profile',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

// The team's English names for the categories, as the design lists them.
export const REPORT_CATEGORY_LABELS: Readonly<Record<ReportCategory, string>> = {
  sign_in: "Can't sign in or the code didn't arrive",
  finding_jobs: 'Finding jobs',
  applying: 'Applying to a job',
  uploads: 'Uploading documents or photos',
  profile: 'Worker profile',
  whatsapp: 'WhatsApp messages',
  account: 'Sign-in, account or verification email',
  job_posting: 'Posting or editing a job',
  applicants: 'Applicants and hiring',
  messages: 'Messages to workers',
  billing: 'Billing and plan',
  emails: 'Emails and daily summary',
  company_profile: 'Company profile and settings',
  other: 'Something else',
};

export function isReportStatus(value: unknown): value is ReportStatus {
  return isOneOf(REPORT_STATUSES, value);
}

export function isReportRole(value: unknown): value is ReportRole {
  return isOneOf(REPORT_ROLES, value);
}

export function isReportCategory(value: unknown): value is ReportCategory {
  return isOneOf(REPORT_CATEGORIES, value);
}

// --- Report numbers and ids -------------------------------------------------

export function formatReportNumber(reportNumber: number): string {
  return `JR-${reportNumber}`;
}

const REPORT_NUMBER_INPUT = /^(?:jr-?)?(\d{1,15})$/i;

/** "JR-1042", "jr1042" or "1042" -> 1042. Anything else -> null. */
export function parseReportNumber(input: unknown): number | null {
  if (typeof input !== 'string') return null;
  const match = REPORT_NUMBER_INPUT.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const REPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReportId(value: unknown): value is string {
  return typeof value === 'string' && REPORT_ID_PATTERN.test(value);
}

// --- Limits shared by the forms and the route -------------------------------

/** The existing reveal rule: a reason of at least 20 characters. */
export const REVEAL_REASON_MIN_LENGTH = 20;
/** The access record keeps a reveal reason of at most 500 characters. */
export const REVEAL_REASON_MAX_LENGTH = 500;
/** One internal note per report, plain text. */
export const REPORT_NOTE_MAX_LENGTH = 4000;
export const SIGNED_OUT_DAILY_CAP_MAX = 5000;
