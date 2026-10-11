/**
 * audit-events.ts -- fixtures for the audit storage suites (migration 109).
 *
 * Every value here is synthetic: fixed, obviously fake UUIDs and codes from
 * the audit code lists (infra/db/access/AUDIT.md). Nothing resembles a real
 * person, number or address.
 */
import { randomBytes } from 'crypto';

/** A fixed, obviously synthetic UUID: `00000000-0000-4000-8000-<12 hex>`. */
export function fakeUuid(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffffffff) throw new Error('fakeUuid: out of range');
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/**
 * A synthetic UUID unique to this run, in the same obviously fake shape
 * (`00000000-0000-4xxx-8xxx-xxxxxxxxxxxx`), for suites whose filters must not
 * match rows another suite wrote.
 */
export function syntheticUuid(): string {
  const hex = randomBytes(9).toString('hex');
  return `00000000-0000-4${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(6, 18)}`;
}

/** The code lists record_event accepts. */
export const AUDIT_CODES = {
  kinds: ['read', 'attempt', 'session', 'action'],
  outcomes: {
    read: ['allowed'],
    attempt: ['denied', 'not_found', 'failed'],
    session: ['signed_in', 'sign_in_rejected', 'signed_out', 'expired', 'revoked'],
    action: ['done'],
  },
  actorKinds: ['worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous'],
  adminRoles: ['admin_readonly', 'admin_ops', 'admin_superadmin'],
  channels: ['web', 'whatsapp', 'admin'],
  categories: [
    'application_answers', 'contact_details', 'documents', 'trust_assessments', 'conversations',
    'profile', 'posts', 'saved_application_details', 'cases', 'verifications', 'analytics',
    'billing', 'audit_history', 'problem_reports', 'admin_access',
  ],
  recordTypes: [
    'job_application', 'worker_document', 'worker_post', 'job_conversation', 'admin_case',
    'identity_challenge', 'user', 'problem_report', 'admin_user',
  ],
  purposes: ['job', 'case', 'verification', 'reveal', 'self', 'audit_review'],
} as const;

export type AuditEvent = Record<string, unknown>;

/** An employer reading one worker's profile for a job: the employer.worker_profile shape. */
export function employerReadEvent(overrides: AuditEvent = {}): AuditEvent {
  return {
    kind: 'read',
    outcome: 'allowed',
    actor_kind: 'employer',
    actor_id: fakeUuid(0xe1),
    channel: 'web',
    surface: 'employer.worker_profile',
    categories: ['profile', 'contact_details'],
    subject_user_ids: [fakeUuid(0xa1)],
    record_type: 'job_application',
    record_ids: [fakeUuid(0xb1)],
    result_count: 1,
    field_names: ['full_name', 'phone'],
    purpose_kind: 'job',
    purpose_id: fakeUuid(0xc1),
    request_id: 'test-request-0001',
    ...overrides,
  };
}

/** An admin revealing a case subject's contact details, with a reason. */
export function adminRevealEvent(overrides: AuditEvent = {}): AuditEvent {
  return {
    kind: 'read',
    outcome: 'allowed',
    actor_kind: 'admin',
    actor_id: fakeUuid(0xd1),
    actor_role: 'admin_ops',
    actor_session: fakeUuid(0xd2),
    channel: 'admin',
    surface: 'admin.case_detail.reveal',
    categories: ['contact_details'],
    subject_user_ids: [fakeUuid(0xa2)],
    record_type: 'admin_case',
    record_ids: [fakeUuid(0xf1)],
    result_count: 1,
    field_names: ['phone', 'email'],
    purpose_kind: 'reveal',
    reason: 'Synthetic test justification for a support callback.',
    ...overrides,
  };
}

/** A tokenized document upload refused: no actor id. */
export function tokenHolderAttemptEvent(overrides: AuditEvent = {}): AuditEvent {
  return {
    kind: 'attempt',
    outcome: 'denied',
    actor_kind: 'token_holder',
    channel: 'web',
    surface: 'worker.document_upload',
    categories: ['documents'],
    result_count: 0,
    ...overrides,
  };
}

/** Removes keys from an event (to build "missing key" cases). */
export function without(event: AuditEvent, ...keys: string[]): AuditEvent {
  const copy = { ...event };
  for (const key of keys) delete copy[key];
  return copy;
}
