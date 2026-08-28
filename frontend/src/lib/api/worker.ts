import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';
import type { ApplicationStatus, JobStatus } from '../status';

export interface UploadUrlResponse {
  url: string;
  s3_key: string;
}

/**
 * `work_auth_doc`/`certification_doc` (migration 074) widen this alongside
 * the job-side `DOC_TYPES` in job-fields.ts. `ssn` stays -- legacy vault rows
 * may still carry it even though no new job or upload may select it.
 */
export type DocType = 'resume' | 'driver_license' | 'ssn' | 'work_auth_doc' | 'certification_doc';
export type JobDocType = 'resume' | 'driver_license' | 'work_auth_doc' | 'certification_doc';
/** Per-job custom-field vocabulary (job_applications.application_answers keys). */
export type JobFieldKey =
  | 'work_authorization'
  | 'date_available'
  | 'desired_pay'
  | 'home_address'
  | 'date_of_birth'
  | 'emergency_contact'
  | 'worked_here_before'
  | 'education'
  | 'references'
  | 'work_history'
  | 'military_service';

// The upload trio below (and uploadFileToS3) deliberately use raw `fetch`, not
// `apiFetch`: they run the unauthenticated one-time-token flow on /upload/[token],
// where there is no session and no Authorization header to attach.

export async function getUploadUrl(
  token: string,
  doc_type: DocType,
  mime_type: string,
): Promise<UploadUrlResponse> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/upload-url`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, doc_type, mime_type }),
    },
  );
  if (!res.ok) throw await parseApiError(res, 'upload_url_failed');
  return res.json();
}

export async function uploadFileToS3(presignedUrl: string, file: File): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  // S3 answers with an XML error document, never our JSON error envelope, so
  // there is no code to read out of the body -- only the status is meaningful.
  if (!res.ok) throw new ApiError(res.status, 's3_upload_failed');
}

export async function confirmUpload(
  token: string,
  s3_key: string,
  doc_type: DocType,
  file: File,
): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        s3_key,
        doc_type,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
      }),
    },
  );
  if (!res.ok) throw await parseApiError(res, 'confirm_failed');
}

export async function submitUpload(token: string): Promise<void> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/worker/documents/submit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  if (!res.ok) throw await parseApiError(res, 'submit_failed');
}

// Authenticated marketplace helpers

export type Job = {
  id: string;
  title: string;
  location: string;
  job_type: 'full-time' | 'part-time' | 'contract';
  company?: string;
  company_name: string;
  pay?: string;
  pay_min?: number | null;
  pay_max?: number | null;
  pay_interval?: string | null;
  required_experience_months?: number | null;
  start_date?: string | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  transportation_required?: boolean | null;
  work_authorization_required?: boolean | null;
  language_preference?: Array<'any' | 'en' | 'es'> | null;
  number_of_workers_needed?: number | null;
  hired_count?: number | null;
  open_count?: number | null;
  trade_category?: string | null;
  required_experience_years?: number | null;
  certifications?: string[] | null;
  required_docs: JobDocType[];
  created_at: string;
  match_score?: number;
  match_reasons?: string[];
  /**
   * Structured job-flow-redesign fields (WK-T0). Every one of these is
   * optional and may be absent or null on a legacy job -- callers must treat
   * absence/null as "no structured data" and fall back to the legacy
   * free-text fields (`trade_category`, `expected_duration`,
   * `shift_schedule`, `certifications`) rather than crash.
   *
   * `trade_category_other` is the free-text trade name when
   * `trade_category` is `'other'`.
   */
  trade_category_other?: string | null;
  expected_duration_bucket?: 'lt_1w' | '1_2w' | '2_4w' | '1_3m' | '3_6m' | '6m_plus' | 'ongoing' | null;
  work_days?: Array<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'> | null;
  /** 'HH:MM', 24h. */
  shift_start?: string | null;
  /** 'HH:MM', 24h. */
  shift_end?: string | null;
  certification_requirements?: Array<{ name: string; tier: 'required' | 'optional'; proof_required: boolean }> | null;
};

export type JobDetail = Job & {
  description: string | null;
  status?: JobStatus;
  already_applied: boolean;
  application_status: ApplicationStatus | null;
  missing_docs: JobDocType[];
  /**
   * The three-state picker's other three arrays plus the two derived
   * "what's left" lists (migrations 073/074). All optional: the
   * currently-deployed `worker-jobs-detail` handler does not select them
   * yet, so every reader must treat an absent array as empty, never crash.
   */
  optional_docs?: JobDocType[];
  required_fields?: JobFieldKey[];
  optional_fields?: JobFieldKey[];
  /** Required fields this worker (if already applied) has not yet answered. */
  missing_fields?: JobFieldKey[];
  /** Optional fields the job asks for that this worker left unanswered. */
  optional_unanswered?: JobFieldKey[];
  /** Public listing opt-in (migration 057). Absent on older payloads --
   * treat absence as false (fail-closed): the share panel must not render
   * for a job the employer never opted into public listing for. */
  public_listing_enabled?: boolean;
  /** City-picker identity (migration 065), added to `worker-jobs-detail`'s
   * SELECT alongside `public_listing_enabled`. Null for a free-typed
   * location that was never resolved to a picked city. */
  city_key?: string | null;
};

export type Application = {
  application_id: string;
  job_id: string;
  job_title: string;
  company_name: string;
  status: ApplicationStatus;
  applied_at: string;
  /** Job (not application) status. Optional: the frontend may deploy before
   * the backend adds the field. Never 'paused' — the API coalesces it to
   * 'closed' (billing privacy). */
  job_status?: JobStatus;
};

export type WorkerTrade = 'electrician' | 'plumber' | 'carpenter' | 'concrete' | 'painting' | 'other';
export type WorkerExperience = '0-1' | '2-4' | '5-9' | '10+';
export type WorkerAvailability = 'full_time' | 'part_time' | 'weekends' | 'flexible';

export type PreferredCity = {
  city_key: string;
  city: string;
  state: string;
  latitude?: number | null;
  longitude?: number | null;
};

export type WorkerProfileData = {
  id: string;
  phone: string;
  full_name: string | null;
  skills: string[];
  availability: WorkerAvailability | null;
  years_experience: number | null;
  location: string | null;
  bio: string | null;
  city?: string | null;
  main_trade?: WorkerTrade | null;
  main_trade_other?: string | null;
  has_transportation?: boolean | null;
  certifications?: string[] | null;
  preferred_cities?: PreferredCity[];
};

export type WorkerVaultDoc = {
  /** Row identity from the worker vault list endpoint (WK-T0 backend gap fix). */
  id: string;
  doc_type: DocType;
  s3_key: string;
  file_name: string;
  file_size: number;
  uploaded_at: string;
  url: string;
  /** Only meaningful when `doc_type` is `'certification_doc'`. */
  cert_name?: string | null;
};

/**
 * `latitude`/`longitude` must be sent together (all-or-none) — sending only
 * one is meaningless to the backend geocode/coordinate write path.
 * `preferred_cities`, when present, replaces the worker's full preferred-city
 * list (already declared on `WorkerProfileData`; not re-declared here).
 */
export type WorkerProfilePatch = Partial<Omit<WorkerProfileData, 'id' | 'phone' | 'years_experience'> & {
  years_experience: number | WorkerExperience | null;
  latitude: number;
  longitude: number;
  location_source: 'geocoded_zip' | 'geocoded_address';
}>;

/**
 * @deprecated Use `ApiError` from `@/lib/api/errors` -- every thrower in this
 * module now raises that class. Kept as a structural (not `= ApiError`) alias
 * because page-local fetches still build this shape by hand and assign to
 * `status`/`code`, which `ApiError` declares readonly. An `ApiError` satisfies
 * it, so `err as WorkerApiError` reads keep working unchanged.
 */
export type WorkerApiError = Error & {
  status?: number;
  code?: string;
  missing_docs?: string[];
  /** `missing_answers` -- the required custom-field keys the apply call left unanswered. */
  missing_fields?: string[];
};

/**
 * The READ helpers below take an optional trailing `AbortSignal`, forwarded to
 * `apiFetch` (which chains it into the per-attempt controller). `usePageData`
 * hands its fetcher a signal that aborts on unmount and on a deps change;
 * passing it here is what actually cancels the in-flight request rather than
 * merely discarding its answer. The parameter is last and optional, so every
 * existing call site is unaffected.
 *
 * MUTATION helpers deliberately do NOT take one. A POST/PATCH/DELETE that has
 * reached the server still executes; aborting it only throws away the response,
 * which would turn "user navigated away" into "the app has no idea whether the
 * write landed". Those must run to completion and be reported.
 */
export async function getJobs(
  token: string,
  filters?: { search?: string; job_type?: string },
  signal?: AbortSignal,
): Promise<{ jobs: Job[]; other_jobs?: Job[] }> {
  const qs = new URLSearchParams();
  if (filters?.search) qs.set('search', filters.search);
  if (filters?.job_type) qs.set('job_type', filters.job_type);
  const path = `/worker/jobs${qs.toString() ? `?${qs}` : ''}`;
  const res = await apiFetch(path, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function getJob(token: string, id: string, signal?: AbortSignal): Promise<JobDetail> {
  const res = await apiFetch(`/worker/jobs/${id}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

