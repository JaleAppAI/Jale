// Read models for the problem-report inbox.
//
// Every read goes through a jale_cap console function inside
// withAdminReadTransaction: the function runs, the access event is recorded
// on the same client, the transaction commits, and only then is anything
// returned for rendering. If the event cannot be written, the transaction
// rolls back and the page renders nothing. A refused or failed read is
// recorded as an attempt after the transaction has ended.
//
// Contact details arrive masked from SQL. Raw contact is never read here: it
// comes only from the reveal action (report-actions.ts), after the reveal is
// recorded.
import { getAdminDbPool } from './db';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AdminSurface,
} from './audit/record';
import type { AdminSession } from './session-claims';
import {
  REPORT_CATEGORY_LABELS,
  REPORT_ROLE_LABELS,
  REPORT_STATUS_LABELS,
  formatReportNumber,
  isReportCategory,
  isReportRole,
  isReportStatus,
  parseReportNumber,
  type ReportCategory,
  type ReportRole,
  type ReportStatus,
} from '../report-policy';

export const REPORTS_PAGE_SIZE = 50;

// The function returns newest first; WITH ORDINALITY keeps that order. The
// cursor keeps microseconds, because node-postgres turns timestamptz into a
// millisecond Date and a truncated cursor would skip rows on the next page.
export const INBOX_SQL = `
  SELECT i.report_id, i.report_number, i.role, i.verified, i.category, i.stops_work, i.status,
         i.has_image, i.created_at, i.content_erased,
         to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor
    FROM jale_cap.problem_report_inbox($1::text, $2::text, $3::text, $4::boolean, $5::bigint, $6::integer, $7::timestamptz)
         WITH ORDINALITY AS i
   ORDER BY i.ordinality
`;

export const DETAIL_SQL = `
  SELECT report_id, report_number, role, verified, category, stops_work, locale, include_technical,
         status, has_image, created_at, updated_at, status_changed_at, content_erased,
         description, context, internal_note, contact_kind, contact_masked,
         account_user_id, account_exists, image_available
    FROM jale_cap.problem_report_detail($1::uuid)
`;

export const COUNTS_SQL = 'SELECT new_count, open_count FROM jale_cap.problem_report_counts()';

export const SETTINGS_SQL = `
  SELECT reporting_enabled, signed_out_enabled, screenshots_enabled, team_email_enabled,
         signed_out_daily_cap, team_recipient, admin_base_url, updated_at
    FROM jale_cap.problem_report_settings_get()
`;

// What the detail view shows of a report's personal content.
const DETAIL_FIELD_NAMES = ['description', 'context', 'contact_masked', 'internal_note'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** The SQLSTATE of a database error, or 'unknown'. Never the message: it can carry values. */
function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : 'unknown';
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Unexpected report time');
  }
  return date.toISOString();
}

function asReportNumber(value: unknown): number {
  const reportNumber = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(reportNumber) || reportNumber < 1) {
    throw new Error('Unexpected report number');
  }
  return reportNumber;
}

function asRole(value: unknown): ReportRole {
  if (!isReportRole(value)) throw new Error(`Unexpected report role: ${String(value)}`);
  return value;
}

function asCategory(value: unknown): ReportCategory {
  if (!isReportCategory(value)) throw new Error(`Unexpected report category: ${String(value)}`);
  return value;
}

function asStatus(value: unknown): ReportStatus {
  if (!isReportStatus(value)) throw new Error(`Unexpected report status: ${String(value)}`);
  return value;
}

function asReportId(value: unknown): string {
  if (!isUuid(value)) throw new Error('Unexpected report id');
  return value.toLowerCase();
}

// --- Failure handling shared by the three pages -----------------------------

type ReportReadSurface = Extract<AdminSurface, 'admin.reports_list' | 'admin.report_detail' | 'admin.report_settings'>;

/**
 * A read that failed: one log line with codes only, a 'failed' attempt after
 * the transaction has ended, then an error without any database text.
 */
async function failRead(
  session: AdminSession,
  surface: ReportReadSurface,
  error: unknown,
  message: string,
  recordIds: string[] = [],
): Promise<never> {
  console.error(JSON.stringify({
    event: 'report_read_failed',
    surface,
    code: sqlStateOf(error),
    request_id: session.requestId,
  }));
  await recordAdminAttempt(session, {
    surface,
    categories: ['problem_reports'],
    ...(recordIds.length > 0 ? { recordType: 'problem_report' as const, recordIds } : {}),
    outcome: 'failed',
  });
  throw new Error(message);
}

