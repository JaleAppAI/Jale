import { getAdminDbPool } from './db';
import type { AdminCase, AdminCaseStatus, AdminCaseType, AdminTimelineEvent } from '../types';

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
// The full name is exposed ONLY through an audited reveal_pii action
// (revealCaseContact), never in the default list/detail read path.
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
  const subjectName = maskName(row.user_name)
    ?? maskName(row.employer_name)
    ?? detailString(details, 'subjectName')
    ?? 'Unknown subject';
  const maskedEmail = maskEmail(row.user_email);

  return {
    id: row.id,
    caseNumber: detailString(details, 'caseNumber'),
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
    lastMessage: detailString(details, 'lastMessage') ?? '',
    maskedPhone: maskPhone(row.user_phone),
    ...(maskedEmail ? { maskedEmail } : {}),
    notes: detailStringArray(details, 'notes'),
    timeline: events.map(mapAdminCaseEventRow),
  };
}

async function listEventsForCases(caseIds: string[]): Promise<Map<string, AdminCaseEventRow[]>> {
  if (caseIds.length === 0) {
    return new Map();
  }

  const pool = await getAdminDbPool();
  const result = await pool.query<AdminCaseEventRow & { case_id: string }>(
    `SELECT id, case_id, event_type, actor_type, payload, created_at
       FROM admin_case_events
      WHERE case_id = ANY($1::uuid[])
      ORDER BY created_at DESC`,
    [caseIds],
  );
  const byCase = new Map<string, AdminCaseEventRow[]>();

  for (const row of result.rows) {
    byCase.set(row.case_id, [...(byCase.get(row.case_id) ?? []), row]);
  }

  return byCase;
}

// Default page size for queue list reads. Bounds memory/render cost so the
// queue stays responsive as admin_cases grows; detail pages load single rows.
export const ADMIN_CASES_PAGE_SIZE = 200;

export async function listAdminCases(limit: number = ADMIN_CASES_PAGE_SIZE): Promise<AdminCase[]> {
  const pool = await getAdminDbPool();
  // The queue list and dashboard render case metadata only — never the
  // timeline — so we do NOT fetch admin_case_events here (only getAdminCase
  // does). Bounded by LIMIT to avoid unbounded scans at scale.
  const result = await pool.query<AdminCaseRow>(
    `SELECT c.id, c.case_type, c.status, c.priority, c.user_id, c.conversation_id,
            c.employer_id, c.summary, c.details, c.created_at, c.updated_at,
            au.admin_email AS assigned_admin_email,
            u.full_name AS user_name,
            u.phone AS user_phone,
            u.email AS user_email,
            employer.full_name AS employer_name
       FROM admin_cases c
       LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users employer ON employer.id = c.employer_id
      ORDER BY c.status, c.priority DESC, c.created_at DESC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => mapAdminCaseRow(row));
}

export async function getAdminCase(id: string): Promise<AdminCase | undefined> {
  const pool = await getAdminDbPool();
  const result = await pool.query<AdminCaseRow>(
    `SELECT c.id, c.case_type, c.status, c.priority, c.user_id, c.conversation_id,
            c.employer_id, c.summary, c.details, c.created_at, c.updated_at,
            au.admin_email AS assigned_admin_email,
            u.full_name AS user_name,
            u.phone AS user_phone,
            u.email AS user_email,
            employer.full_name AS employer_name
       FROM admin_cases c
       LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN users employer ON employer.id = c.employer_id
      WHERE c.id = $1
      LIMIT 1`,
    [id],
  );
  const row = result.rows[0];

  if (!row) {
    return undefined;
  }

  const events = await listEventsForCases([row.id]);
  return mapAdminCaseRow(row, events.get(row.id));
}

export type RevealedContact = {
  name?: string;
  phone?: string;
  email?: string;
};

type QueryClient = { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

type ContactRow = { full_name: string | null; phone: string | null; email: string | null };

function toRevealedContact(row: ContactRow | undefined): RevealedContact {
  if (!row) return {};
  return {
    ...(row.full_name ? { name: row.full_name } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.email ? { email: row.email } : {}),
  };
}

// Raw, UNMASKED contact lookup for an audited reveal_pii action. MUST be called
// only after the pii_reveal audit row has been written in the same transaction.
// Returns only the case subject's identity columns the console role is granted.
export async function revealCaseContact(client: QueryClient, caseId: string): Promise<RevealedContact> {
  const result = await client.query<ContactRow>(
    `SELECT u.full_name, u.phone, u.email
       FROM admin_cases c
       JOIN users u ON u.id = COALESCE(c.user_id, c.employer_id)
      WHERE c.id = $1
      LIMIT 1`,
    [caseId],
  );

  return toRevealedContact(result.rows[0]);
}
