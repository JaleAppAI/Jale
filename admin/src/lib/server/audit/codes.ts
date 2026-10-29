// Audit code lists for the admin dashboard, mirrored from the audit storage
// interface (infra/db/access/AUDIT.md). jale_audit.record_event validates the
// same lists, so a code missing here is a code the database would refuse.

export const AUDIT_CATEGORIES = [
  'application_answers',
  'contact_details',
  'documents',
  'trust_assessments',
  'conversations',
  'profile',
  'posts',
  'saved_application_details',
  'cases',
  'verifications',
  'analytics',
  'billing',
  // Only for viewing the access history itself.
  'audit_history',
  'problem_reports',
  // Admin session events and session revocation.
  'admin_access',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_RECORD_TYPES = [
  'job_application',
  'worker_document',
  'worker_post',
  'job_conversation',
  'admin_case',
  'identity_challenge',
  // users.id
  'user',
  'problem_report',
  // admin_users.id
  'admin_user',
] as const;
export type AuditRecordType = (typeof AUDIT_RECORD_TYPES)[number];

export const AUDIT_PURPOSE_KINDS = ['job', 'case', 'verification', 'reveal', 'self', 'audit_review'] as const;
export type AuditPurposeKind = (typeof AUDIT_PURPOSE_KINDS)[number];

export type AuditKind = 'read' | 'attempt' | 'session' | 'action';
export type AttemptOutcome = 'denied' | 'not_found' | 'failed';
export type SessionOutcome = 'signed_in' | 'sign_in_rejected' | 'signed_out' | 'expired' | 'revoked';

/** Every event outcome, in the order jale_audit.history_search lists them. */
export const AUDIT_OUTCOMES = [
  'allowed',
  'denied',
  'not_found',
  'failed',
  'signed_in',
  'sign_in_rejected',
  'signed_out',
  'expired',
  'revoked',
  'done',
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Every place in the admin dashboard that records an event. A surface not
 * listed here is refused before anything is written.
 */
export const ADMIN_SURFACES = [
  // Pages.
  'admin.dashboard',
  'admin.cases_list',
  'admin.case_detail',
  'admin.lockouts',
  'admin.analytics_paying_employers',
  'admin.analytics_companies',
  'admin.analytics_company_members',
  'admin.analytics_slowest_employers',
  'admin.analytics_stale_jobs',
  'admin.access_history',
  // Case actions.
  'admin.case_detail.reveal',
  'admin.case_detail.request_more_info',
  'admin.case_detail.resolve_case',
  'admin.case_detail.reply_whatsapp',
  // Sign-in, sign-out, expiry, and revoking an admin's sessions.
  'admin.session',
  'admin.sessions_revoke',
  // The problem-report inbox.
  'admin.reports_list',
  'admin.report_detail',
  'admin.report_contact_reveal',
  'admin.report_screenshot',
  'admin.report_status',
  'admin.report_note',
  'admin.report_settings',
  // The Admins page and its actions (sprint 28, K1).
  'admin.admins_list',
  'admin.admin_invite',
  'admin.admin_resend_invite',
  'admin.admin_role_change',
  'admin.admin_deactivate',
  'admin.admin_reactivate',
  // The Inbox, the support conversation, lockout detail, and their actions
  // (sprint 28, K2).
  'admin.inbox',
  'admin.support_conversation',
  'admin.lockout_detail',
  'admin.inbox.reply',
  'admin.inbox.request_info',
  'admin.inbox.resolve',
  'admin.inbox.reveal_phone',
  'admin.inbox.open_media',
  'admin.inbox.reset_lockout',
  'admin.inbox.open_support',
] as const;
export type AdminSurface = (typeof ADMIN_SURFACES)[number];

export const AUDIT_CHANNEL = 'admin';
export const MAX_IDS_PER_EVENT = 500;
export const MAX_FIELD_NAMES = 100;
export const MAX_CATEGORIES = 8;
export const MAX_REASON_LENGTH = 500;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SURFACE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** The jale_audit.record_event payload, keys in their canonical order. */
export type AuditEventPayload = {
  kind: AuditKind;
  outcome: string;
  actor_kind: 'admin' | 'anonymous';
  actor_id?: string;
  actor_role?: string;
  actor_session?: string;
  channel: typeof AUDIT_CHANNEL;
  surface: AdminSurface;
  categories: AuditCategory[];
  subject_user_ids: string[];
  record_type?: AuditRecordType;
  record_ids: string[];
  result_count: number;
  field_names: string[];
  purpose_kind?: AuditPurposeKind;
  purpose_id?: string;
  reason?: string;
  link_expires_at?: string;
  part?: number;
  parts?: number;
  request_id: string;
};