// --- The list ----------------------------------------------------------------

export type ReportInboxFilters = {
  status: ReportStatus | null;
  role: ReportRole | null;
  category: ReportCategory | null;
  verified: boolean | null;
  number: number | null;
  /** What was typed in "Find a number", trimmed and bounded, to show it again. */
  numberInput: string;
  numberInvalid: boolean;
  /** The next-page cursor: the created time of the last row shown. */
  before: string | null;
};

type SearchParamValue = string | string[] | undefined;

function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Filters from the page's searchParams. Anything outside the code lists is ignored. */
export function parseInboxFilters(params: Readonly<Record<string, SearchParamValue>>): ReportInboxFilters {
  const status = firstParam(params.status);
  const role = firstParam(params.role);
  const category = firstParam(params.category);
  const verified = firstParam(params.verified);
  const numberText = (firstParam(params.number) ?? '').trim();
  const reportNumber = numberText ? parseReportNumber(numberText) : null;
  const before = firstParam(params.before);

  return {
    status: isReportStatus(status) ? status : null,
    role: isReportRole(role) ? role : null,
    category: isReportCategory(category) ? category : null,
    verified: verified === 'yes' ? true : verified === 'no' ? false : null,
    number: reportNumber,
    numberInput: numberText.slice(0, 40),
    numberInvalid: numberText !== '' && reportNumber === null,
    before: isCursor(before) ? before : null,
  };
}

/**
 * A link to the Inbox's reports tab with the same report filters (sprint 28,
 * K2.3/K2.5: the reports list lives at /inbox?tab=reports). The report status
 * travels as `reportStatus`, since `status` is the Inbox's own filter; this
 * list's cursor is left out (the Inbox has its own), so the Inbox starts at
 * its first page. `overrides` is kept for the callers' signature.
 */
export function inboxHref(
  filters: Pick<ReportInboxFilters, 'status' | 'role' | 'category' | 'verified' | 'number'>,
  overrides: { before?: string | null } = {},
): string {
  void overrides;
  const query = new URLSearchParams({ tab: 'reports' });
  if (filters.status) query.set('reportStatus', filters.status);
  if (filters.role) query.set('role', filters.role);
  if (filters.category) query.set('category', filters.category);
  if (filters.verified !== null) query.set('verified', filters.verified ? 'yes' : 'no');
  if (filters.number !== null) query.set('number', String(filters.number));
  return `/inbox?${query.toString()}`;
}

/** A report's page in the Inbox (K2.5). */
export function reportDetailHref(reportId: string): string {
  return `/inbox/reports/${encodeURIComponent(reportId.toLowerCase())}`;
}

export type InboxRow = {
  report_id: string;
  report_number: string | number;
  role: string;
  verified: boolean;
  category: string;
  stops_work: boolean | null;
  status: string;
  has_image: boolean;
  created_at: Date | string;
  content_erased: boolean;
  created_cursor: string;
};

export type ReportInboxRow = {
  id: string;
  number: number;
  numberLabel: string;
  role: ReportRole;
  roleLabel: string;
  verified: boolean;
  category: ReportCategory;
  categoryLabel: string;
  stopsWork: boolean | null;
  status: ReportStatus;
  statusLabel: string;
  hasImage: boolean;
  createdAt: string;
  contentErased: boolean;
};

export type ReportInboxPage = {
  rows: ReportInboxRow[];
  /** Set when there is another page: the cursor for its link. */
  nextBefore: string | null;
};

export function mapInboxRow(row: InboxRow): ReportInboxRow {
  const reportNumber = asReportNumber(row.report_number);
  const role = asRole(row.role);
  const category = asCategory(row.category);
  const status = asStatus(row.status);
  return {
    id: asReportId(row.report_id),
    number: reportNumber,
    numberLabel: formatReportNumber(reportNumber),
    role,
    roleLabel: REPORT_ROLE_LABELS[role],
    verified: row.verified === true,
    category,
    categoryLabel: REPORT_CATEGORY_LABELS[category],
    stopsWork: typeof row.stops_work === 'boolean' ? row.stops_work : null,
    status,
    statusLabel: REPORT_STATUS_LABELS[status],
    hasImage: row.has_image === true,
    createdAt: asIso(row.created_at),
    contentErased: row.content_erased === true,
  };
}

/**
 * One page of the inbox, newest first. Reads one row more than it shows to
 * know whether there is a next page, and records exactly the ids shown.
 */
