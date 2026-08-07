import { apiFetch } from '../api';
import type { ScoreBand } from '../match';
import type { ApplicationStatus, JobStatus, WritableJobStatus } from '../status';
export type { ApplicationStatus } from '../status';

// ---------------------------------------------------------------------------
// Typed API errors
//
// Preserves HTTP status, a provider-safe error code (the backend's `error`
// field — a stable string, never a raw provider/exception message), and an
// allowlisted set of extra payload fields the backend is known to attach to
// specific error codes (e.g. job_limit_reached's plan/limit info). Anything
// outside the allowlist is dropped so we never leak unexpected server detail
// into the UI.
// ---------------------------------------------------------------------------

export type ApiErrorPayload = {
  plan_code?: string;
  active_job_limit?: number;
  active_jobs?: number;
  requiredVersion?: string;
  currentVersion?: string;
  required?: string[];
};

const ALLOWED_PAYLOAD_KEYS = [
  'plan_code',
  'active_job_limit',
  'active_jobs',
  'requiredVersion',
  'currentVersion',
  'required',
] as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: ApiErrorPayload;

  constructor(status: number, code: string, payload: ApiErrorPayload = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function parseApiError(res: Response, fallbackCode: string): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — fall back to the generic code below.
  }
  const code = typeof body.error === 'string' ? body.error : fallbackCode;
  const payload: ApiErrorPayload = {};
  for (const key of ALLOWED_PAYLOAD_KEYS) {
    const value = body[key];
    if (value !== undefined) {
      (payload as Record<string, unknown>)[key] = value;
    }
  }
  return new ApiError(res.status, code, payload);
}

// ---------------------------------------------------------------------------
// Idempotency keys
//
// One UUID per user-initiated mutation (e.g. "start checkout"), persisted in
// sessionStorage until a definitive response arrives. A retry of the same
// action (user clicks the button again after a transient failure) reuses the
// same key so the backend can dedupe — but ONLY if the retried request body
// is identical to the one the key was minted for. The stored payload is
// `{key, canonicalBody}` where `canonicalBody` is the canonical JSON request
// body. If a caller asks for a key with a body that doesn't match what's
// stored (or the stored value is a legacy bare UUID from before this change),
// the key is rotated: a fresh UUID is minted and the new canonical body is
// stored in its place. This matters because the request body here is
// rebuilt from `window.location` on every call (e.g. the locale-prefixed
// success/cancel URLs in the billing page) — reusing a key across a changed
// body would make the backend reject the retry with 409
// `idempotency_key_conflict` instead of treating it as the same operation.
// A definitive response (success, or a terminal validation/auth/not-found
// error) still clears the key so the *next* distinct action gets a fresh one.
// ---------------------------------------------------------------------------

const IDEMPOTENCY_STORAGE_PREFIX = 'jale.idempotency.';

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older browsers).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively so
 * that two calls building the "same" body in a different key order (or a
 * different property insertion order) serialize identically. Arrays keep their
 * order (order is semantically meaningful there).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

type StoredIdempotency = { key: string; canonicalBody: string };

function parseStoredIdempotency(raw: string): StoredIdempotency | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' &&
      typeof parsed.key === 'string' && typeof parsed.canonicalBody === 'string'
    ) {
      return parsed as StoredIdempotency;
    }
  } catch {
    // Not JSON — likely a legacy bare-UUID value from before this change.
  }
  return null;
}

/**
 * Returns the idempotency key to send for `action`, given the exact request
 * `body` about to be sent. Reuses the previously stored key only if its
 * recorded canonical body matches this body; otherwise (including legacy bare-UUID
 * values, or no stored value at all) mints and stores a fresh key.
 */