/** One certification-requirement claim submitted alongside an application. */
export type CertificationClaim = { name: string; has: boolean; doc_ids?: string[] };

/**
 * `answers` (job_applications.application_answers) is optional and only
 * meaningful when the job has any required/optional custom fields --
 * `ApplicationAnswersForm` builds it via `buildAnswersPayload`. Omitting it
 * entirely (jobs with no configured fields) sends the same bare POST this
 * call always sent.
 *
 * Two NEW 400 codes ride the same taxonomy `missing_docs` already used:
 * `missing_answers` carries `missing_fields` (the still-unanswered required
 * field keys) and `invalid_answers` carries `detail` (the specific
 * validator failure, e.g. `invalid_desired_pay`) -- both allowlisted onto
 * `ApiError.payload` by `parseApiError`.
 *
 * `certification_claims` (WK-T0) is sent as a TOP-LEVEL sibling of `answers`,
 * never nested inside it, and is omitted from the body entirely when the
 * caller does not pass it -- existing call sites keep sending exactly the
 * same body they always sent.
 */
export async function applyToJob(
  token: string,
  id: string,
  answers?: Record<string, unknown>,
  certification_claims?: Array<CertificationClaim>,
): Promise<Application> {
  const hasBody = answers !== undefined || certification_claims !== undefined;
  const body: { answers?: Record<string, unknown>; certification_claims?: Array<CertificationClaim> } = {};
  if (answers !== undefined) body.answers = answers;
  if (certification_claims !== undefined) body.certification_claims = certification_claims;
  const res = await apiFetch(
    `/worker/jobs/${id}/apply`,
    { method: 'POST', body: hasBody ? JSON.stringify(body) : undefined },
    token,
  );
  // A 400 from the required-docs guard carries `missing_docs`; the job page
  // renders one label per entry. parseApiError allowlists that field onto both
  // `err.payload.missing_docs` and `err.missing_docs`.
  if (!res.ok) throw await parseApiError(res, 'apply_failed');
  return res.json();
}