export async function listProblemReports(session: AdminSession, filters: ReportInboxFilters): Promise<ReportInboxPage> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const { rows } = await client.query<InboxRow>(INBOX_SQL, [
        filters.status,
        filters.role,
        filters.category,
        filters.verified,
        filters.number,
        REPORTS_PAGE_SIZE + 1,
        filters.before,
      ]);
      const shown = rows.slice(0, REPORTS_PAGE_SIZE).map(mapInboxRow);
      const lastShown = rows[REPORTS_PAGE_SIZE - 1];
      const nextBefore = rows.length > REPORTS_PAGE_SIZE && isCursor(lastShown?.created_cursor)
        ? lastShown.created_cursor
        : null;

      await recordAdminAccess(session, {
        surface: 'admin.reports_list',
        categories: ['problem_reports'],
        subjectUserIds: [],
        recordType: 'problem_report',
        recordIds: shown.map((row) => row.id),
      }, client);

      return { rows: shown, nextBefore };
    });
  } catch (error) {
    return failRead(session, 'admin.reports_list', error, 'The reports could not be loaded.');
  }
}

// --- The nav badge -------------------------------------------------------------

export type ReportCounts = { newCount: number; openCount: number };

function asCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Unexpected report count');
  return count;
}

/**
 * The counts behind the nav badge, from their own COUNT query, never from a
 * page of rows. Counts are aggregates and are not recorded. Returns null when
 * they are unavailable, so the badge hides instead of failing the page.
 */
export async function getProblemReportCounts(): Promise<ReportCounts | null> {
  try {
    const pool = await getAdminDbPool();
    const { rows } = await pool.query<{ new_count: number | string; open_count: number | string }>(COUNTS_SQL);
    return { newCount: asCount(rows[0]?.new_count), openCount: asCount(rows[0]?.open_count) };
  } catch (error) {
    console.error(JSON.stringify({ event: 'report_counts_unavailable', code: sqlStateOf(error) }));
    return null;
  }
}

// --- The context a report carries (schema v1), treated as untrusted ---------

const MAX_SCREENS = 5;
const MAX_REQUESTS = 20;
const MAX_ERRORS = 10;
const MAX_REFS = 10;
const REF_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const METHOD_PATTERN = /^[A-Za-z]{1,10}$/;
const ISO_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

const DEVICE_KINDS = ['phone', 'tablet', 'desktop'] as const;
const ERROR_KINDS = ['error', 'rejection', 'api'] as const;
const CAPTURE_OUTCOMES = ['ok', 'timeout', 'failed', 'removed', 'attached', 'none'] as const;

export type ReportRequestView = {
  method: string | null;
  pattern: string | null;
  /** The HTTP status; 0 means no response was observed. */
  status: number | null;
  ms: number | null;
  requestId: string | null;
};

export type ReportErrorView = {
  kind: (typeof ERROR_KINDS)[number] | null;
  message: string;
  at: string | null;
};

export type ReportContextView = {
  screen: { pattern: string | null; refs: { name: string; id: string }[] };
  screens: string[];
  app: { build: string | null; locale: 'es' | 'en' | null; theme: 'light' | 'dark' | null };
  device: {
    kind: (typeof DEVICE_KINDS)[number] | null;
    browser: string | null;
    os: string | null;
    viewport: [number, number] | null;
    online: boolean | null;
    tz: string | null;
    localTime: string | null;
  };
  requests: ReportRequestView[];
  errors: ReportErrorView[];
  capture: { outcome: (typeof CAPTURE_OUTCOMES)[number]; ms: number | null } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;
}

