import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';
import type { ScoreBand } from '../match';
import type { ApplicationStatus, JobStatus, WritableJobStatus } from '../status';
export type { ApplicationStatus } from '../status';

// The typed-error layer now lives in `./errors` (it is shared with worker.ts
// and with apiFetch's transport errors). Re-exported here so existing
// importers -- the billing page, PostJobModal, EditJobModal, the dashboard,
// PublicListingCard and their tests -- keep importing it from this module.
export { ApiError, parseApiError };
export type { ApiErrorPayload } from './errors';

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
  city_key?: string | null;
  city?: string | null;
  state?: string | null;
  state_region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
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
  // ---------------------------------------------------------------------
  // Job-flow redesign (FE-T3): six structured fields added by migration
  // 077_jobs_structured_fields.sql. All optional -- a job row from before
  // that migration, or a client not yet updated to request the new columns,
  // carries none of them; readers must treat an absent value as "not set"
  // (see lib/job-form.ts's jobToForm), never crash.
  // ---------------------------------------------------------------------
  /** Free text, only meaningful when trade_category === 'other'. */
  trade_category_other?: string | null;
  /** Closed enum; see lib/job-form.ts's DURATION_BUCKETS. */
  expected_duration_bucket?: string | null;
  /** Day abbreviations, e.g. ['mon', 'wed', 'fri']. */
  work_days?: string[] | null;
  /** Postgres TIME -- may arrive as 'HH:MM' or 'HH:MM:SS'. */
  shift_start?: string | null;
  shift_end?: string | null;
  /** Per-certification requirement rows; independent of the legacy
   *  `certification_doc` three-state row in required_docs/optional_docs. */
  certification_requirements?: Array<{ name: string; tier: 'required' | 'optional'; proof_required: boolean }> | null;
};