export async function getApplications(
  token: string,
  signal?: AbortSignal,
): Promise<{ applications: Application[] }> {
  const res = await apiFetch('/worker/applications', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function updateWorkerProfile(
  token: string,
  patch: WorkerProfilePatch,
): Promise<WorkerProfileData> {
  const res = await apiFetch('/worker/profile', { method: 'PATCH', body: JSON.stringify(patch) }, token);
  if (!res.ok) throw await parseApiError(res, 'update_failed');
  return res.json();
}

export async function getVaultDocuments(
  token: string,
  signal?: AbortSignal,
): Promise<{ documents: WorkerVaultDoc[] }> {
  const res = await apiFetch('/worker/vault', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

/**
 * A worker's most-recently-submitted custom-field answers, offered as
 * pre-fill defaults on a new application. `answers` is `{}` for a worker
 * with no prior application history -- callers are expected to swallow
 * fetch failures (this is a convenience pre-fill, never a blocker to
 * applying).
 */
export type ApplicationDefaults = { answers: Record<string, unknown>; updated_at?: string | null };

/**
 * Deliberately does NOT take the trailing `AbortSignal` the READ-helpers
 * convention above describes: this is a best-effort pre-fill call that
 * callers wrap in try/catch and swallow on failure, not a page-data fetch
 * wired through `usePageData`'s unmount/deps-change cancellation.
 */
export async function getApplicationDefaults(token: string): Promise<ApplicationDefaults> {
  const res = await apiFetch('/worker/application-defaults', {}, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function getAuthUploadUrl(
  token: string,
  doc_type: DocType,
  mime_type: string,
): Promise<UploadUrlResponse> {
  const res = await apiFetch(
    '/worker/vault/upload-url',
    { method: 'POST', body: JSON.stringify({ doc_type, mime_type }) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'upload_url_failed');
  return res.json();
}

/**
 * `cert_name` is only meaningful when `doc_type` is `'certification_doc'` and
 * is omitted from the POST body entirely (not sent as `undefined`/`null`)
 * when the caller does not pass it, so existing call sites are unaffected.
 */
export async function confirmAuthUpload(
  token: string,
  s3_key: string,
  doc_type: DocType,
  file: File,
  cert_name?: string,
): Promise<void> {
  const res = await apiFetch(
    '/worker/vault/confirm',
    {
      method: 'POST',
      body: JSON.stringify({
        s3_key, doc_type,
        file_name: file.name, file_size: file.size, mime_type: file.type,
        ...(cert_name !== undefined ? { cert_name } : {}),
      }),
    },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'confirm_failed');
}

/**
 * `id` disambiguates between multiple vault rows of the same `doc_type`
 * (e.g. several `certification_doc` uploads). Omitted entirely when the
 * caller does not pass it, preserving the existing single-doc-per-type
 * DELETE behavior for every current call site.
 */
export async function deleteVaultDocument(token: string, doc_type: DocType, id?: string): Promise<void> {
  const qs = id !== undefined ? `?id=${encodeURIComponent(id)}` : '';
  const res = await apiFetch(`/worker/vault/${doc_type}${qs}`, { method: 'DELETE' }, token);
  if (!res.ok) throw await parseApiError(res, 'delete_failed');
}

// Job-referral sharing (ShareJobPanel)

export type ShareChannel = 'whatsapp' | 'sms' | 'facebook' | 'copy_link' | 'device_share';

export interface ShareJobResponse {
  code: string;
  channel: ShareChannel;
  share_url: string;
}

/**
 * Mints (or refreshes) this worker's share link for one (job, channel) pair.
 * Must be called separately for each channel button -- the per-channel call
 * is what makes the resulting attribution data meaningful, so never reuse a
 * `share_url` obtained for one channel on a different channel's handoff.
 */
export async function shareJob(
  token: string,
  jobId: string,
  channel: ShareChannel,
): Promise<ShareJobResponse> {
  const res = await apiFetch(`/worker/jobs/${jobId}/share`, { method: 'POST', body: JSON.stringify({ channel }) }, token);
  if (!res.ok) throw await parseApiError(res, 'share_failed');
  return res.json();
}

export interface ClaimReferralResponse {
  claimed: boolean;
}

/**
 * Claims a referral share code for the just-authenticated worker. Called
 * best-effort right after OTP verification in the web-apply carry-through --
 * a bad/expired code must never break signup, so callers should wrap this in
 * their own try/catch and swallow failures.
 */
export async function claimReferral(token: string, shareCode: string): Promise<ClaimReferralResponse> {
  const res = await apiFetch('/worker/referrals/claim', { method: 'POST', body: JSON.stringify({ shareCode }) }, token);
  if (!res.ok) throw await parseApiError(res, 'claim_failed');
  return res.json();
}

// ── Media board (worker portfolio posts) ─────────────────────────

export type PostMediaItem = {
  id: string;
  url: string;
  sort_order: number;
  moderation_status: 'approved' | 'flagged';
};

export type WorkerPost = {
  id: string;
  caption: string | null;
  source: 'web' | 'whatsapp';
  created_at: string;
  media: PostMediaItem[];
};

export async function getPostUploadUrls(
  token: string,
  items: { mime_type: string; file_size: number }[],
): Promise<{ post_id: string; uploads: { url: string; s3_key: string }[] }> {
  const res = await apiFetch(
    '/worker/posts/upload-urls',
    { method: 'POST', body: JSON.stringify({ items }) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'upload_url_failed');
  return res.json();
}

export async function createPost(
  token: string,
  post_id: string,
  caption: string | null,
  items: { s3_key: string; sort_order: number }[],
): Promise<{ flagged_count: number }> {
  const res = await apiFetch(
    '/worker/posts',
    { method: 'POST', body: JSON.stringify({ post_id, caption, items }) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'confirm_failed');
  return res.json();
}

/**
 * `cursor` drives keyset pagination (`before`/`before_id`, matching the
 * `(created_at, id)` composite cursor the list endpoint returns) for Task
 * 11's load-more; omitted entirely for the first page.
 */
export async function getWorkerPosts(
  token: string,
  cursor?: { before: string; before_id: string },
  signal?: AbortSignal,
): Promise<{ posts: WorkerPost[]; next_before: string | null; next_before_id: string | null }> {
  const qs = cursor
    ? `?before=${encodeURIComponent(cursor.before)}&before_id=${encodeURIComponent(cursor.before_id)}`
    : '';
  const res = await apiFetch(`/worker/posts${qs}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function deleteWorkerPost(token: string, post_id: string): Promise<void> {
  const res = await apiFetch(`/worker/posts/${post_id}`, { method: 'DELETE' }, token);
  if (!res.ok) throw await parseApiError(res, 'delete_failed');
}

// ---------------------------------------------------------------------------
// Web worker onboarding (S22 R2)
//
// The four endpoints below drive the web door onto the SAME onboarding state
// machine WhatsApp v2 runs (migration 086's `start_web_onboarding_workflow`).
// Every one of them answers with the WHOLE `OnboardingState`, so the client
// never has to guess what changed: hydrate from the response and re-render.
//
// `lockVersion` is optimistic concurrency across the two doors -- the same
// worker answering on WhatsApp while the web tab is open. It advances on
// EVERY mutation (answers, back, language), so a caller that only re-reads it
// after `answers` will 409 on its next write.
// ---------------------------------------------------------------------------

export type OnboardingLifecycle = 'onboarding' | 'ready' | 'suspended';

export type OnboardingRun = {
  id: string;
  stepKey: string;
  lockVersion: number;
  preferredLanguage: 'en' | 'es';
  workflowVersion: number;
};

export type OnboardingLocation = { city: string | null; state: string | null; zip: string | null };

export type OnboardingProfile = {
  fullName: string | null;
  location: OnboardingLocation | null;
  trade: { key: string; other: string | null } | null;
  yearsExperience: string | null;
  hasTransportation: boolean | null;
  availability: string | null;
};

export type OnboardingQuestion = { index: number; q_en: string; q_es: string };
export type OnboardingAnswer = { index: number; text: string; source: 'text' | 'voice' };

export type OnboardingExtractedSkill = { label_en: string; label_es: string; source: number[] };

export type OnboardingExtraction = {
  status: 'pending' | 'extracting' | 'completed' | 'failed';
  extracted: Record<string, OnboardingExtractedSkill[]> | null;
  summary_en: string | null;
  summary_es: string | null;
};

export type OnboardingState = {
  lifecycle: OnboardingLifecycle;
  run: OnboardingRun;
  profile: OnboardingProfile;
  trust: { questions: OnboardingQuestion[]; answers: OnboardingAnswer[] };
  pendingLocationConfirm: { city: string; state: string } | null;
  extraction: OnboardingExtraction | null;
};

/** One engine step and the value it is being answered with. */
export type OnboardingAnswerItem = { stepKey: string; value: unknown };

export type OnboardingAnswersBody = { lockVersion: number; answers: OnboardingAnswerItem[] };

/**
 * `postOnboardingAnswers` returns a UNION instead of throwing for its two
 * expected rejections, which is a deliberate break from this module's
 * throw-`parseApiError` convention -- and the reason is `ApiError` itself:
 * `ALLOWED_PAYLOAD_KEYS` in `./errors` is a closed allowlist, so an `ApiError`
 * physically cannot carry `rejectedStepKey`, `reason` or the fresh `state` the
 * 422 body ships. Widening that allowlist would loosen the guarantee it exists
 * to give (no unreviewed server detail reaching the UI) for one endpoint.
 *
 * Everything else -- 5xx, offline, timeout, an unexpected 4xx -- still throws
 * `ApiError` exactly like every other helper here.
 */
export type OnboardingSaveResult =
  | { kind: 'saved'; state: OnboardingState }
  /** 409: someone else (WhatsApp) advanced the run. Refetch and retry once. */
  | { kind: 'lock_conflict' }
  /** 422: the engine refused one step. `state` is the run as it stands now. */
  | { kind: 'step_rejected'; rejectedStepKey: string; reason: string; state: OnboardingState };

export async function getWorkerOnboarding(token: string, signal?: AbortSignal): Promise<OnboardingState> {
  const res = await apiFetch('/worker/onboarding', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function postOnboardingAnswers(
  token: string,
  body: OnboardingAnswersBody,
): Promise<OnboardingSaveResult> {
  const res = await apiFetch(
    '/worker/onboarding/answers',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );
  if (res.ok) return { kind: 'saved', state: await res.json() };

  if (res.status === 409 || res.status === 422) {
    // Read the body ONCE, defensively: a proxy 409/422 with an HTML body must
    // degrade to the generic thrown error, never to a half-built union member.
    const parsed = await res.clone().json().catch(() => null) as {
      error?: unknown;
      rejectedStepKey?: unknown;
      reason?: unknown;
      state?: unknown;
    } | null;

    if (res.status === 409 && parsed?.error === 'lock_conflict') {
      return { kind: 'lock_conflict' };
    }
    if (
      res.status === 422
      && parsed?.error === 'step_rejected'
      && typeof parsed.rejectedStepKey === 'string'
      && typeof parsed.reason === 'string'
      && parsed.state !== null
      && typeof parsed.state === 'object'
    ) {
      return {
        kind: 'step_rejected',
        rejectedStepKey: parsed.rejectedStepKey,
        reason: parsed.reason,
        state: parsed.state as OnboardingState,
      };
    }
  }

  throw await parseApiError(res, 'save_failed');
}

export async function postOnboardingBack(
  token: string,
  body: { lockVersion: number },
): Promise<OnboardingState> {
  const res = await apiFetch(
    '/worker/onboarding/back',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'save_failed');
  return res.json();
}

export async function patchOnboardingLanguage(
  token: string,
  body: { preferredLanguage: 'en' | 'es' },
): Promise<OnboardingState> {
  const res = await apiFetch(
    '/worker/onboarding/language',
    { method: 'PATCH', body: JSON.stringify(body) },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'save_failed');
  return res.json();
}
