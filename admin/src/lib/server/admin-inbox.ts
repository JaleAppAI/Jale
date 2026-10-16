/**
 * Contract K2.1-K2.3 (sprint 28): nav and Home counts, Home activity, and the
 * Inbox list. BE-2b owns this module; FE-1 and FE-2 render against it.
 *
 * Three sources feed the Inbox: admin cases (read directly), problem reports
 * (the jale_cap console functions) and identity lockouts (the 102 definer).
 * Who an item waits on:
 *   cases     open, pending_admin -> us; pending_worker -> worker; resolved, dismissed -> nobody
 *   reports   new, looking -> us (the badge and Home count both); fixed, wont_fix -> nobody
 *   lockouts  locked now -> us; lock lapsed, code expired, retrying -> worker; verified, superseded -> nobody
 * Counts and activity are not recorded (no person is named); a page of the
 * list is recorded per source under admin.inbox, in the read's transaction.
 */
import { REPORT_CATEGORY_LABELS, REPORT_STATUS_LABELS, formatReportNumber, type ReportCategory, type ReportRole, type ReportStatus } from '../report-policy';
import type { AdminCaseStatus, AdminCaseType } from '../types';
import { caseRef, caseSubjectIds } from './admin-cases';
import { lockoutRef } from './admin-lockouts';
import { INBOX_SQL, mapInboxRow, parseInboxFilters, reportDetailHref, type InboxRow } from './admin-reports';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AuditQueryClient,
} from './audit/record';
import { getAdminDbPool } from './db';
import type { AdminSession } from './session-claims';

// ---- Shared vocabulary (K2.0) ------------------------------------------------

export const CASE_KINDS: Readonly<Record<AdminCaseType, { kind: InboxItem['kind']; typeLabel: string; noun: string }>> = {
  help_request: { kind: 'support', typeLabel: 'Support', noun: 'support' },
  outbound_failure: { kind: 'delivery_issue', typeLabel: 'Delivery issue', noun: 'delivery issue' },
  conversation_stuck: { kind: 'stuck_conversation', typeLabel: 'Stuck conversation', noun: 'stuck conversation' },
  verification_blocker: { kind: 'verification_blocker', typeLabel: 'Verification', noun: 'verification' },
};

export const CASE_STATUS_LABELS: Readonly<Record<AdminCaseStatus, string>> = {
  open: 'Open',
  pending_admin: 'Worker replied',
  pending_worker: 'Waiting on worker',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export function isAdminCaseType(value: unknown): value is AdminCaseType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CASE_KINDS, value);
}

export function isAdminCaseStatus(value: unknown): value is AdminCaseStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CASE_STATUS_LABELS, value);
}

export function caseWaitingOn(status: AdminCaseStatus): InboxItem['waitingOn'] {
  if (status === 'open' || status === 'pending_admin') return 'us';
  if (status === 'pending_worker') return 'worker';
  return 'nobody';
}

export function supportCaseHref(caseId: string): string {
  return `/inbox/support/${encodeURIComponent(caseId.toLowerCase())}`;
}

export function lockoutHref(challengeId: string): string {
  return `/inbox/lockouts/${encodeURIComponent(challengeId.toLowerCase())}`;
}

const ACTOR_LABELS: Readonly<Record<string, string>> = { Ops: 'Ops admin', Superadmin: 'Superadmin' };

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Unexpected time');
  return date.toISOString();
}

function asCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(String(value ?? 0));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Unexpected count');
  return count;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : 'unknown';
}

// ---- K2.1 Counts ---------------------------------------------------------------

export type InboxCounts = {
  waitingOnUs: number;          // the nav badge: cases waiting on us + new or looking reports + current lockouts
  support: number;              // help_request waiting on us
  reports: number;              // reports with status new or looking
  lockouts: number;             // challenges locked right now
  deliveryIssues: number;       // outbound_failure cases waiting on us
  unreadSupport: number;        // help_request in pending_admin (the worker wrote since our last reply)
  oldestWaiting: { support: string | null; reports: string | null; lockouts: string | null }; // ISO
  newSinceLastVisit: number | null; // items that became waiting-on-us after the last_seen_at of the viewer's most recent ended session (signed out, revoked or expired; a session live on another device does not count); null when none has ended
};

/**
 * Every count in one statement, so the layout stays at one count query.
 * "The previous visit" is the last activity of the viewer's most recent
 * ended session (signed out, revoked or past its expiry), so a session still
 * live on another device does not move it; with none, null. Reports waiting
 * on us are those new or being looked into; the report figures beyond the
 * count read the 200 newest of each.
 */