export function getIdempotencyKey(action: string, body: unknown): string {
  const canonicalBody = canonicalJson(body);
  if (typeof window === 'undefined') return randomUuid();
  const storageKey = `${IDEMPOTENCY_STORAGE_PREFIX}${action}`;
  const raw = window.sessionStorage.getItem(storageKey);
  if (raw) {
    const stored = parseStoredIdempotency(raw);
    if (stored && stored.canonicalBody === canonicalBody) return stored.key;
  }
  const key = randomUuid();
  window.sessionStorage.setItem(storageKey, JSON.stringify({ key, canonicalBody }));
  return key;
}

export function clearIdempotencyKey(action: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(`${IDEMPOTENCY_STORAGE_PREFIX}${action}`);
}

/**
 * Whether an API response is a "definitive" outcome for idempotency-key
 * purposes: success, or a terminal failure the backend has recorded as dead
 * (so a fresh key is needed next attempt). A retry MUST resume the same
 * operation (key retained) rather than start a new one when the backend's
 * operation record is still live: 503 (`provider_retryable` — backend
 * explicitly marks the operation non-terminal, see `stripeErrorCode()` in
 * `infra/lambda/billing/checkout.ts`), plain 500 (unclassified/internal —
 * indeterminate, safest to keep the key rather than risk a duplicate Stripe
 * call), and 409 `operation_in_progress` (the backend's `billing_operations`
 * row is still leased/pending — see `prepareCheckoutOperation()` in
 * `infra/lambda/lib/billing-operations.ts` ~line 123 and ~line 174 — retrying
 * with a *new* key would race a second Stripe session against the live one).
 * Everything else is definitive and clears the key: 2xx success; 502
 * `provider_error` (recorded terminal=true server-side); and every other 4xx
 * the backend treats as terminal — validation errors (`invalid_plan`,
 * `invalid_idempotency_key`, `invalid_json`, `missing_fields`,
 * `invalid_return_origin`), `idempotency_key_conflict` (same key reused with
 * a different request body — a fresh key is required), `subscription_already_current`,
 * `user_not_provisioned`, `employer_required`, and `legal_required`.
 *
 * A non-`ApiError` (network failure, etc.) is treated as indeterminate —
 * same as 500 — so the key is retained.
 */
export function isDefinitiveError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const { status, code } = err;
  if (status >= 200 && status < 300) return true;
  if (status === 503 || status === 500) return false;
  if (status === 409 && code === 'operation_in_progress') return false;
  return true;
}

export type Job = {
  id: string;
  title: string;
  location: string;
  city?: string | null;
  state_region?: string | null;
  pay: string | null;
  job_type: 'full-time' | 'part-time' | 'contract';
  status: JobStatus;
  applicant_count: number;
  hired_count: number;
  open_count: number;
  pay_min: number | null;
  pay_max: number | null;
  pay_interval: string | null;
  start_date: string | null;
  expected_duration: string | null;
  shift_schedule: string | null;
  transportation_required: boolean;
  work_authorization_required: boolean;
  language_preference: Array<'any' | 'en' | 'es'>;
  number_of_workers_needed: number;
  trade_category: 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'drywall' | 'general_labor' | 'other' | null;
  required_experience_years: number | null;
  required_experience_months: number | null;
  certifications: string[];
  created_at: string;
};

export type EmployerJobDetail = Job & {
  description: string | null;
  required_docs: Array<'resume' | 'driver_license'>;
  /** Short code for the public job page URL (/j/{public_code}). */
  public_code: string;
  /** The employer's opt-IN to a public job page. Default false (migration 057). */
  public_listing_enabled: boolean;
};

export type Applicant = {
  application_id: string;
  worker_id: string;
  full_name: string | null;
  phone: string | null;
  status: ApplicationStatus;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | null;
  location: string | null;
};

export type ApplicantFilters = {
  status?: string;
  skills?: string;
  availability?: string;
  min_experience?: number;
};

export type RankingStatus = 'deterministic' | 'llm_cached';
export type RankingVersion = 'sql-v1' | 'llm-v1';

