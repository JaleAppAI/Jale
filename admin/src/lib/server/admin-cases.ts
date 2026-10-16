import type { OpenCasesByWait } from '../case-aging';
import type { AdminCase, AdminCaseStatus, AdminCaseType, AdminTimelineEvent, IdentityLockout } from '../types';
import { countRecentReveals, REVEAL_TILE_DAYS } from './admin-audit';
import { listIdentityLockouts } from './admin-lockouts';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AuditQueryClient,
} from './audit/record';
import type { AdminSession } from './session-claims';

export type AdminCaseRow = {
  id: string;
  case_type: string;
  status: string;
  priority: number;
  user_id: string | null;
  conversation_id: string | null;
  employer_id: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string;
  case_number?: number | string | null;
  assigned_admin_email: string | null;
  user_name: string | null;
  user_phone: string | null;
  user_email: string | null;
  employer_name: string | null;
};

export type AdminCaseEventRow = {
  id: string;
  event_type: string;
  actor_type: 'system' | 'worker' | 'admin';
  payload: Record<string, unknown> | null;
  created_at: Date | string;
};

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function detailStringArray(details: Record<string, unknown> | null, key: string): string[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'Masked';
  const digits = phone.replace(/\D/g, '');

  if (digits.length < 10) {
    return 'Masked';
  }

  const country = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '';
  const area = digits.slice(-10, -7);
  const last = digits.slice(-4);
  return `${country}${area} *** ${last}`;
}

// Masks a legal name to a privacy-safe alias (first name + last initial), e.g.
// "Carlos Mendoza" -> "Carlos M." — the name equivalent of maskPhone/maskEmail.
// The console never shows the full name; the only contact an Inbox action
// reveals is a case's WhatsApp number (reveal_phone, recorded with a reason).
export function maskName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];

  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

export function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split('@');

  if (!local || !domain) {
    return undefined;
  }

  return `${local.slice(0, 1)}***@${domain}`;
}

/** S-<case_number> (K2.0), or undefined when the row has no number. */
export function caseRef(caseNumber: number | string | null | undefined): string | undefined {
  if (caseNumber === null || caseNumber === undefined) return undefined;
  const value = typeof caseNumber === 'number' ? caseNumber : Number(caseNumber);
  return Number.isSafeInteger(value) && value > 0 ? `S-${value}` : undefined;
}

export function mapAdminCaseEventRow(row: AdminCaseEventRow): AdminTimelineEvent {
  const title = detailString(row.payload, 'title') ?? row.event_type.replace(/_/g, ' ');
  const detail = detailString(row.payload, 'detail') ?? '';
  const piiReveal = row.payload?.piiReveal === true;

  return {
    id: row.id,
    at: asIso(row.created_at),
    actor: row.actor_type,
    title,
    detail,
    ...(piiReveal ? { piiReveal } : {}),
  };
}

export function mapAdminCaseRow(row: AdminCaseRow, events: AdminCaseEventRow[] = []): AdminCase {
  const details = row.details ?? {};
  // Subject name is MASKED by default (legal name is PII). Full name is only
  // returned by an audited reveal_pii action, mirroring phone/email masking.
  // A name kept in the case details is masked the same way.
  const subjectName = maskName(row.user_name)
    ?? maskName(row.employer_name)
    ?? maskName(detailString(details, 'subjectName'))
    ?? 'Unknown subject';
  const maskedEmail = maskEmail(row.user_email);

  return {
    id: row.id,
    caseNumber: caseRef(row.case_number) ?? detailString(details, 'caseNumber'),
    type: row.case_type as AdminCaseType,
    status: row.status as AdminCaseStatus,
    priority: row.priority,
    summary: row.summary,
    workerName: subjectName,
    workerLabel: detailString(details, 'workerLabel') ?? detailString(details, 'subjectLabel') ?? 'Subject',
    workerId: row.user_id ?? row.employer_id ?? 'unlinked',
    conversationId: row.conversation_id ?? detailString(details, 'conversationRef') ?? 'unlinked',
    employerName: maskName(row.employer_name),
    verificationType: detailString(details, 'subjectType') as AdminCase['verificationType'],
    assignedAdmin: row.assigned_admin_email ?? 'Unassigned',
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    statusChangedAt: asIso(row.status_changed_at),
    lastMessage: detailString(details, 'lastMessage') ?? '',
    maskedPhone: maskPhone(row.user_phone),
    ...(maskedEmail ? { maskedEmail } : {}),
    notes: detailStringArray(details, 'notes'),
    timeline: events.map(mapAdminCaseEventRow),
  };
}

type QueryClient = AuditQueryClient;

// The queue's row shape without the timeline. Shared by the paged queue and
// the dashboard's open-case preview so both map through mapAdminCaseRow.
const CASE_LIST_SELECT = `
  SELECT c.id, c.case_type, c.status, c.priority, c.user_id, c.conversation_id,
         c.employer_id, c.summary, c.details, c.created_at, c.updated_at, c.status_changed_at,
         c.case_number,
         au.admin_email AS assigned_admin_email,
         u.full_name AS user_name,
         u.phone AS user_phone,
         u.email AS user_email,
         employer.full_name AS employer_name
    FROM admin_cases c
    LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN users employer ON employer.id = c.employer_id`;

const OPEN_CASE_FILTER = `c.status NOT IN ('resolved', 'dismissed')`;
const CLOSED_CASE_FILTER = `c.status IN ('resolved', 'dismissed')`;