export const INBOX_COUNTS_SQL = `
  WITH visit AS (
    SELECT (SELECT max(s.last_seen_at)
              FROM admin_sessions s
             WHERE s.admin_user_id = $1::uuid
               AND s.id <> $2::uuid
               AND (s.revoked_at IS NOT NULL OR s.expires_at <= now())
           ) AS since
  ), cases AS (
    SELECT count(*) FILTER (WHERE c.status IN ('open', 'pending_admin')) AS waiting,
           count(*) FILTER (WHERE c.case_type = 'help_request' AND c.status IN ('open', 'pending_admin')) AS support,
           count(*) FILTER (WHERE c.case_type = 'outbound_failure' AND c.status IN ('open', 'pending_admin')) AS delivery_issues,
           count(*) FILTER (WHERE c.case_type = 'help_request' AND c.status = 'pending_admin') AS unread_support,
           min(c.status_changed_at) FILTER (WHERE c.case_type = 'help_request' AND c.status IN ('open', 'pending_admin')) AS oldest_support,
           count(*) FILTER (WHERE c.status IN ('open', 'pending_admin') AND c.status_changed_at > v.since) AS fresh
      FROM admin_cases c CROSS JOIN visit v
  ), reports AS (
    SELECT (SELECT n.open_count FROM jale_cap.problem_report_counts() n) AS waiting,
           min(r.created_at) AS oldest,
           count(*) FILTER (WHERE r.created_at > v.since) AS fresh
      FROM (SELECT i.created_at
              FROM jale_cap.problem_report_inbox('new'::text, NULL::text, NULL::text, NULL::boolean, NULL::bigint, 200, NULL::timestamptz) i
            UNION ALL
            SELECT i.created_at
              FROM jale_cap.problem_report_inbox('looking'::text, NULL::text, NULL::text, NULL::boolean, NULL::bigint, 200, NULL::timestamptz) i
           ) r
      CROSS JOIN visit v
  ), lockouts AS (
    SELECT count(*) AS waiting,
           min(l.last_event_at) AS oldest,
           count(*) FILTER (WHERE l.last_event_at > v.since) AS fresh
      FROM public.admin_identity_lockouts(30) l CROSS JOIN visit v
     WHERE l.outcome = 'locked'
  )
  SELECT cases.waiting AS cases_waiting, cases.support, cases.delivery_issues, cases.unread_support,
         cases.oldest_support, cases.fresh AS cases_fresh,
         reports.waiting AS reports_waiting, reports.oldest AS oldest_report, reports.fresh AS reports_fresh,
         lockouts.waiting AS lockouts_waiting, lockouts.oldest AS oldest_lockout, lockouts.fresh AS lockouts_fresh,
         (SELECT since FROM visit) AS since
    FROM cases, reports, lockouts
`;

export type InboxCountsRow = {
  cases_waiting: number | string;
  support: number | string;
  delivery_issues: number | string;
  unread_support: number | string;
  oldest_support: Date | string | null;
  cases_fresh: number | string;
  reports_waiting: number | string | null;
  oldest_report: Date | string | null;
  reports_fresh: number | string;
  lockouts_waiting: number | string;
  oldest_lockout: Date | string | null;
  lockouts_fresh: number | string;
  since: Date | string | null;
};

export function mapInboxCountsRow(row: InboxCountsRow): InboxCounts {
  const support = asCount(row.support);
  const reports = asCount(row.reports_waiting);
  const lockouts = asCount(row.lockouts_waiting);
  return {
    waitingOnUs: asCount(row.cases_waiting) + reports + lockouts,
    support,
    reports,
    lockouts,
    deliveryIssues: asCount(row.delivery_issues),
    unreadSupport: asCount(row.unread_support),
    oldestWaiting: {
      support: isoOrNull(row.oldest_support),
      reports: isoOrNull(row.oldest_report),
      lockouts: isoOrNull(row.oldest_lockout),
    },
    newSinceLastVisit: row.since === null
      ? null
      : asCount(row.cases_fresh) + asCount(row.reports_fresh) + asCount(row.lockouts_fresh),
  };
}

// null on any failure: badge hidden.
export async function getInboxCounts(session: AdminSession): Promise<InboxCounts | null> {
  try {
    const pool = await getAdminDbPool();
    const { rows } = await pool.query<InboxCountsRow>(INBOX_COUNTS_SQL, [session.adminUserId ?? null, session.sessionId ?? null]);
    if (rows.length !== 1) throw new Error('expected one counts row');
    return mapInboxCountsRow(rows[0]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'inbox_counts_unavailable', code: sqlStateOf(error) }));
    return null;
  }
}