function wholeNumber(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? Math.round(value)
    : null;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIME_PREFIX.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function parseRequest(value: unknown): ReportRequestView | null {
  const request = asRecord(value);
  if (!request) return null;
  return {
    method: typeof request.m === 'string' && METHOD_PATTERN.test(request.m) ? request.m.toUpperCase() : null,
    pattern: boundedText(request.p, 200),
    status: wholeNumber(request.s, 999),
    ms: duration(request.ms),
    requestId: typeof request.rid === 'string' && REQUEST_ID_PATTERN.test(request.rid) ? request.rid : null,
  };
}

function parseError(value: unknown): ReportErrorView | null {
  const error = asRecord(value);
  if (!error) return null;
  return {
    kind: oneOf(ERROR_KINDS, error.k),
    message: boundedText(error.msg, 200) ?? '',
    at: isoTime(error.at),
  };
}

function parseViewport(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [width, height] = value;
  const w = wholeNumber(width, 20_000);
  const h = wholeNumber(height, 20_000);
  return w && h ? [w, h] : null;
}

/** The context as the Lambda stored it (schema v1), type-checked and bounded. */
export function parseReportContext(value: unknown): ReportContextView | null {
  const context = asRecord(value);
  if (!context) return null;

  const screen = asRecord(context.screen) ?? {};
  const refs = Object.entries(asRecord(screen.refs) ?? {})
    .filter(([name, id]) => REF_NAME_PATTERN.test(name) && isUuid(id))
    .slice(0, MAX_REFS)
    .map(([name, id]) => ({ name, id: (id as string).toLowerCase() }));
  const app = asRecord(context.app) ?? {};
  const device = asRecord(context.device) ?? {};
  const capture = asRecord(context.capture);
  const captureOutcome = oneOf(CAPTURE_OUTCOMES, capture?.outcome);

  return {
    screen: { pattern: boundedText(screen.pattern, 200), refs },
    screens: (Array.isArray(context.screens) ? context.screens : [])
      .map((entry) => boundedText(entry, 200))
      .filter((entry): entry is string => entry !== null)
      .slice(0, MAX_SCREENS),
    app: {
      build: boundedText(app.build, 64),
      locale: oneOf(['es', 'en'] as const, app.locale),
      theme: oneOf(['light', 'dark'] as const, app.theme),
    },
    device: {
      kind: oneOf(DEVICE_KINDS, device.kind),
      browser: boundedText(device.browser, 60),
      os: boundedText(device.os, 60),
      viewport: parseViewport(device.viewport),
      online: typeof device.online === 'boolean' ? device.online : null,
      tz: boundedText(device.tz, 64),
      localTime: boundedText(device.local_time, 40),
    },
    requests: (Array.isArray(context.requests) ? context.requests : [])
      .map(parseRequest)
      .filter((entry): entry is ReportRequestView => entry !== null)
      .slice(0, MAX_REQUESTS),
    errors: (Array.isArray(context.errors) ? context.errors : [])
      .map(parseError)
      .filter((entry): entry is ReportErrorView => entry !== null)
      .slice(0, MAX_ERRORS),
    capture: captureOutcome ? { outcome: captureOutcome, ms: duration(capture?.ms) } : null,
  };
}

export type RequestOutcome = 'ok' | 'client_error' | 'server_error' | 'no_response' | 'unknown';

/** Status 0 means no response was observed (a network failure, an abort or a beacon). */
export function requestOutcome(status: number | null): RequestOutcome {
  if (status === null) return 'unknown';
  if (status === 0) return 'no_response';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  if (status >= 100) return 'ok';
  return 'unknown';
}

export function requestStatusText(status: number | null): string {
  if (status === null) return 'unknown';
  if (status === 0) return 'no response';
  return String(status);
}

function isFailingRequest(status: number | null): boolean {
  const outcome = requestOutcome(status);
  return outcome === 'server_error' || outcome === 'client_error' || outcome === 'no_response';
}

// --- The detail ---------------------------------------------------------------

type DetailRow = {
  report_id: string;
  report_number: string | number;
  role: string;
  verified: boolean;
  category: string;
  stops_work: boolean | null;
  locale: string;
  include_technical: boolean;
  status: string;
  has_image: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string | null;
  content_erased: boolean;
  description: string | null;
  context: unknown;
  internal_note: string | null;
  contact_kind: string;
  contact_masked: string | null;
  account_user_id: string | null;
  account_exists: boolean;
  image_available: boolean;
};

export type ReportContactKind = 'account' | 'typed' | 'none';

export type ProblemReportDetail = {
  id: string;
  number: number;
  numberLabel: string;
  role: ReportRole;
  roleLabel: string;
  verified: boolean;
  category: ReportCategory;
  categoryLabel: string;
  stopsWork: boolean | null;
  locale: 'es' | 'en' | null;
  includeTechnical: boolean;
  status: ReportStatus;
  statusLabel: string;
  hasImage: boolean;
  imageAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  contentErased: boolean;
  description: string | null;
  context: ReportContextView | null;
  internalNote: string | null;
  contactKind: ReportContactKind;
  /** Masked in SQL. The raw value comes only from a recorded reveal. */
  contactMasked: string | null;
  accountUserId: string | null;
  accountExists: boolean;
};

const CONTACT_KINDS: readonly ReportContactKind[] = ['account', 'typed', 'none'];

function plainText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function mapReportDetailRow(row: DetailRow): ProblemReportDetail {
  const reportNumber = asReportNumber(row.report_number);
  const role = asRole(row.role);
  const category = asCategory(row.category);
  const status = asStatus(row.status);
  const contactKind = oneOf(CONTACT_KINDS, row.contact_kind);
  if (!contactKind) throw new Error(`Unexpected contact kind: ${String(row.contact_kind)}`);
  if (row.account_user_id !== null && row.account_user_id !== undefined && !isUuid(row.account_user_id)) {
    throw new Error('Unexpected account id');
  }
  // Erased content (12 months, or the account deleted) shows nothing personal,
  // whatever the row carries.
  const erased = row.content_erased === true;

  return {
    id: asReportId(row.report_id),
    number: reportNumber,
    numberLabel: formatReportNumber(reportNumber),
    role,
    roleLabel: REPORT_ROLE_LABELS[role],
    verified: row.verified === true,
    category,
    categoryLabel: REPORT_CATEGORY_LABELS[category],
    stopsWork: typeof row.stops_work === 'boolean' ? row.stops_work : null,
    locale: oneOf(['es', 'en'] as const, row.locale),
    includeTechnical: row.include_technical === true,
    status,
    statusLabel: REPORT_STATUS_LABELS[status],
    hasImage: row.has_image === true,
    imageAvailable: row.image_available === true,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    statusChangedAt: row.status_changed_at ? asIso(row.status_changed_at) : null,
    contentErased: erased,
    description: erased ? null : plainText(row.description),
    context: erased ? null : parseReportContext(row.context),
    internalNote: erased ? null : plainText(row.internal_note),
    contactKind: erased ? 'none' : contactKind,
    contactMasked: erased || contactKind === 'none' ? null : plainText(row.contact_masked),
    accountUserId: erased || !row.account_user_id ? null : row.account_user_id.toLowerCase(),
    accountExists: row.account_exists === true,
  };
}

class ReportNotFound extends Error {}

/**
 * One report, recorded before it is returned. Returns null (after recording
 * a not_found attempt) for an id that is malformed or names no report.
 */
export async function getProblemReport(session: AdminSession, id: string): Promise<ProblemReportDetail | null> {
  if (!isUuid(id)) {
    await recordAdminAttempt(session, {
      surface: 'admin.report_detail',
      categories: ['problem_reports'],
      outcome: 'not_found',
    });
    return null;
  }
  const reportId = id.toLowerCase();

  try {
    return await withAdminReadTransaction(session, async (client) => {
      const { rows } = await client.query<DetailRow>(DETAIL_SQL, [reportId]);
      if (rows.length === 0) {
        throw new ReportNotFound();
      }
      const detail = mapReportDetailRow(rows[0]);

      await recordAdminAccess(session, {
        surface: 'admin.report_detail',
        categories: ['problem_reports'],
        subjectUserIds: detail.accountUserId ? [detail.accountUserId] : [],
        recordType: 'problem_report',
        recordIds: [detail.id],
        fieldNames: detail.contentErased ? [] : DETAIL_FIELD_NAMES,
      }, client);

      return detail;
    });
  } catch (error) {
    if (error instanceof ReportNotFound) {
      await recordAdminAttempt(session, {
        surface: 'admin.report_detail',
        categories: ['problem_reports'],
        recordType: 'problem_report',
        recordIds: [reportId],
        outcome: 'not_found',
      });
      return null;
    }
    return failRead(session, 'admin.report_detail', error, 'The report could not be loaded.', [reportId]);
  }
}

// --- Copy summary ----------------------------------------------------------------

/**
 * Everything "Copy summary" may contain, and nothing else: no words, no
 * contact, no note, no error messages and no record references.
 */
export type ReportSummaryInput = {
  number: number;
  category: ReportCategory;
  role: ReportRole;
  verified: boolean;
  screenPattern: string | null;
  build: string | null;
  deviceKind: string | null;
  failingRequests: { method: string | null; pattern: string | null; status: number | null; requestId: string | null }[];
};

export function reportSummaryInput(detail: ProblemReportDetail): ReportSummaryInput {
  const context = detail.context;
  return {
    number: detail.number,
    category: detail.category,
    role: detail.role,
    verified: detail.verified,
    screenPattern: context?.screen.pattern ?? null,
    build: context?.app.build ?? null,
    deviceKind: context?.device.kind ?? null,
    failingRequests: (context?.requests ?? [])
      .filter((request) => isFailingRequest(request.status))
      .map(({ method, pattern, status, requestId }) => ({ method, pattern, status, requestId })),
  };
}

/** Non-personal text for the team's issue tracker. */
export function buildReportSummary(input: ReportSummaryInput): string {
  const lines = [
    `${formatReportNumber(input.number)} · ${REPORT_CATEGORY_LABELS[input.category]}`,
    `${REPORT_ROLE_LABELS[input.role]} · ${input.verified ? 'Verified' : 'Unverified'}`,
    `Screen: ${input.screenPattern ?? 'not recorded'}`,
    `Build: ${input.build ?? 'not recorded'}`,
    `Device: ${input.deviceKind ?? 'not recorded'}`,
  ];
  if (input.failingRequests.length === 0) {
    lines.push('Failing requests: none');
  } else {
    lines.push('Failing requests:');
    for (const request of input.failingRequests) {
      const id = request.requestId ? ` · request id ${request.requestId}` : '';
      lines.push(`- ${request.method ?? '?'} ${request.pattern ?? '?'} · ${requestStatusText(request.status)}${id}`);
    }
  }
  return lines.join('\n');
}

// --- Times ---------------------------------------------------------------------

const RELATIVE_TIME = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "9 minutes ago", "yesterday", "4 days ago", then the UTC date. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown time';
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 45) return RELATIVE_TIME.format(-Math.max(1, Math.round(minutes)), 'minute');
  const hours = minutes / 60;
  if (hours < 22) return RELATIVE_TIME.format(-Math.max(1, Math.round(hours)), 'hour');
  const days = hours / 24;
  if (days < 30) return RELATIVE_TIME.format(-Math.max(1, Math.round(days)), 'day');
  return new Date(then).toISOString().slice(0, 10);
}

