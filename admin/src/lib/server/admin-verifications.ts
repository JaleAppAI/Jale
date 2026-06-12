import { getAdminDbPool } from './db';
import { maskEmail, maskPhone, maskName } from './admin-cases';
import type { VerificationRecord } from '../types';

export type VerificationCaseRow = {
  id: string;
  status: string;
  summary: string;
  details: Record<string, unknown> | null;
  updated_at: Date | string;
  assigned_admin_email: string | null;
  user_name: string | null;
  user_phone: string | null;
  user_email: string | null;
};

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function verificationStatus(rowStatus: string, details: Record<string, unknown> | null): VerificationRecord['status'] {
  const explicit = detailString(details, 'verificationStatus');
  const allowed: VerificationRecord['status'][] = ['pending', 'approved', 'rejected', 'needs_more_info', 'reset'];

  if (allowed.includes(explicit as VerificationRecord['status'])) {
    return explicit as VerificationRecord['status'];
  }

  if (rowStatus === 'resolved') return 'approved';
  if (rowStatus === 'dismissed') return 'rejected';
  if (rowStatus === 'pending_worker') return 'needs_more_info';
  return 'pending';
}

function verificationStep(details: Record<string, unknown> | null): VerificationRecord['step'] {
  const explicit = detailString(details, 'verificationStep');
  const allowed: VerificationRecord['step'][] = ['identity', 'phone', 'account', 'docs'];

  return allowed.includes(explicit as VerificationRecord['step'])
    ? explicit as VerificationRecord['step']
    : 'account';
}

export function mapVerificationCaseRow(row: VerificationCaseRow): VerificationRecord {
  const details = row.details ?? {};
  const subjectType = detailString(details, 'subjectType') === 'employer' ? 'employer' : 'worker';
  const maskedEmail = maskEmail(row.user_email);

  return {
    id: row.id,
    subjectType,
    subjectName: detailString(details, 'subjectName') ?? maskName(row.user_name) ?? row.summary,
    subjectLabel: detailString(details, 'subjectLabel') ?? `${subjectType} verification`,
    status: verificationStatus(row.status, details),
    step: verificationStep(details),
    reason: detailString(details, 'reason') ?? row.summary,
    updatedAt: asIso(row.updated_at),
    assignedAdmin: row.assigned_admin_email ?? 'Unassigned',
    maskedPhone: row.user_phone ? maskPhone(row.user_phone) : undefined,
    ...(maskedEmail ? { maskedEmail } : {}),
  };
}

// Default page size for the verification queue. Served by the partial index
// idx_admin_cases_verification_queue (migration 025).
export const VERIFICATIONS_PAGE_SIZE = 200;

export type VerificationRecordList = {
  rows: VerificationRecord[];
  totalCount: number;
};

export async function listVerificationRecords(limit: number = VERIFICATIONS_PAGE_SIZE): Promise<VerificationRecordList> {
  const pool = await getAdminDbPool();
  const [result, countResult] = await Promise.all([
    pool.query<VerificationCaseRow>(
      `SELECT c.id, c.status, c.summary, c.details, c.updated_at,
              au.admin_email AS assigned_admin_email,
              u.full_name AS user_name,
              u.phone AS user_phone,
              u.email AS user_email
         FROM admin_cases c
         LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
         LEFT JOIN users u ON u.id = COALESCE(c.user_id, c.employer_id)
        WHERE c.case_type = 'verification_blocker'
        ORDER BY c.status, c.priority DESC, c.updated_at DESC
        LIMIT $1`,
      [limit],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM admin_cases WHERE case_type = 'verification_blocker'`,
    ),
  ]);

  return {
    rows: result.rows.map(mapVerificationCaseRow),
    totalCount: parseInt(countResult.rows[0]?.count ?? '0', 10),
  };
}

export async function getVerificationRecord(id: string): Promise<VerificationRecord | undefined> {
  const pool = await getAdminDbPool();
  const result = await pool.query<VerificationCaseRow>(
    `SELECT c.id, c.status, c.summary, c.details, c.updated_at,
            au.admin_email AS assigned_admin_email,
            u.full_name AS user_name,
            u.phone AS user_phone,
            u.email AS user_email
       FROM admin_cases c
       LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
       LEFT JOIN users u ON u.id = COALESCE(c.user_id, c.employer_id)
      WHERE c.id = $1 AND c.case_type = 'verification_blocker'
      LIMIT 1`,
    [id],
  );

  return result.rows[0] ? mapVerificationCaseRow(result.rows[0]) : undefined;
}