// ---- K2.2 Home activity --------------------------------------------------------

export type ActivityItem = {
  id: string;
  at: string;                                   // ISO
  kind: 'support_message' | 'support_media' | 'case_opened' | 'case_resolved' | 'lockout' | 'report' | 'job_resumed';
  text: string;   // server-built, no worker name, phone or message text, e.g. "A worker sent a photo in support case S-124"
  href: string | null;
};

export const ACTIVITY_DEFAULT_LIMIT = 8;
const ACTIVITY_MAX_LIMIT = 50;

/** Case events that make an activity line; admin replies other than the closing message do not. */
export const ACTIVITY_EVENTS_SQL = `
  SELECT e.id, e.event_type, e.actor_type, e.created_at,
         e.payload->>'byRole' AS by_role, e.payload->>'mediaType' AS media_type,
         c.id AS case_id, c.case_number, c.case_type
    FROM admin_case_events e
    JOIN admin_cases c ON c.id = e.case_id
   WHERE e.event_type IN ('worker_message', 'worker_media', 'case_created', 'admin_reply_queued', 'admin_note', 'lockout_reset')
     AND (e.event_type <> 'admin_reply_queued' OR e.payload->>'kind' = 'closing')
     AND (e.event_type <> 'admin_note' OR e.payload->>'action' = 'resolve')
     AND NOT (e.event_type = 'case_created' AND c.case_type = 'verification_blocker' AND e.actor_type = 'admin')
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT $1
`;
export const ACTIVITY_REPORTS_SQL = `
  SELECT r.report_id, r.report_number, r.created_at
    FROM jale_cap.problem_report_inbox(NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::bigint, $1::integer, NULL::timestamptz) r
`;
export const ACTIVITY_LOCKOUTS_SQL = `
  SELECT l.challenge_id, l.last_event_at
    FROM public.admin_identity_lockouts(7) l
   WHERE l.kind = 'lockout'
   ORDER BY l.last_event_at DESC, l.challenge_id
   LIMIT $1
`;
/** Billing's automatic job resumes (migration 125, BE-4a): ids and times only. */
export const ACTIVITY_JOB_RESUMES_SQL = 'SELECT event_id, job_id, changed_at FROM public.admin_recent_job_resumes($1::integer)';

export type ActivityEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  created_at: Date | string;
  by_role: string | null;
  media_type: string | null;
  case_id: string;
  case_number: number | string | null;
  case_type: string;
};

const MEDIA_NOUNS: Readonly<Record<string, string>> = { image: 'a photo', audio: 'a voice message', document: 'a document' };

function caseLabel(row: Pick<ActivityEventRow, 'case_number' | 'case_type'>): string {
  const noun = isAdminCaseType(row.case_type) ? CASE_KINDS[row.case_type].noun : 'admin';
  const ref = caseRef(row.case_number);
  return ref ? `${noun} case ${ref}` : `a ${noun} case`;
}

function actorLabel(byRole: string | null): string {
  return (byRole && ACTOR_LABELS[byRole]) ?? 'An admin';
}

