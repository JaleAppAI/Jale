/**
 * Code lists for the access and change records, and the request-side surface
 * registry.
 *
 * The code lists mirror what `jale_audit.record_event` and the change-record
 * triggers accept (infra/db/access/AUDIT.md). A value outside them is refused
 * by the database, so the types here keep a typo from ever reaching a request.
 *
 * ACCESS_SURFACES names every API handler that records the personal data it
 * returns, with the categories and record type of that read. The coverage
 * check (test/unit/lambda/audit-coverage.test.ts) holds every API handler
 * that selects personal data to this registry or to its exclusion list.
 *
 * CHANGE_SURFACES names the units of work that state their actor before they
 * write a table in the change log (infra/db/access/audit-change-log.json).
 * The writer check (test/unit/lambda/audit-writers.test.ts) holds every
 * Lambda that reaches such a write to a setAuditContext call or to its
 * exclusion list.
 */

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
  'audit_history',
  'problem_reports',
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
  'user',
  'problem_report',
  'admin_user',
] as const;
export type AuditRecordType = (typeof AUDIT_RECORD_TYPES)[number];

export const AUDIT_PURPOSE_KINDS = ['job', 'case', 'verification', 'reveal', 'self', 'audit_review'] as const;
export type AuditPurposeKind = (typeof AUDIT_PURPOSE_KINDS)[number];

/** A job or case purpose names its job or case; no other purpose carries an id. */
export type AuditPurpose =
  | { kind: 'job' | 'case'; id: string }
  | { kind: 'verification' | 'reveal' | 'self' | 'audit_review' };

export const AUDIT_ACTOR_KINDS = ['worker', 'employer', 'admin', 'platform', 'token_holder', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** Request code never acts as an admin; the admin dashboard has its own helper. */
export const REQUEST_CHANNELS = ['web', 'whatsapp'] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export const MAX_IDS_PER_PART = 500;
export const MAX_FIELD_NAMES = 100;

export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SURFACE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export interface AccessSurfaceEntry {
  /** Handler modules, relative to infra/lambda. */
  readonly handlers: readonly string[];
  readonly categories: readonly AuditCategory[];
  /** What `record_ids` holds for this surface; null when it holds nothing. */
  readonly recordType: AuditRecordType | null;
}

/** Every request surface that records access. */
export const ACCESS_SURFACES = {
  'employer.worker_profile': {
    handlers: ['api/employer-worker-profile.ts'],
    categories: ['profile', 'contact_details', 'application_answers', 'trust_assessments'],
    recordType: 'job_application',
  },
  'employer.worker_documents': {
    handlers: ['api/employer-worker-docs.ts'],
    categories: ['documents'],
    recordType: 'worker_document',
  },
  'employer.worker_posts': {
    handlers: ['api/employer-worker-posts.ts'],
    categories: ['posts'],
    recordType: 'worker_post',
  },
  'employer.job_applicants': {
    handlers: ['api/employer-job-applicants.ts'],
    categories: ['contact_details', 'application_answers', 'profile'],
    recordType: 'job_application',
  },
  'employer.job_candidates': {
    handlers: ['api/employer-job-candidates.ts'],
    categories: ['contact_details', 'profile', 'trust_assessments'],
    recordType: 'user',
  },
  'employer.applicants_overview': {
    handlers: ['api/employer-applicants-overview.ts'],
    // details_status is derived from the application answers and the job's
    // document records, so both are named although only the status is returned.
    categories: ['profile', 'trust_assessments', 'application_answers', 'documents'],
    recordType: 'job_application',
  },
  'employer.inbox': {
    handlers: ['api/employer-inbox.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  'employer.conversations_list': {
    handlers: ['api/employer-conversations-list.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  'employer.conversation_detail': {
    handlers: ['api/employer-conversations-detail.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  // The writes whose response carries the thread.
  'employer.conversation_create': {
    handlers: ['api/employer-conversations-create.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  'employer.conversation_send': {
    handlers: ['api/employer-conversations-send.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  'employer.conversation_update': {
    handlers: ['api/employer-conversations-update.ts'],
    categories: ['conversations'],
    recordType: 'job_conversation',
  },
  'worker.application_defaults': {
    handlers: ['api/worker-application-defaults-get.ts'],
    categories: ['saved_application_details'],
    recordType: null,
  },
  'worker.vault': {
    handlers: ['api/worker-documents-list.ts'],
    categories: ['documents'],
    recordType: 'worker_document',
  },
  'worker.application_details': {
    handlers: ['api/worker-application-details.ts'],
    categories: ['saved_application_details', 'application_answers'],
    recordType: 'job_application',
  },
} as const satisfies Record<string, AccessSurfaceEntry>;
export type AccessSurface = keyof typeof ACCESS_SURFACES;

/**
 * Units of work that write a change-log table, by surface. A request that
 * also records access uses its access surface for both records.
 */
export const CHANGE_SURFACES = [
  // Workers and employers on the web, signed in.
  'worker.application_details',
  'worker.profile_update',
  'worker.job_apply',
  'worker.document_confirm',
  'worker.document_delete',
  'worker.post_create',
  'worker.post_delete',
  'worker.onboarding',
  'employer.profile_update',
  'employer.job_delete',
  'employer.upload_link',
  'employer.billing_checkout',
  // Whoever holds a document upload link.
  'token_holder.document_confirm',
  'token_holder.document_submit',
  // People whose identity is not verified yet.
  'auth.worker_web_signup',
  'auth.post_confirmation',
  // The WhatsApp engine: a worker's message, and platform work on the shared engine login.
  'whatsapp.inbound',
  'whatsapp.ai_profile',
  'whatsapp.admin_outbox',
  'whatsapp.status_callback',
] as const;
export type ChangeSurface = (typeof CHANGE_SURFACES)[number];

export type AuditSurface = AccessSurface | ChangeSurface;

export function isAccessSurface(value: string): value is AccessSurface {
  return Object.prototype.hasOwnProperty.call(ACCESS_SURFACES, value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