export type EmployerCandidate = {
  application_id: string;
  worker_id: string;
  display_name: string;
  phone: string | null;
  status: string;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | string | null;
  location: string | null;
  trust_score: number | null;
  match_score: number;
  score_band: ScoreBand;
  match_reasons: string[];
};

export type EmployerCandidatesResponse = {
  ranking_status: RankingStatus;
  ranking_version: RankingVersion;
  candidates: EmployerCandidate[];
  total: number;
  computed_at: string;
};

export type EmployerConversationStatus = 'open' | 'closed';

export type EmployerConversationSummary = {
  id: string;
  job_id: string;
  job_title: string;
  worker_id: string;
  worker_name: string | null;
  status: EmployerConversationStatus;
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
  updated_at: string;
};

export type EmployerConversationDetail = EmployerConversationSummary & {
  application_id: string;
};

export type EmployerConversationMessage = {
  id: string;
  sender_type: 'employer' | 'worker' | 'system';
  direction: 'outbound' | 'inbound';
  body: string;
  status: 'queued' | 'waiting_worker_reply' | 'sent' | 'delivered' | 'failed' | 'received';
  created_at: string;
  sent_at: string | null;
};

export type EmployerConversationResponse = {
  conversation: EmployerConversationDetail;
  messages: EmployerConversationMessage[];
};

export type InboxTab = 'active' | 'closed';

export type InboxItem = {
  application_id: string;
  worker_id: string;
  worker_name: string | null;
  job_id: string;
  job_title: string;
  job_status: JobStatus;
  application_status: ApplicationStatus;
  applied_at: string;
  conversation_id: string | null;
  conversation_status: EmployerConversationStatus | null;
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
  tab: InboxTab;
};

export type InboxJob = {
  job_id: string;
  title: string;
  status: JobStatus;
};

export type EmployerInboxResponse = {
  items: InboxItem[];
  jobs: InboxJob[];
};

export type EmployerTrade = 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'other';
export type EmployerJobType = 'full-time' | 'part-time' | 'contract';
export type CompanySize = '1-10' | '11-50' | '51-200' | '200+';

export type EmployerProfileData = {
  id: string;
  user_type: 'employer';
  email: string;
  phone: string | null;
  full_name: string | null;
  tenant_id: string | null;
  created_at: string;
  company_name: string | null;
  contact_name: string | null;
  city: string | null;
  service_area: string | null;
  hiring_trades: EmployerTrade[];
  typical_job_types: EmployerJobType[];
  company_size: CompanySize | null;
  company_description: string | null;
};

export type EmployerProfilePatch = Partial<Pick<EmployerProfileData,
  'company_name' | 'contact_name' | 'phone' | 'city' | 'service_area' |
  'hiring_trades' | 'typical_job_types' | 'company_size' | 'company_description'
>>;

export async function getEmployerProfile(token: string): Promise<EmployerProfileData> {
  const res = await apiFetch('/employer/profile', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_fetch_failed');
  return res.json();
}

export async function updateEmployerProfile(
  token: string,
  patch: EmployerProfilePatch,
): Promise<EmployerProfileData> {
  const res = await apiFetch(
    '/employer/profile',
    { method: 'PATCH', body: JSON.stringify(patch) },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_update_failed');
  return res.json();
}

export async function getJobs(token: string): Promise<Job[]> {
  const res = await apiFetch('/employer/jobs', {}, token);
  if (!res.ok) throw new Error('fetch_failed');
  const data = await res.json();
  return data.jobs;
}

export type JobWritePayload = {
  title: string;
  location: string;
  /** `null` is an explicit clear-override (backend: resolveJobLocationFields);
   *  omitting the key entirely defers to the parsed location instead. */
  city?: string | null;
  state_region?: string | null;
  job_type: string;
  description?: string;
  required_docs?: string[];
  pay_min?: number | null;
  pay_max?: number | null;
  start_date?: string | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  transportation_required?: boolean;
  work_authorization_required?: boolean;
  language_preference?: Array<'any' | 'en' | 'es'>;
  number_of_workers_needed?: number;
  trade_category: string;
  required_experience_years?: number | null;
  pay_interval?: string | null;
  certifications?: string[];
};

export async function createJob(token: string, data: JobWritePayload): Promise<Job> {
  const res = await apiFetch('/employer/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw await parseApiError(res, 'create_failed');
  return res.json();
}

export async function getJob(token: string, jobId: string): Promise<EmployerJobDetail> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'fetch_failed');
  return res.json();
}

export async function updateJob(
  token: string,
  jobId: string,
  data: JobWritePayload,
): Promise<EmployerJobDetail> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify(data) }, token);
  if (!res.ok) throw await parseApiError(res, 'update_failed');
  return res.json();
}