export type EmployerJobDetail = Job & {
  description: string | null;
  /**
   * Widened from the legacy 2-value union to admit the two new doc types
   * (`work_auth_doc`, `certification_doc` -- migration 074). `string[]` on
   * purpose rather than re-narrowing: every reader here already falls back
   * gracefully on an unrecognized value (a label-map `?? doc`).
   */
  required_docs: string[];
  /**
   * The four three-state arrays (migrations 073/074). Every employer-jobs
   * handler (create/update/detail) now returns them; they stay optional in
   * the type only for jobs fetched by a cached pre-rollout client or replayed
   * fixtures — readers must still treat an absent array as empty, never crash.
   */
  optional_docs?: string[];
  required_fields?: string[];
  optional_fields?: string[];
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
  /**
   * The worker's answers to this job's required+optional custom fields
   * (job_applications.application_answers), keyed by field vocabulary --
   * see infra/lambda/lib/application-answers.ts for the per-key shapes.
   * Optional: absent on rows from before this feature, or while the
   * applicants handler has not yet been updated to select the column.
   */
  application_answers?: Record<string, unknown>;
  /** Optional fields the job asked for that this applicant left unanswered. */
  not_provided?: string[];
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

/**
 * The READ helpers in this module take an optional trailing `AbortSignal`,
 * forwarded to `apiFetch` (which chains it into the per-attempt controller).
 * `usePageData` hands its fetcher a signal that aborts on unmount and on a deps
 * change; passing it here is what actually cancels the in-flight request rather
 * than merely discarding its answer. The parameter is last and optional, so
 * every existing call site is unaffected.
 *
 * MUTATION helpers deliberately do NOT take one. A POST/PATCH/DELETE that has
 * reached the server still executes; aborting it only throws away the response,
 * which would turn "user navigated away" into "the app has no idea whether the
 * write landed". Those must run to completion and be reported.
 */
export async function getEmployerProfile(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerProfileData> {
  const res = await apiFetch('/employer/profile', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'profile_fetch_failed');
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
  if (!res.ok) throw await parseApiError(res, 'profile_update_failed');
  return res.json();
}

/**
 * The employer's daily applicant-digest email preferences, rendered by the
 * Notifications panel on `/employer/profile`.
 *
 * `language` is the DIGEST EMAIL's language and is independent of the reader's
 * UI locale -- an employer can read the site in English and want the digest in
 * Spanish. Never seed it from `useLocale()`.
 *
 * An employer with no stored row reads back the backend's defaults
 * (`false`/`8`/`America/Chicago`/`en`), not a 404, so there is no "not
 * configured yet" state for the panel to handle.
 */
export type EmployerDigestSettings = {
  enabled: boolean;
  send_hour_local: number;
  timezone: string;
  language: 'en' | 'es';
};

/** Any subset of the four fields; the response is always the full stored row. */
export type EmployerDigestSettingsPatch = Partial<EmployerDigestSettings>;

export async function getEmployerDigestSettings(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerDigestSettings> {
  const res = await apiFetch('/employer/settings/digest', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'digest_settings_fetch_failed');
  return res.json();
}

export async function updateEmployerDigestSettings(
  token: string,
  patch: EmployerDigestSettingsPatch,
): Promise<EmployerDigestSettings> {
  const res = await apiFetch(
    '/employer/settings/digest',
    { method: 'PATCH', body: JSON.stringify(patch) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'digest_settings_update_failed');
  return res.json();
}

export async function getJobs(token: string, signal?: AbortSignal): Promise<Job[]> {
  const res = await apiFetch('/employer/jobs', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  const data = await res.json();
  return data.jobs;
}

/**
 * `city_key`/`city`/`state` are all-or-none — send all three or none at all;
 * a partial triple is meaningless to the backend and will be rejected.
 * `latitude`/`longitude` are likewise all-or-none, and independent of the
 * city triple (coordinates may be sent without a picked city, or vice versa).
 */
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
  /** The three-state picker's other three arrays (migrations 073/074). Omit
   *  to preserve on update, same contract as `required_docs`. */
  optional_docs?: string[];
  required_fields?: string[];
  optional_fields?: string[];
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
  latitude?: number;
  longitude?: number;
  city_key?: string;
  state?: string;
  // Job-flow redesign (FE-T3), migration 077 -- see the matching comment on
  // `Job` above. `lib/job-form.ts`'s `jobFormToBasePayload` omits each of
  // these independently when its structured value is empty; there is no
  // explicit-`null` clear story for them yet (unlike `state_region`'s
  // create/edit split).
  trade_category_other?: string;
  expected_duration_bucket?: string;
  work_days?: string[];
  shift_start?: string;
  shift_end?: string;
  certification_requirements?: Array<{ name: string; tier: 'required' | 'optional'; proof_required: boolean }>;
};

export async function createJob(token: string, data: JobWritePayload): Promise<Job> {
  const res = await apiFetch('/employer/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw await parseApiError(res, 'create_failed');
  return res.json();
}

/**
 * Payload for `generateJobDescription` -- every field but `trade_category` is
 * optional, mirroring "whatever the job form currently holds". Strings are
 * capped at 200 chars by the backend (400 `invalid_*` past that); callers
 * should trim/slice before sending rather than round-trip into a failure.
 * `trade_category: 'other'` is rejected outright UNLESS `trade_category_other`
 * is also present (non-blank, ≤200 chars) -- callers should keep the trigger
 * disabled for 'other' without custom trade text instead of surfacing the
 * generic failure message.
 * `trade_category_other` is only meaningful (and only ever read by the
 * backend) when `trade_category === 'other'`.
 * `employer_notes` is a separate, larger cap (500 chars server-side; callers
 * generally send far less -- see `lib/generate-description-payload.ts`'s
 * `EMPLOYER_NOTES_MAX_LENGTH`) for brief free-text context typed by the
 * employer, e.g. into the description box before generating.
 */
export type GenerateJobDescriptionPayload = {
  title?: string;
  trade_category: string;
  trade_category_other?: string;
  city?: string;
  state?: string;
  pay_min?: number;
  pay_max?: number;
  pay_interval?: string;
  expected_duration?: string;
  shift_schedule?: string;
  employer_notes?: string;
};

export type GenerateJobDescriptionResult = {
  description_en: string;
  description_es: string;
};

/**
 * AI-drafted job description in both locales. Mirrors `createJob` above --
 * same `apiFetch` + typed-error shape, just a different endpoint/payload.
 * A daily-cap 429 comes back as `generation_limit_reached`; a Bedrock/provider
 * failure comes back as 502 `generation_failed`.
 */
export async function generateJobDescription(
  token: string,
  data: GenerateJobDescriptionPayload,
): Promise<GenerateJobDescriptionResult> {
  const res = await apiFetch('/employer/jobs/generate-description', {
    method: 'POST',
    body: JSON.stringify(data),
  }, token);
  if (!res.ok) throw await parseApiError(res, 'generate_failed');
  return res.json();
}

export async function getJob(
  token: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<EmployerJobDetail> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
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
  if (!res.ok) throw await parseApiError(res, 'update_failed');
  return res.json();
}

export async function deleteJob(token: string, jobId: string): Promise<void> {
  const res = await apiFetch(`/employer/jobs/${jobId}`, { method: 'DELETE' }, token);
  if (!res.ok) throw await parseApiError(res, 'delete_failed');
}

export type JobTemplate = {
  id: string;
  name: string;
  payload: JobWritePayload;
  updated_at: string;
};

export async function listJobTemplates(token: string): Promise<JobTemplate[]> {
  const res = await apiFetch('/employer/templates', {}, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return (await res.json()).templates;
}

export async function saveJobTemplate(
  token: string,
  data: { id?: string; name: string; payload: JobWritePayload },
): Promise<JobTemplate> {
  const res = await apiFetch('/employer/templates', { method: 'POST', body: JSON.stringify(data) }, token);
  if (!res.ok) throw await parseApiError(res, 'save_failed');
  return res.json();
}

export async function deleteJobTemplate(token: string, templateId: string): Promise<void> {
  const res = await apiFetch(`/employer/templates/${templateId}`, { method: 'DELETE' }, token);
  if (!res.ok) throw await parseApiError(res, 'delete_failed');
}

/**
 * Reported by PostJobModal to the dashboard when the job posted but a side
 * effect did not happen.
 *
 * "Save as template" is a secondary action on the post-job form: if the job
 * itself succeeded, hitting the template cap must not read as a failed post.
 * The modal closes on the success it did achieve and hands the dashboard the
 * shortfall to surface separately.
 */
export type JobCreatedOutcome = {
  templateNotSaved?: { templateLimit: number };
};

export async function getJobApplicants(
  token: string,
  jobId: string,
  filters: ApplicantFilters = {},
  signal?: AbortSignal,
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
    { signal },
    token
  );
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function getJobCandidates(
  token: string,
  jobId: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<EmployerCandidatesResponse> {
  const params = new URLSearchParams();
  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 100;
  params.set('limit', String(Math.max(1, Math.min(safeLimit, 100))));
  const res = await apiFetch(`/employer/jobs/${jobId}/candidates?${params.toString()}`, { signal }, token);
  // The job page branches on `.status` here (401/403 route into the legal
  // wall), which ApiError preserves along with the code.
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function getConversations(
  token: string,
  signal?: AbortSignal,
): Promise<{ conversations: EmployerConversationSummary[] }> {
  const res = await apiFetch('/employer/conversations', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'conversations_fetch_failed');
  return res.json();
}

export async function getInbox(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerInboxResponse> {
  const res = await apiFetch('/employer/inbox', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'inbox_fetch_failed');
  return res.json();
}

export async function getConversation(
  token: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<EmployerConversationResponse> {
  const res = await apiFetch(`/employer/conversations/${conversationId}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'conversation_fetch_failed');
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
  if (!res.ok) throw await parseApiError(res, 'conversation_create_failed');
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
  if (!res.ok) throw await parseApiError(res, 'message_send_failed');
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
  if (!res.ok) throw await parseApiError(res, 'conversation_close_failed');
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
  signal?: AbortSignal,
): Promise<WorkerProfile> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/profile?job_id=${jobId}`,
    { signal },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'profile_fetch_failed');
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
  if (!res.ok) throw await parseApiError(res, 'status_update_failed');
  return res.json();
}

export async function getWorkerDocuments(
  token: string,
  workerId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ documents: WorkerDocument[] }> {
  const res = await apiFetch(
    `/employer/workers/${workerId}/documents?job_id=${jobId}`,
    { signal },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'docs_fetch_failed');
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
  if (!res.ok) throw await parseApiError(res, 'token_create_failed');
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
  templateLimit: number;
  activeJobUsage: number;
  subscription: BillingSubscription;
  display_price_minor: number;
  currency: string;
  billing_interval: string;
};

export async function getBilling(
  token: string,
  signal?: AbortSignal,
): Promise<EmployerBilling> {
  const res = await apiFetch('/employer/billing', { signal }, token);
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