// Queue order (roadmap 2d): waiting on us (open, pending admin), then waiting on
// the worker, then closed. Open cases: highest priority first, then the longest
// time in their current status. Closed cases: most recently closed first. id
// breaks ties so the order is stable. Shared by /cases and the Home preview.
export const CASE_QUEUE_ORDER = `
  ORDER BY CASE
             WHEN ${CLOSED_CASE_FILTER} THEN 2
             WHEN c.status = 'pending_worker' THEN 1
             ELSE 0
           END,
           CASE WHEN ${OPEN_CASE_FILTER} THEN c.priority END DESC,
           CASE WHEN ${OPEN_CASE_FILTER} THEN c.status_changed_at END,
           CASE WHEN ${CLOSED_CASE_FILTER} THEN c.status_changed_at END DESC,
           c.id`;

// The dashboard previews this many open cases and lockouts.
export const DASHBOARD_PREVIEW_SIZE = 3;

export type AdminDashboard = {
  openByWait: OpenCasesByWait;
  openCases: AdminCase[];
  revealCount: number;
  lockedOutCount: number;
  stuckCount: number;
  recentLockouts: IdentityLockout[];
};

/** The people a set of cases is about: each case's worker and employer. */
export function caseSubjectIds(rows: Pick<AdminCaseRow, 'user_id' | 'employer_id'>[]): string[] {
  return rows.flatMap((row) => [row.user_id, row.employer_id]).filter((id): id is string => Boolean(id));
}

// Home's Open cases tile and "Open cases by wait" card (roadmap 2d): open cases
// by who they wait on and by time in their current status. Buckets of
// now() - status_changed_at: [0, 24 h), [24 h, 72 h), [72 h, 168 h), [168 h, ∞);
// a time ahead of the clock falls in the first. Bucket ids are case-aging.ts's.
export const OPEN_CASES_BY_WAIT_SQL = `
  SELECT CASE WHEN c.status = 'pending_worker' THEN 'worker' ELSE 'us' END AS waiting_on,
         CASE
           WHEN now() - c.status_changed_at < interval '24 hours' THEN 'under_1d'
           WHEN now() - c.status_changed_at < interval '72 hours' THEN 'days_1_3'
           WHEN now() - c.status_changed_at < interval '168 hours' THEN 'days_3_7'
           ELSE 'over_7d'
         END AS bucket,
         COUNT(*) AS count
    FROM admin_cases c
   WHERE ${OPEN_CASE_FILTER}
   GROUP BY 1, 2`;

export type OpenCasesByWaitRow = { waiting_on: string; bucket: string; count: string };

// Zero-fills the cells the grouped query leaves out; an unknown id is an error.
export function mapOpenCasesByWaitRows(rows: OpenCasesByWaitRow[]): OpenCasesByWait {
  const byWait: OpenCasesByWait = {
    us: { under_1d: 0, days_1_3: 0, days_3_7: 0, over_7d: 0 },
    worker: { under_1d: 0, days_1_3: 0, days_3_7: 0, over_7d: 0 },
  };

  for (const row of rows) {
    if (row.waiting_on !== 'us' && row.waiting_on !== 'worker') {
      throw new Error(`Unexpected waiting_on: ${row.waiting_on}`);
    }
    const counts = byWait[row.waiting_on];
    if (!Object.hasOwn(counts, row.bucket)) {
      throw new Error(`Unexpected wait bucket: ${row.bucket}`);
    }
    counts[row.bucket as keyof typeof counts] = parseInt(row.count, 10);
  }

  return byWait;
}

export async function countOpenCasesByWait(client: QueryClient): Promise<OpenCasesByWait> {
  const result = await client.query<OpenCasesByWaitRow>(OPEN_CASES_BY_WAIT_SQL);
  return mapOpenCasesByWaitRows(result.rows);
}

// Open cases in queue order. Queried directly so closed rows can never crowd
// open ones out of a fixed-size page.
export async function listOpenAdminCaseRows(client: QueryClient, limit: number): Promise<AdminCaseRow[]> {
  const result = await client.query<AdminCaseRow>(
    `${CASE_LIST_SELECT}
      WHERE ${OPEN_CASE_FILTER}
      ${CASE_QUEUE_ORDER}
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * The dashboard. Two records in the one transaction, sharing the
 * request id: the open cases shown with their subjects, and the lockouts
 * shown. The counts are aggregates and name no one. A read that fails
 * records a failed attempt once its client is released.
 */
export async function loadAdminDashboard(session: AdminSession): Promise<AdminDashboard> {
  try {
    return await withAdminReadTransaction(session, async (client) => {
      const openByWait = await countOpenCasesByWait(client);
      const openRows = await listOpenAdminCaseRows(client, DASHBOARD_PREVIEW_SIZE);
      const revealCount = await countRecentReveals(client, REVEAL_TILE_DAYS);
      const lockouts = await listIdentityLockouts(client);
      const lockedOut = lockouts.filter((item) => item.kind === 'lockout');
      // Sliced here so the recorded ids and the rendered rows are one array.
      const recentLockouts = lockedOut.slice(0, DASHBOARD_PREVIEW_SIZE);

      await recordAdminAccess(session, {
        surface: 'admin.dashboard',
        categories: ['cases'],
        subjectUserIds: caseSubjectIds(openRows),
        recordType: 'admin_case',
        recordIds: openRows.map((row) => row.id),
      }, client);
      await recordAdminAccess(session, {
        surface: 'admin.dashboard',
        categories: ['verifications'],
        recordType: 'identity_challenge',
        recordIds: recentLockouts.map((item) => item.challengeId),
      }, client);

      return {
        openByWait,
        openCases: openRows.map((row) => mapAdminCaseRow(row)),
        revealCount,
        lockedOutCount: lockedOut.length,
        stuckCount: lockouts.length - lockedOut.length,
        recentLockouts,
      };
    });
  } catch (error) {
    await recordAdminAttempt(session, {
      surface: 'admin.dashboard',
      categories: ['cases', 'verifications'],
      outcome: 'failed',
    });
    throw error;
  }
}