/**
 * The employer's opt-IN to a public job page (migration 057). Strictly boolean:
 * publishing to the open internet is a consent action, and the API rejects any
 * coerced shape.
 */
export async function updateJobPublicListing(
  token: string,
  jobId: string,
  enabled: boolean,
): Promise<{ id: string; public_code: string; public_listing_enabled: boolean }> {
  const res = await apiFetch(`/employer/jobs/${jobId}/public-listing`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  }, token);
  if (!res.ok) throw await parseApiError(res, 'update_failed');
  return res.json();
}

/**
 * Mints (or refreshes) a trackable public share link for this job -- the only
 * link PublicListingCard ever shows the employer (the bare /j/{public_code}
 * URL is never displayed) -- for print/QR distribution (job fairs, flyers).
 * Requires the job's public-listing opt-in (migration 057); the endpoint
 * 404s (`job_not_found`) for a job that isn't published yet, and can 500
 * (`share_url_misconfigured`) if the share-link origin isn't configured.
 */
export async function shareEmployerJob(
  token: string,
  jobId: string,
): Promise<{ code: string; share_url: string }> {
  const res = await apiFetch(`/employer/jobs/${jobId}/share`, {
    method: 'POST',
    body: JSON.stringify({ channel: 'copy_link' }),
  }, token);
  if (!res.ok) throw await parseApiError(res, 'share_failed');
  return res.json();
}

export async function updateJobStatus(
  token: string,
  jobId: string,
  status: WritableJobStatus
): Promise<Job> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  }, token);
  if (!res.ok) throw new Error('update_failed');
  return res.json();
}

export async function deleteJob(token: string, jobId: string): Promise<void> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, { method: 'DELETE' }, token);
  if (!res.ok) throw await parseApiError(res, 'delete_failed');
}

export async function getJobApplicants(
  token: string,
  jobId: string,
  filters: ApplicantFilters = {}
): Promise<{ applicants: Applicant[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.skills) params.set('skills', filters.skills);
  if (filters.availability) params.set('availability', filters.availability);
  if (filters.min_experience !== undefined) {
    params.set('min_experience', String(filters.min_experience));
  }
  const qs = params.toString();
  const res = await apiFetch(
    `/employer/jobs/${jobId}/applicants${qs ? `?${qs}` : ''}`,
    {},
    token
  );
  if (!res.ok) throw new Error('fetch_failed');
  return res.json();
}