/** One case event as an activity line, or null for an event that makes none. The text never carries the payload's words. */
export function mapActivityEventRow(row: ActivityEventRow): ActivityItem | null {
  const base = { id: row.id, at: asIso(row.created_at), href: supportCaseHref(row.case_id) };
  const label = caseLabel(row);
  switch (row.event_type) {
    case 'worker_message':
      return { ...base, kind: 'support_message', text: `A worker wrote in ${label}` };
    case 'worker_media':
      return { ...base, kind: 'support_media', text: `A worker sent ${MEDIA_NOUNS[row.media_type ?? ''] ?? 'a file'} in ${label}` };
    case 'case_created': {
      const text = row.actor_type === 'admin'
        ? `${actorLabel(row.by_role)} opened ${label}`
        : `New ${label}`;
      return { ...base, kind: 'case_opened', text: text.charAt(0).toUpperCase() + text.slice(1) };
    }
    case 'admin_reply_queued':
    case 'admin_note':
      return { ...base, kind: 'case_resolved', text: `${actorLabel(row.by_role)} resolved ${label}` };
    case 'lockout_reset':
      return { ...base, kind: 'lockout', text: `${actorLabel(row.by_role)} reset a verification lockout` };
    default:
      return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function byNewest(a: ActivityItem, b: ActivityItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// default 8, newest first
export async function loadRecentActivity(session: AdminSession, limit?: number): Promise<ActivityItem[]> {
  void session;
  const max = clampLimit(limit);
  const pool = await getAdminDbPool();
  const client = await pool.connect();
  try {
    const events = (await client.query<ActivityEventRow>(ACTIVITY_EVENTS_SQL, [max])).rows;
    const reports = (await client.query<{ report_id: string; report_number: number | string; created_at: Date | string }>(
      ACTIVITY_REPORTS_SQL, [max])).rows;
    const lockouts = (await client.query<{ challenge_id: string; last_event_at: Date | string }>(ACTIVITY_LOCKOUTS_SQL, [max])).rows;
    const resumes = (await client.query<{ event_id: string; job_id: string; changed_at: Date | string }>(
      ACTIVITY_JOB_RESUMES_SQL, [max])).rows;

    const items: ActivityItem[] = [
      ...events.map(mapActivityEventRow).filter((item): item is ActivityItem => item !== null),
      ...reports.map((row) => ({
        id: row.report_id.toLowerCase(),
        at: asIso(row.created_at),
        kind: 'report' as const,
        text: `New problem report ${formatReportNumber(Number(row.report_number))}`,
        href: reportDetailHref(row.report_id),
      })),
      ...lockouts.map((row) => ({
        id: row.challenge_id.toLowerCase(),
        at: asIso(row.last_event_at),
        kind: 'lockout' as const,
        text: `A worker was locked out of verification (${lockoutRef(row.challenge_id)})`,
        href: lockoutHref(row.challenge_id),
      })),
      ...resumes.map((row) => ({
        id: row.event_id.toLowerCase(),
        at: asIso(row.changed_at),
        kind: 'job_resumed' as const,
        text: 'A paused job went live again after payment recovered',
        href: null,
      })),
    ];
    return items.sort(byNewest).slice(0, max);
  } finally {
    client.release();
  }
}

// ---- K2.3 Inbox list -------------------------------------------------------------

export type InboxTab = 'all' | 'support' | 'reports' | 'lockouts';
export type InboxStatusFilter = 'waiting' | 'waiting_on_worker' | 'resolved' | 'all';
export type InboxReportFilter = {               // CCR-1, decided 2026-10-14; the existing report filters
  reportStatus: ReportStatus | null;               // param `reportStatus` (its own key: `status` is the Inbox status). When set, it replaces the Inbox status filter on the reports tab.
  role: ReportRole | null; category: ReportCategory | null; verified: boolean | null;
  number: number | null; numberInput: string; numberInvalid: boolean; // params role, category, verified=yes|no, number (JR-1042, jr1042 or 1042)
};
export type InboxQuery = { tab: InboxTab; status: InboxStatusFilter; q?: string; before?: string; report?: InboxReportFilter }; // report is set only when tab === 'reports'; parsed with the existing report parsers

const TABS: readonly InboxTab[] = ['all', 'support', 'reports', 'lockouts'];
const STATUSES: readonly InboxStatusFilter[] = ['waiting', 'waiting_on_worker', 'resolved', 'all'];
const Q_MAX_LENGTH = 40;

type SearchParamValue = string | string[] | undefined;

function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// bad values fall back to defaults: tab all, status waiting
export function parseInboxQuery(params: Readonly<Record<string, SearchParamValue>>): InboxQuery {
  const tabParam = firstParam(params.tab);
  const statusParam = firstParam(params.status);
  const tab = TABS.includes(tabParam as InboxTab) ? (tabParam as InboxTab) : 'all';
  const status = STATUSES.includes(statusParam as InboxStatusFilter) ? (statusParam as InboxStatusFilter) : 'waiting';
  const q = (firstParam(params.q) ?? '').trim().slice(0, Q_MAX_LENGTH);
  const before = firstParam(params.before);
  const query: InboxQuery = { tab, status };
  if (q) query.q = q;
  if (before && decodeInboxCursor(before)) query.before = before;
  if (tab === 'reports') {
    // The existing report parsers. The report status has its own key
    // (`status` is the Inbox's); the reports page's cursor is not an Inbox one.
    const { status: reportStatus, role, category, verified, number, numberInput, numberInvalid } = parseInboxFilters({
      status: params.reportStatus,
      role: params.role,
      category: params.category,
      verified: params.verified,
      number: params.number,
    });
    query.report = { reportStatus, role, category, verified, number, numberInput, numberInvalid };
  }
  return query;
}

export type InboxItem = {
  kind: 'support' | 'delivery_issue' | 'stuck_conversation' | 'verification_blocker' | 'report' | 'lockout';
  id: string;                // case id, report id or challenge id
  ref: string;               // K2.0
  typeLabel: string;
  subject: string;           // case summary, report title, or "Locked out of verification"
  from: string;              // "Worker", "Unregistered number", "Employer", "Worker (web)"
  statusLabel: string;
  waitingOn: 'us' | 'worker' | 'nobody';
  waitingSince: string | null; // ISO; drives the "Waiting" column
  unread: boolean;           // waitingOn === 'us'
  href: string;              // /inbox/support/<id> | /inbox/reports/<id> | /inbox/lockouts/<id>
};

export type InboxPage = {
  items: InboxItem[];        // page size 25
  tabCounts: Record<InboxTab, number>;  // under the current status filter
  total: number;             // matching the current tab and filter
  nextBefore?: string;       // keyset cursor
};

export const INBOX_PAGE_SIZE = 25;
/** Rows each source returns past the cursor: one more than a page. */
export const INBOX_SOURCE_LIMIT = INBOX_PAGE_SIZE + 1;
/** Report headers read per status, at most (the console function pages 200 at a time). */
export const INBOX_REPORT_READ_CAP = 1000;
const REPORT_READ_PAGE = 200;

// ---- The keyset cursor: base64url of "<sort key>|<source>|<id>" ----

export type InboxSource = 'case' | 'report' | 'lockout';
const SOURCE_RANK: Readonly<Record<InboxSource, number>> = { case: 0, report: 1, lockout: 2 };
const SORT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type InboxCursor = { sortKey: string; source: InboxSource; id: string };

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.sortKey}|${cursor.source}|${cursor.id}`, 'utf8').toString('base64url');
}

/** The cursor, or null for anything that is not exactly one this module wrote. */
export function decodeInboxCursor(value: string): InboxCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const parts = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) return null;
  const [sortKey, source, id] = parts;
  if (!SORT_KEY_PATTERN.test(sortKey) || Number.isNaN(Date.parse(sortKey))) return null;
  if (!Object.prototype.hasOwnProperty.call(SOURCE_RANK, source) || !UUID_PATTERN.test(id)) return null;
  const cursor = { sortKey, source: source as InboxSource, id };
  return encodeInboxCursor(cursor) === value ? cursor : null;
}

/** An item with its place in the order; `subjects` are the people a case is about (for its record). */
export type InboxCandidate = { item: InboxItem; source: InboxSource; sortKey: string; subjects?: string[] };
type Candidate = InboxCandidate;

/** Ascending order of (sort key, source, id); the waiting view reads it forwards, the others backwards. */
function compareKeys(a: { sortKey: string; source: InboxSource; id: string }, b: { sortKey: string; source: InboxSource; id: string }): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  if (a.source !== b.source) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function candidateKey(c: Candidate) {
  return { sortKey: c.sortKey, source: c.source, id: c.item.id };
}

// ---- q: a ref only (S-, JR-/R-, V-) ----

type RefSearch =
  | { kind: 'none' }
  | { kind: 'case'; number: number }
  | { kind: 'report'; number: number }
  | { kind: 'lockout'; prefix: string }
  | { kind: 'invalid' };

export function parseRefSearch(q: string | undefined): RefSearch {
  const text = q?.trim();
  if (!text) return { kind: 'none' };
  let match = /^s-?(\d{1,15})$/i.exec(text);
  if (match) {
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? { kind: 'case', number: value } : { kind: 'invalid' };
  }
  match = /^j?r-?(\d{1,15})$/i.exec(text);
  if (match) {
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? { kind: 'report', number: value } : { kind: 'invalid' };
  }
  match = /^v-?([0-9a-f]{8})$/i.exec(text);
  if (match) return { kind: 'lockout', prefix: match[1].toLowerCase() };
  return { kind: 'invalid' };
}

// ---- Source 1: cases ----

const CASE_TYPES_SQL = `c.case_type IN ('help_request', 'outbound_failure', 'conversation_stuck', 'verification_blocker')`;
const CASE_STATUS_SQL = `($1::text = 'all'
         OR ($1::text = 'waiting' AND c.status IN ('open', 'pending_admin'))
         OR ($1::text = 'waiting_on_worker' AND c.status = 'pending_worker')
         OR ($1::text = 'resolved' AND c.status IN ('resolved', 'dismissed')))`;

function caseRowsSql(direction: 'ASC' | 'DESC'): string {
  const after = direction === 'ASC' ? '>' : '<';
  return `
  SELECT c.id, c.case_type, c.status, c.summary, c.case_number, c.user_id, c.employer_id, c.status_changed_at,
         to_char(k.sort_key AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_cursor
    FROM admin_cases c
    CROSS JOIN LATERAL (SELECT CASE WHEN $1::text = 'waiting' THEN c.status_changed_at
                                    ELSE GREATEST(c.updated_at, c.status_changed_at) END AS sort_key) k
   WHERE ${CASE_TYPES_SQL}
     AND ${CASE_STATUS_SQL}
     AND ($2::bigint IS NULL OR c.case_number = $2::bigint)
     AND ($3::timestamptz IS NULL OR (k.sort_key, 0, c.id) ${after} ($3::timestamptz, $4::integer, $5::uuid))
   ORDER BY k.sort_key ${direction}, c.id ${direction}
   LIMIT $6
`;
}

/** The waiting view, oldest wait first. */
export const INBOX_CASES_ASC_SQL = caseRowsSql('ASC');
/** Every other view, newest activity first. */
export const INBOX_CASES_DESC_SQL = caseRowsSql('DESC');
export const INBOX_CASES_COUNT_SQL = `
  SELECT count(*) AS total
    FROM admin_cases c
   WHERE ${CASE_TYPES_SQL}
     AND ${CASE_STATUS_SQL}
     AND ($2::bigint IS NULL OR c.case_number = $2::bigint)
`;

export type InboxCaseRow = {
  id: string;
  case_type: string;
  status: string;
  summary: string;
  case_number: number | string | null;
  user_id: string | null;
  employer_id: string | null;
  status_changed_at: Date | string;
  sort_cursor: string;
};

export function mapInboxCaseRow(row: InboxCaseRow): Candidate {
  if (!isAdminCaseType(row.case_type)) throw new Error(`Unexpected case type: ${row.case_type}`);
  if (!isAdminCaseStatus(row.status)) throw new Error(`Unexpected case status: ${row.status}`);
  const kind = CASE_KINDS[row.case_type];
  const waitingOn = caseWaitingOn(row.status);
  const id = row.id.toLowerCase();
  return {
    source: 'case',
    sortKey: row.sort_cursor,
    subjects: caseSubjectIds([row]),
    item: {
      kind: kind.kind,
      id,
      ref: caseRef(row.case_number) ?? 'S-?',
      typeLabel: kind.typeLabel,
      subject: row.summary,
      from: row.employer_id ? 'Employer' : row.user_id ? 'Worker' : 'Unregistered number',
      statusLabel: CASE_STATUS_LABELS[row.status],
      waitingOn,
      waitingSince: waitingOn === 'nobody' ? null : asIso(row.status_changed_at),
      unread: waitingOn === 'us',
      href: supportCaseHref(id),
    },
  };
}

// ---- Source 2: reports ----

const REPORT_STATUSES_FOR: Readonly<Record<InboxStatusFilter, readonly (ReportStatus | null)[]>> = {
  waiting: ['new', 'looking'],
  waiting_on_worker: [],
  resolved: ['fixed', 'wont_fix'],
  all: [null],
};

function reportWaitingOn(status: ReportStatus): InboxItem['waitingOn'] {
  return status === 'new' || status === 'looking' ? 'us' : 'nobody';
}

export function mapInboxReportRow(row: InboxRow): Candidate {
  const report = mapInboxRow(row);
  const waitingOn = reportWaitingOn(report.status);
  return {
    source: 'report',
    sortKey: row.created_cursor,
    item: {
      kind: 'report',
      id: report.id,
      ref: report.numberLabel,
      typeLabel: 'Problem report',
      subject: REPORT_CATEGORY_LABELS[report.category],
      from: report.role === 'employer' ? 'Employer' : report.role === 'worker' ? 'Worker (web)' : 'Unknown',
      statusLabel: REPORT_STATUS_LABELS[report.status],
      waitingOn,
      waitingSince: waitingOn === 'nobody' ? null : report.createdAt,
      unread: waitingOn === 'us',
      href: reportDetailHref(report.id),
    },
  };
}

type ReportFilterArgs = { role: ReportRole | null; category: ReportCategory | null; verified: boolean | null; number: number | null };

/** Every matching report header of one status, newest first, up to the cap. */
async function readReportRows(client: AuditQueryClient, status: ReportStatus | null, filter: ReportFilterArgs): Promise<InboxRow[]> {
  const rows: InboxRow[] = [];
  let before: string | null = null;
  for (;;) {
    const page: InboxRow[] = (await client.query<InboxRow>(INBOX_SQL, [
      status, filter.role, filter.category, filter.verified, filter.number, REPORT_READ_PAGE, before,
    ])).rows;
    rows.push(...page);
    if (page.length < REPORT_READ_PAGE) break;
    if (rows.length >= INBOX_REPORT_READ_CAP) {
      console.error(JSON.stringify({ event: 'inbox_reports_capped', status: status ?? 'all' }));
      break;
    }
    before = page[page.length - 1].created_cursor;
  }
  return rows;
}

// ---- Source 3: lockouts ----

export const INBOX_LOCKOUTS_SQL = `
  SELECT l.challenge_id, l.kind, l.outcome, l.last_event_at,
         to_char(l.last_event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_cursor
    FROM public.admin_identity_lockouts(30) l
`;

export type InboxLockoutRow = {
  challenge_id: string;
  kind: string;
  outcome: string;
  last_event_at: Date | string;
  sort_cursor: string;
};

const LOCKOUT_STATUS_LABELS: Readonly<Record<string, string>> = {
  locked: 'Locked',
  lock_expired: 'Lock expired, no retry',
  retrying: 'Retrying',
  verified: 'Verified since lockout',
  superseded: 'Superseded',
  code_expired: 'Code expired',
};

function lockoutWaitingOn(outcome: string): InboxItem['waitingOn'] {
  if (outcome === 'locked') return 'us';
  if (outcome === 'verified' || outcome === 'superseded') return 'nobody';
  return 'worker';
}

export function mapInboxLockoutRow(row: InboxLockoutRow): Candidate {
  const label = LOCKOUT_STATUS_LABELS[row.outcome];
  if (!label) throw new Error(`Unexpected lockout outcome: ${row.outcome}`);
  const id = row.challenge_id.toLowerCase();
  const waitingOn = lockoutWaitingOn(row.outcome);
  return {
    source: 'lockout',
    sortKey: row.sort_cursor,
    item: {
      kind: 'lockout',
      id,
      ref: lockoutRef(id),
      typeLabel: 'Lockout',
      subject: row.kind === 'stuck' ? 'Stuck at the verification code' : 'Locked out of verification',
      from: 'Worker',
      statusLabel: label,
      waitingOn,
      waitingSince: waitingOn === 'nobody' ? null : asIso(row.last_event_at),
      unread: waitingOn === 'us',
      href: lockoutHref(id),
    },
  };
}

// ---- The page ----

function matchesStatus(item: InboxItem, status: InboxStatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'waiting') return item.waitingOn === 'us';
  if (status === 'waiting_on_worker') return item.waitingOn === 'worker';
  return item.waitingOn === 'nobody';
}

/** The candidates past the cursor, in the view's order, at most one more than a page. */
function pastCursor(candidates: Candidate[], cursor: InboxCursor | null, ascending: boolean): Candidate[] {
  const ordered = [...candidates].sort((a, b) => (ascending ? 1 : -1) * compareKeys(candidateKey(a), candidateKey(b)));
  const after = cursor
    ? ordered.filter((c) => (ascending ? 1 : -1) * compareKeys(candidateKey(c), cursor) > 0)
    : ordered;
  return after.slice(0, INBOX_SOURCE_LIMIT);
}

/** Merges the sources' first rows past the cursor and cuts one page (pure: checked by check-inbox.mjs). */
export function mergeInboxPage(sources: Candidate[][], ascending: boolean): { items: InboxItem[]; nextBefore?: string; shown: Candidate[] } {
  const merged = sources.flat().sort((a, b) => (ascending ? 1 : -1) * compareKeys(candidateKey(a), candidateKey(b)));
  const shown = merged.slice(0, INBOX_PAGE_SIZE);
  const last = shown[shown.length - 1];
  return {
    items: shown.map((c) => c.item),
    shown,
    ...(merged.length > INBOX_PAGE_SIZE && last ? { nextBefore: encodeInboxCursor(candidateKey(last)) } : {}),
  };
}

const EMPTY_COUNTS: Record<InboxTab, number> = { all: 0, support: 0, reports: 0, lockouts: 0 };

export async function loadInbox(session: AdminSession, query: InboxQuery): Promise<InboxPage> {
  const search = parseRefSearch(query.q);
  if (search.kind === 'invalid') {
    return { items: [], tabCounts: { ...EMPTY_COUNTS }, total: 0 };
  }
  // A ref names one item whatever its state, so a search spans every status.
  const status: InboxStatusFilter = search.kind === 'none' ? query.status : 'all';
  // On the reports tab a report status replaces the Inbox status: those
  // reports, newest first, as the reports list showed them.
  const reportStatus = query.tab === 'reports' && search.kind === 'none' ? query.report?.reportStatus ?? null : null;
  const ascending = status === 'waiting' && reportStatus === null;
  const cursor = query.before ? decodeInboxCursor(query.before) : null;

  const wantCases = search.kind === 'none' || search.kind === 'case';
  const wantReports = (search.kind === 'none' || search.kind === 'report') && !(query.report?.numberInvalid);
  const wantLockouts = search.kind === 'none' || search.kind === 'lockout';
  const reportFilter: ReportFilterArgs = {
    role: query.report?.role ?? null,
    category: query.report?.category ?? null,
    verified: query.report?.verified ?? null,
    number: search.kind === 'report' ? search.number : query.report?.number ?? null,
  };

  try {
    return await withAdminReadTransaction(session, async (client) => {
      // Cases: one page past the cursor and the count, in SQL.
      let cases: Candidate[] = [];
      let caseCount = 0;
      if (wantCases) {
        const caseNumber = search.kind === 'case' ? search.number : null;
        const rank = cursor ? SOURCE_RANK[cursor.source] : null;
        const rows = (await client.query<InboxCaseRow>(ascending ? INBOX_CASES_ASC_SQL : INBOX_CASES_DESC_SQL, [
          status, caseNumber, cursor?.sortKey ?? null, rank, cursor?.id ?? null, INBOX_SOURCE_LIMIT,
        ])).rows;
        cases = rows.map(mapInboxCaseRow);
        caseCount = asCount((await client.query<{ total: number | string }>(INBOX_CASES_COUNT_SQL, [status, caseNumber])).rows[0]?.total);
      }

      // Reports: every matching header of the view's statuses, then the cursor.
      let reportsAll: Candidate[] = [];
      if (wantReports) {
        for (const each of reportStatus ? [reportStatus] : REPORT_STATUSES_FOR[status]) {
          reportsAll.push(...(await readReportRows(client, each, reportFilter)).map(mapInboxReportRow));
        }
        if (!reportStatus) {
          reportsAll = reportsAll.filter((c) => matchesStatus(c.item, status));
        }
      }

      // Lockouts: the last 30 days from the 102 definer, filtered here.
      let lockoutsAll: Candidate[] = [];
      if (wantLockouts) {
        lockoutsAll = (await client.query<InboxLockoutRow>(INBOX_LOCKOUTS_SQL)).rows
          .map(mapInboxLockoutRow)
          .filter((c) => matchesStatus(c.item, status))
          .filter((c) => search.kind !== 'lockout' || c.item.id.startsWith(search.prefix));
      }

      const tabCounts: Record<InboxTab, number> = {
        support: caseCount,
        reports: reportsAll.length,
        lockouts: lockoutsAll.length,
        all: caseCount + reportsAll.length + lockoutsAll.length,
      };

      const sources: Candidate[][] = [];
      if (query.tab === 'all' || query.tab === 'support') sources.push(cases);
      if (query.tab === 'all' || query.tab === 'reports') sources.push(pastCursor(reportsAll, cursor, ascending));
      if (query.tab === 'all' || query.tab === 'lockouts') sources.push(pastCursor(lockoutsAll, cursor, ascending));
      const page = mergeInboxPage(sources, ascending);

      // One record per source that has rows on the page.
      const shownCases = page.shown.filter((c) => c.source === 'case');
      const shownReports = page.shown.filter((c) => c.source === 'report');
      const shownLockouts = page.shown.filter((c) => c.source === 'lockout');
      if (shownCases.length > 0) {
        await recordAdminAccess(session, {
          surface: 'admin.inbox',
          categories: ['cases'],
          subjectUserIds: shownCases.flatMap((c) => c.subjects ?? []),
          recordType: 'admin_case',
          recordIds: shownCases.map((c) => c.item.id),
        }, client);
      }
      if (shownReports.length > 0) {
        await recordAdminAccess(session, {
          surface: 'admin.inbox',
          categories: ['problem_reports'],
          subjectUserIds: [],
          recordType: 'problem_report',
          recordIds: shownReports.map((c) => c.item.id),
        }, client);
      }
      if (shownLockouts.length > 0) {
        await recordAdminAccess(session, {
          surface: 'admin.inbox',
          categories: ['verifications'],
          recordType: 'identity_challenge',
          recordIds: shownLockouts.map((c) => c.item.id),
          purpose: { kind: 'verification' },
        }, client);
      }

      return {
        items: page.items,
        tabCounts,
        total: tabCounts[query.tab],
        ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
      };
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.inbox',
      categories: ['cases', 'problem_reports', 'verifications'],
      outcome: 'failed',
    });
    throw error;
  }
}