/** "2026-10-02 11:51 UTC". The server renders in UTC, so the zone is named. */
export function formatUtcTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return 'unknown time';
  const text = time.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

// --- Settings --------------------------------------------------------------------

type SettingsRow = {
  reporting_enabled: boolean;
  signed_out_enabled: boolean;
  screenshots_enabled: boolean;
  team_email_enabled: boolean;
  signed_out_daily_cap: number;
  team_recipient: string | null;
  admin_base_url: string | null;
  updated_at: Date | string;
};

export type ReportSettingsView = {
  reportingEnabled: boolean;
  signedOutEnabled: boolean;
  screenshotsEnabled: boolean;
  teamEmailEnabled: boolean;
  signedOutDailyCap: number;
  /** Only the domain of the team mailbox; the full address never leaves here. */
  teamRecipientDomain: string | null;
  adminBaseUrl: string | null;
  updatedAt: string;
};

function mailboxDomain(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf('@');
  return at > 0 && at < value.length - 1 ? value.slice(at + 1).toLowerCase() : null;
}

export function mapReportSettingsRow(row: SettingsRow): ReportSettingsView {
  return {
    reportingEnabled: row.reporting_enabled === true,
    signedOutEnabled: row.signed_out_enabled === true,
    screenshotsEnabled: row.screenshots_enabled === true,
    teamEmailEnabled: row.team_email_enabled === true,
    signedOutDailyCap: asCount(row.signed_out_daily_cap),
    teamRecipientDomain: mailboxDomain(row.team_recipient),
    adminBaseUrl: typeof row.admin_base_url === 'string' && row.admin_base_url ? row.admin_base_url : null,
    updatedAt: asIso(row.updated_at),
  };
}

/** The settings, recorded on every view. Superadmin only (the page checks the policy). */
export async function getProblemReportSettings(session: AdminSession): Promise<ReportSettingsView> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const { rows } = await client.query<SettingsRow>(SETTINGS_SQL);
      if (!rows[0]) {
        throw new Error('The report settings row is missing');
      }
      const settings = mapReportSettingsRow(rows[0]);
      await recordAdminAccess(session, {
        surface: 'admin.report_settings',
        categories: ['problem_reports'],
        resultCount: 1,
      }, client);
      return settings;
    });
  } catch (error) {
    return failRead(session, 'admin.report_settings', error, 'The report settings could not be loaded.');
  }
}

/** A refused settings view is recorded as a denied attempt. */
export async function recordReportSettingsDenied(session: AdminSession): Promise<void> {
  await recordAdminAttempt(session, {
    surface: 'admin.report_settings',
    categories: ['problem_reports'],
    outcome: 'denied',
  });
}