export async function getJobCandidates(
  token: string,
  jobId: string,
  limit = 100,
): Promise<EmployerCandidatesResponse> {
  const params = new URLSearchParams();
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  params.set('limit', String(Math.max(1, Math.min(safeLimit, 100))));
  const res = await apiFetch(`/employer/jobs/${jobId}/candidates?${params.toString()}`, {}, token);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? 'fetch_failed') as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function getConversations(
  token: string,
): Promise<{ conversations: EmployerConversationSummary[] }> {
  const res = await apiFetch('/employer/conversations', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversations_fetch_failed');
  return res.json();
}

export async function getInbox(token: string): Promise<EmployerInboxResponse> {
  const res = await apiFetch('/employer/inbox', {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'inbox_fetch_failed');
  return res.json();
}

export async function getConversation(
  token: string,
  conversationId: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}`, {}, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_fetch_failed');
  return res.json();
}

export async function startConversation(
  token: string,
  data: { job_id: string; worker_id: string; initial_message: string },
): Promise<EmployerConversationResponse> {
  const res = await apiFetch('/employer/conversations', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_create_failed');
  return res.json();
}

export async function sendConversationMessage(
  token: string,
  conversationId: string,
  body: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'message_send_failed');
  return res.json();
}

export async function closeConversation(
  token: string,
  conversationId: string,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'closed' }),
  }, token);
  if (!res.ok) throw new Error((await res.json()).error ?? 'conversation_close_failed');
  return res.json();
}

export interface WorkerDocument {
  doc_type: 'resume' | 'driver_license' | 'ssn';
  s3_key: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string;
}

export interface WorkerProfile {
  worker_id: string;
  full_name: string | null;
  phone: string | null;
  skills: string[] | null;
  availability: string | null;
  years_experience: number | null;
  location: string | null;
  main_trade: string | null;
  main_trade_other: string | null;
  has_transportation: boolean | null;
  city: string | null;
  application_status: ApplicationStatus;
  applied_at: string | null;
}

export async function getWorkerProfile(
  token: string,
  workerId: string,
  jobId: string,
): Promise<WorkerProfile> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/profile?job_id=${jobId}`,
    {},
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'profile_fetch_failed');
  return res.json();
}

export async function updateApplicantStatus(
  token: string,
  jobId: string,
  workerId: string,
  status: ApplicationStatus,
): Promise<{ status: ApplicationStatus }> {
  const res = await apiFetch(
    `/employer/jobs/${jobId}/applicants/${workerId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'status_update_failed');
  return res.json();
}

export async function getWorkerDocuments(
  token: string,
  workerId: string,
  jobId: string,
): Promise<{ documents: WorkerDocument[] }> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/documents?job_id=${jobId}`,
    {},
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'docs_fetch_failed');
  return res.json();
}

export async function createUploadToken(
  token: string,
  jobId: string,
  workerId: string,
): Promise<{ upload_url: string }> {
  const res = await apiFetch(
    '/employer/upload-tokens',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, worker_id: workerId }),
    },
    token,
  );
  if (!res.ok) throw new Error((await res.json()).error ?? 'token_create_failed');
  return res.json();
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/** The paid employer plan's catalog code — a stable identifier, not a price. */
export const EMPLOYER_PRO_PLAN_CODE = 'employer_pro';

export type BillingSubscription = {
  plan_code: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  grace_ends_at: string | null;
} | null;

export type EmployerBilling = {
  planCode: string;
  activeJobLimit: number;
  activeJobUsage: number;
  subscription: BillingSubscription;
  display_price_minor: number;
  currency: string;
  billing_interval: string;
};

export async function getBilling(token: string): Promise<EmployerBilling> {
  const res = await apiFetch('/employer/billing', {}, token);
  if (!res.ok) throw await parseApiError(res, 'billing_fetch_failed');
  return res.json();
}

export type CheckoutSession = { url: string; sessionId: string };

export async function startCheckout(
  token: string,
  data: { planCode: string; successUrl: string; cancelUrl: string },
  idempotencyKey: string,
): Promise<CheckoutSession> {
  const res = await apiFetch(
    '/employer/billing/checkout',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(data),
    },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'checkout_failed');
  return res.json();
}

export async function openBillingPortal(
  token: string,
  returnUrl: string,
  idempotencyKey: string,
): Promise<{ url: string }> {
  const res = await apiFetch(
    '/employer/billing/portal',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ returnUrl }),
    },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'portal_failed');
  return res.json();
}
