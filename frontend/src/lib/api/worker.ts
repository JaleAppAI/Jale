import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';
import type {
  ApplicationDetailsStatus,
  ApplicationStage,
  ApplicationStatus,
  JobStatus,
} from '../status';

/**
 * Re-exported so a caller that already imports from this module for the
 * application types does not have to reach into `lib/status` for the two
 * enums that only ever appear next to them.
 */
export type { ApplicationDetailsStatus, ApplicationStage };

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

/**
 * One employer-authored question a worker answers at APPLY time
 * (`jobs.pre_application_prompts`, migration 091). `id` is employer-minted
 * and stable: it is the key the answer is stored under, so an edit that
 * re-uses the text but mints a new id ORPHANS every existing answer. Callers
 * editing a job must round-trip the ids they were given.
 */
export type PreApplicationPrompt = { id: string; text: string };

/**
 * What an application still owes, as published by the READ endpoints
 * (`remainingView` in `infra/lambda/lib/application-stage-view.ts` -- six
 * keys). Every array is in the job's own column order, so it can be rendered
 * as a checklist without re-sorting.
 *
 * `complete` deliberately ignores optional fields/docs and uncollectable
 * (legacy `ssn`) docs: nothing a worker can do would ever clear those, so
 * they must not hold an application open.
 */
export type RequirementsRemaining = {
  /** Unanswered prompt ids. */
  prompts: string[];
  /** Unanswered REQUIRED field keys. */
  fields: string[];
  certifications: { unclaimed: string[]; unproven: string[] };
  /** Missing required doc types that some flow can actually collect. */
  docs: string[];
  counts: { prompts: number; fields: number; certifications: number; docs: number };
  complete: boolean;
};

/**
 * The FULLER shape the stage-2 door's own state document carries: the same
 * six keys plus the three buckets the list endpoints drop. Kept separate
 * rather than making the extras optional on `RequirementsRemaining`, because
 * a list row genuinely never has them and a reader that treats them as
 * "maybe absent" would render an empty optional-docs list as "nothing
 * optional left" on the very surface that does know.
 */
export type ApplicationRequirementsRemaining = RequirementsRemaining & {
  /** Required docs no flow can collect (legacy `ssn`). Never blocking. */
  uncollectableDocs: string[];
  optionalFields: string[];
  optionalDocs: string[];
};

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
  /**
   * The employer's apply-time questions (migration 091). Every job read
   * publishes it -- list rows included -- and it is `[]` for a job that asks
   * none, but it stays optional here for a payload from a cached pre-sprint-23
   * client: readers must treat absence as "no prompts", never crash.
   */
  pre_application_prompts?: PreApplicationPrompt[];
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
  /**
   * The four stage-2 keys (migration 091). Present ONLY when this worker has
   * already applied -- `worker-jobs-detail.ts` omits the whole block
   * otherwise, because there is no application and therefore no stage to
   * report. Read them as a set: `already_applied` being true is what makes
   * them meaningful.
   */
  application_id?: string;
  details_status?: ApplicationDetailsStatus;
  stage?: ApplicationStage;
  /**
   * NOTE the deliberate disagreement with `missing_docs` above: `remaining.docs`
   * is JOB-SCOPED (docs attached to THIS job), which is what the employer's
   * hire gate measures, while `missing_docs` is the worker's vault-or-job view
   * of the same question. Both are correct answers to different questions --
   * see the `have_docs` contract in `lib/application-stage-view.ts`.
   */
  remaining?: RequirementsRemaining;
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
  /**
   * The stage-2 columns (migration 091). Optional for the same reason
   * `job_status` is: the frontend may ship before the backend does.
   *
   * `details_status` and `stage` are derived from the TIMESTAMPS, never from
   * `status`, so an employer who moves a `details_requested` applicant on to
   * `talking` does not reset the stage -- the two can and do disagree.
   */
  details_status?: ApplicationDetailsStatus;
  stage?: ApplicationStage;
  details_requested_at?: string | null;
  details_completed_at?: string | null;
  /** The single badgeable number: prompts + fields + certifications + docs. */
  remaining_count?: number;
  remaining?: RequirementsRemaining;
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
  file_name: string;
  file_size: number;
  uploaded_at: string;
  /**
   * The short-lived presigned GET. The raw `s3_key` deliberately does NOT
   * travel — the vault list endpoint strips it and presigns server-side.
   */
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
 * APPLY -- stage 1, and stage 1 only (sprint 23, migration 091).
 *
 * The body is now `{ prompt_answers }` and NOTHING else. Field answers and
 * certification claims moved to stage 2 (`postApplicationAnswers` /
 * `postApplicationCertifications` below), which the employer opens by asking
 * for details; sending them here would be discarded, so they are not in the
 * signature. The backend still ACCEPTS the legacy `answers` /
 * `certification_claims` keys for one release
 * (`infra/lambda/api/worker-jobs-apply.ts`), purely so a CloudFront-cached
 * pre-sprint-23 bundle keeps working -- that is a compat window for old
 * clients, not a payload this one should keep sending.
 *
 * `promptAnswers` is keyed on `PreApplicationPrompt.id` and must cover EVERY
 * prompt the job asks; an incomplete set is a 400 `missing_prompt_answers`
 * carrying `missing` (the unanswered ids, allowlisted onto `ApiError.payload`),
 * and a malformed one -- a blank answer, an unknown id, an over-long answer --
 * is a 400 `invalid_prompt_answers`. Pass `{}` for a job with no prompts.
 */
export async function applyToJob(
  token: string,
  id: string,
  promptAnswers: Record<string, string>,
): Promise<Application> {
  const res = await apiFetch(
    `/worker/jobs/${id}/apply`,
    { method: 'POST', body: JSON.stringify({ prompt_answers: promptAnswers }) },
    token,
  );
  // A 400 from the required-docs guard carries `missing_docs`; the job page
  // renders one label per entry. parseApiError allowlists that field onto both
  // `err.payload.missing_docs` and `err.missing_docs`.
  if (!res.ok) throw await parseApiError(res, 'apply_failed');
  return res.json();
}

// ---------------------------------------------------------------------------
// Stage 2: the application-requirements door (S23 L2.4)
//
// `/worker/applications/{applicationId}` and its three write routes are the
// WEB door onto the same requirements engine WhatsApp runs
// (`infra/lambda/lib/application-requirements.ts`). Like the onboarding door
// above, every one of them answers with the WHOLE state document, so a caller
// never has to guess what a write changed: hydrate from the response and
// re-render.
//
// The door only accepts writes while the employer has the stage OPEN. Before
// `details_requested` and after the application closes, a write is refused
// with the fresh state attached -- see `ApplicationSaveResult`'s `blocked`.
// ---------------------------------------------------------------------------

/**
 * The state document `GET /worker/applications/{id}` returns, and that every
 * successful write returns again.
 *
 * `next_step` is typed LOOSELY on purpose. Server-side it is a six-member
 * discriminated union (`prompt | field | certification | doc | complete |
 * exit`, see `RequirementStep`), and it is the part of this contract most
 * likely to grow a member; narrowing it here would turn a backend addition
 * into a frontend compile error on a field no current caller branches on.
 * Read `kind` and widen this type when a caller actually needs the rest.
 */
export type ApplicationRequirementsState = {
  application: {
    id: string;
    job_id: string;
    status: ApplicationStatus;
    details_status: ApplicationDetailsStatus;
    stage: ApplicationStage;
    details_requested_at: string | null;
    details_completed_at: string | null;
    applied_at: string | null;
    updated_at: string | null;
  };
  job: {
    id: string;
    title: string | null;
    /** Resolved through `employer_display_name()`; null for an orphaned job. */
    company_name: string | null;
    status: JobStatus;
    required_fields: JobFieldKey[];
    optional_fields: JobFieldKey[];
    required_docs: DocType[];
    optional_docs: DocType[];
    certification_requirements: Array<{ name: string; tier: 'required' | 'optional'; proof_required: boolean }>;
    pre_application_prompts: PreApplicationPrompt[];
  };
  /** Field answers only -- the reserved `certifications` key is split out. */
  answers: Record<string, unknown>;
  certifications: CertificationClaim[];
  prompt_answers: Record<string, string>;
  /** Presence over the job's required + optional docs. */
  documents: Array<{ doc_type: string; present: boolean }>;
  remaining: ApplicationRequirementsRemaining;
  next_step: { kind: string; [key: string]: unknown };
};

/**
 * The three write doors return a UNION instead of throwing for their
 * documented 4xx codes, for the same reason `postOnboardingAnswers` does:
 * `ALLOWED_PAYLOAD_KEYS` in `./errors` is a closed allowlist and an
 * `ApiError` physically cannot carry the per-key `errors` map or the fresh
 * `state` these bodies ship. Widening the allowlist for one endpoint would
 * loosen the guarantee it exists to give.
 *
 * Everything else -- 5xx, offline, timeout, `worker_not_found`, an
 * unrecognized 4xx, or a 409 whose body did not survive a proxy -- still
 * throws `ApiError`. A 403 `legal_required` never reaches here at all:
 * `apiFetch` turns it into `LegalWallError` so the redirect still happens.
 */
export type ApplicationSaveResult =
  /** 200. The state AFTER the merge -- it may have flipped `details_status`. */
  | { kind: 'saved'; state: ApplicationRequirementsState }
  /**
   * 400 `invalid_answers`. `errors` maps the offending key to a reason code;
   * it is EMPTY for a shape-level rejection (not an object, no keys, too many
   * keys), which is still a 400 the form must render rather than throw.
   * The merge is all-or-nothing: nothing in the batch was stored.
   */
  | { kind: 'invalid'; errors: Record<string, string> }
  /**
   * 409. The stage is not open (`stage_locked`: the employer has not asked
   * for details yet) or the application is over (`application_closed`). Both
   * carry the fresh state, so the caller re-renders without a second GET.
   */
  | { kind: 'blocked'; reason: 'stage_locked' | 'application_closed'; state: ApplicationRequirementsState }
  /**
   * `payload_too_large`, from EITHER status: 413 is the pre-DB body cap
   * (16 KB, measured before parsing) and 400 is the post-merge column
   * overflow the door can only see after merging. Different events, one thing
   * for the worker to do -- write less.
   */
  | { kind: 'too_large' }
  /** 404 `not_found`: no such application, or not this worker's. */
  | { kind: 'not_found' }
  /** 409: this worker is at migration 078's per-certification document cap. */
  | { kind: 'certification_document_limit' };

export async function getApplicationRequirements(
  token: string,
  applicationId: string,
  signal?: AbortSignal,
): Promise<ApplicationRequirementsState> {
  const res = await apiFetch(`/worker/applications/${applicationId}`, { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

/**
 * The shared 200/4xx parser for the three write doors -- one implementation,
 * because all three answer with the same status/code vocabulary
 * (`mapFailure` in `api/worker-application-details.ts`) and three copies
 * would drift the first time a code was added.
 *
 * Reads the body through `clone()`: `apiFetch` has already read the original
 * stream on the way past for any 409 (the provisioning retry) and any 403
 * (the legal wall). An unparseable body falls through to the thrown
 * `ApiError` rather than producing a half-built union member.
 */
async function parseApplicationSaveResult(res: Response): Promise<ApplicationSaveResult> {
  if (res.ok) return { kind: 'saved', state: await res.json() };

  if (res.status === 400 || res.status === 404 || res.status === 409 || res.status === 413) {
    const parsed = await res.clone().json().catch(() => null) as {
      error?: unknown;
      errors?: unknown;
      state?: unknown;
    } | null;
    const code = typeof parsed?.error === 'string' ? parsed.error : '';
    const state = parsed?.state !== null && typeof parsed?.state === 'object'
      ? parsed.state as ApplicationRequirementsState
      : undefined;

    if (res.status === 400 && code === 'invalid_answers') {
      // A non-object `errors` degrades to an empty map: the union member is
      // still the right answer, and the caller iterates this.
      const errors = parsed?.errors !== null && typeof parsed?.errors === 'object' && !Array.isArray(parsed?.errors)
        ? parsed.errors as Record<string, string>
        : {};
      return { kind: 'invalid', errors };
    }
    // Matched on the CODE, not the status: the two `payload_too_large`
    // rejections arrive as 400 and 413 respectively.
    if (code === 'payload_too_large') return { kind: 'too_large' };
    if (res.status === 409 && code === 'certification_document_limit') {
      return { kind: 'certification_document_limit' };
    }
    if (res.status === 409 && (code === 'stage_locked' || code === 'application_closed') && state !== undefined) {
      return { kind: 'blocked', reason: code, state };
    }
    // ONLY the bare `not_found`. A 404 `worker_not_found` means the session's
    // worker row is gone -- an account-level failure, not something a form can
    // render -- and must keep throwing.
    if (res.status === 404 && code === 'not_found') return { kind: 'not_found' };
  }

  throw await parseApiError(res, 'save_failed');
}

/**
 * Field answers, keyed by the `required_fields`/`optional_fields` vocabulary.
 * At most 20 keys per call (the door rejects a larger batch outright rather
 * than truncating it), and the merge is all-or-nothing.
 */
export async function postApplicationAnswers(
  token: string,
  applicationId: string,
  answers: Record<string, unknown>,
): Promise<ApplicationSaveResult> {
  const res = await apiFetch(
    `/worker/applications/${applicationId}/answers`,
    { method: 'POST', body: JSON.stringify({ answers }) },
    token,
  );
  return parseApplicationSaveResult(res);
}

/** Certification-requirement claims, the same shape apply used to carry. */
export async function postApplicationCertifications(
  token: string,
  applicationId: string,
  claims: CertificationClaim[],
): Promise<ApplicationSaveResult> {
  const res = await apiFetch(
    `/worker/applications/${applicationId}/certifications`,
    { method: 'POST', body: JSON.stringify({ claims }) },
    token,
  );
  return parseApplicationSaveResult(res);
}

/**
 * Prompt answers, keyed on prompt id. WRITE-ONCE: an id that already has an
 * answer keeps the stored one (the merge is `new || existing`), so this
 * finishes a partial set rather than editing one. Deliberately NOT
 * stage-gated -- prompts belong to the apply stage, and a worker who
 * abandoned them mid-flow on WhatsApp completes them here.
 */
export async function postApplicationPromptAnswers(
  token: string,
  applicationId: string,
  answers: Record<string, string>,
): Promise<ApplicationSaveResult> {
  const res = await apiFetch(
    `/worker/applications/${applicationId}/prompt-answers`,
    { method: 'POST', body: JSON.stringify({ answers }) },
    token,
  );
  return parseApplicationSaveResult(res);
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
  /**
   * 409: someone else (WhatsApp) advanced the run. The body carries the fresh
   * state, so the retry usually needs no extra GET -- `state` is optional
   * only because a proxy-generated 409 would not have one.
   */
  | { kind: 'lock_conflict'; state?: OnboardingState }
  /** 422: the engine refused one step. `state` is the run as it stands now. */
  | { kind: 'step_rejected'; rejectedStepKey: string; reason: string; state: OnboardingState }
  /** 422: the client is behind the run. Refetch and re-render; do NOT retry. */
  | { kind: 'step_mismatch' }
  /** 409: this worker cannot be onboarded at all. A dead end, not a retry. */
  | { kind: 'blocked'; reason: 'suspended' | 'not_onboardable' };

/**
 * All four helpers take a trailing optional `AbortSignal`, mutations included:
 * a component that unmounts mid-save (a language switch is a route change, and
 * the flow does one) should be able to drop the request rather than have its
 * `.then` run against a dead tree.
 */
export async function getWorkerOnboarding(token: string, signal?: AbortSignal): Promise<OnboardingState> {
  const res = await apiFetch('/worker/onboarding', { signal }, token);
  if (!res.ok) throw await parseApiError(res, 'fetch_failed');
  return res.json();
}

export async function postOnboardingAnswers(
  token: string,
  body: OnboardingAnswersBody,
  signal?: AbortSignal,
): Promise<OnboardingSaveResult> {
  const res = await apiFetch(
    '/worker/onboarding/answers',
    { method: 'POST', body: JSON.stringify(body), signal },
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
    const state = parsed?.state !== null && typeof parsed?.state === 'object'
      ? parsed.state as OnboardingState
      : undefined;

    if (res.status === 409 && parsed?.error === 'lock_conflict') {
      return { kind: 'lock_conflict', state };
    }
    if (res.status === 409 && (parsed?.error === 'suspended' || parsed?.error === 'not_onboardable')) {
      return { kind: 'blocked', reason: parsed.error };
    }
    if (res.status === 422 && parsed?.error === 'step_mismatch') {
      return { kind: 'step_mismatch' };
    }
    if (
      res.status === 422
      && parsed?.error === 'step_rejected'
      && typeof parsed.rejectedStepKey === 'string'
      && typeof parsed.reason === 'string'
      && state !== undefined
    ) {
      return { kind: 'step_rejected', rejectedStepKey: parsed.rejectedStepKey, reason: parsed.reason, state };
    }
  }

  // Everything left over -- 404 `worker_not_found`, 422 `unknown_step` (a
  // client bug, not something a worker can act on), 5xx, transport failures --
  // throws like every other helper in this module.
  throw await parseApiError(res, 'save_failed');
}

export async function postOnboardingBack(
  token: string,
  body: { lockVersion: number },
  signal?: AbortSignal,
): Promise<OnboardingState> {
  const res = await apiFetch(
    '/worker/onboarding/back',
    { method: 'POST', body: JSON.stringify(body), signal },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'save_failed');
  return res.json();
}

export async function patchOnboardingLanguage(
  token: string,
  body: { preferredLanguage: 'en' | 'es' },
  signal?: AbortSignal,
): Promise<OnboardingState> {
  const res = await apiFetch(
    '/worker/onboarding/language',
    { method: 'PATCH', body: JSON.stringify(body), signal },
    token,
  );
  if (!res.ok) throw await parseApiError(res, 'save_failed');
  return res.json();
}

// ---------------------------------------------------------------------------
// Voice answers on the web onboarding (S23 L6)
//
// Three more actions on the SAME `/worker/onboarding/{action}` resource — the
// API has no room for a `voice/*` subtree, and did not need one. The shape is:
//
//   presign -> PUT the recording straight to S3 -> start the transcription
//   -> poll -> put the text in the worker's textarea for them to fix
//
// The transcript is never submitted on the worker's behalf. Dictation in a
// noisy yard is not accurate enough to commit unseen; they read it, edit it,
// and press the same button a typed answer presses (`postOnboardingAnswers`,
// with `source: 'voice'` on the value).
//
// Every helper below returns a DISCRIMINATED RESULT rather than throwing, for
// the same reason `postOnboardingAnswers` does: none of these failures is
// exceptional. A denied microphone, a transcription that heard only wind, an
// expired upload URL — each is an ordinary thing that happens to a worker
// standing on a job site, and each has its own sentence to show them. Only a
// genuinely unexpected transport failure becomes the generic `failed`.
// ---------------------------------------------------------------------------

/** Exactly the MIME types the door's allowlist accepts. */
export const VOICE_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
] as const;

/** The door's own cap (`MAX_WEB_VOICE_BYTES`), mirrored so a too-long recording
 * is stopped here rather than by a 400 after the upload. */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

export type VoiceUploadTarget = { key: string; url: string; expiresAt: string };

export type VoiceUploadUrlResult =
  | { kind: 'ready'; target: VoiceUploadTarget }
  /** The recording is unusable as it stands: wrong container, or too big. */
  | { kind: 'rejected'; reason: 'invalid_content_type' | 'file_too_large' }
  | { kind: 'failed' };

export async function postOnboardingVoiceUploadUrl(
  token: string,
  body: { stepKey: string; questionIndex: number; contentType: string; sizeBytes: number },
  signal?: AbortSignal,
): Promise<VoiceUploadUrlResult> {
  let res: Response;
  try {
    res = await apiFetch(
      '/worker/onboarding/voice-upload-url',
      { method: 'POST', body: JSON.stringify(body), signal },
      token,
    );
  } catch {
    return { kind: 'failed' };
  }
  if (res.ok) return { kind: 'ready', target: await res.json() };

  const parsed = await res.clone().json().catch(() => null) as { error?: unknown } | null;
  if (parsed?.error === 'invalid_content_type' || parsed?.error === 'file_too_large') {
    return { kind: 'rejected', reason: parsed.error };
  }
  return { kind: 'failed' };
}

/**
 * Raw `fetch`, deliberately: a presigned S3 PUT carries its signature in the
 * URL and MUST NOT be sent an `Authorization` header — S3 would treat it as a
 * competing SigV4 credential and refuse the request.
 */
export async function putVoiceRecording(
  url: string,
  blob: Blob,
  contentType: string,
  signal?: AbortSignal,
): Promise<{ kind: 'uploaded' } | { kind: 'failed' }> {
  try {
    const res = await fetch(url, {
      method: 'PUT',
      body: blob,
      // Must match the type that was SIGNED, not `blob.type` (which carries
      // codec parameters MediaRecorder added).
      headers: { 'Content-Type': contentType },
      signal,
    });
    return res.ok ? { kind: 'uploaded' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type VoiceTranscribeStartResult =
  | { kind: 'started'; transcriptOutputKey: string }
  /** The other door moved the run; the caller should re-read and not retry. */
  | { kind: 'lock_conflict' }
  | { kind: 'step_mismatch' }
  | { kind: 'failed' };

export async function postOnboardingVoiceTranscribe(
  token: string,
  body: { key: string; stepKey: string; questionIndex: number; lockVersion: number },
  signal?: AbortSignal,
): Promise<VoiceTranscribeStartResult> {
  let res: Response;
  try {
    res = await apiFetch(
      '/worker/onboarding/voice-transcribe',
      { method: 'POST', body: JSON.stringify(body), signal },
      token,
    );
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 202) {
    const parsed = await res.json().catch(() => null) as { transcriptOutputKey?: unknown } | null;
    return typeof parsed?.transcriptOutputKey === 'string'
      ? { kind: 'started', transcriptOutputKey: parsed.transcriptOutputKey }
      : { kind: 'failed' };
  }
  const parsed = await res.clone().json().catch(() => null) as { error?: unknown } | null;
  if (res.status === 409 && parsed?.error === 'lock_conflict') return { kind: 'lock_conflict' };
  if (res.status === 422 && parsed?.error === 'step_mismatch') return { kind: 'step_mismatch' };
  return { kind: 'failed' };
}

export type VoiceResultOutcome =
  /** 202 — Transcribe writes its output once, at the end, so this is
   * "still working", not "nothing there". */
  | { kind: 'pending' }
  | { kind: 'transcribed'; transcript: string; confidence?: number }
  /** 410 — the attempt is over and produced nothing usable. Not retryable. */
  | { kind: 'unusable' }
  | { kind: 'failed' };

export async function postOnboardingVoiceResult(
  token: string,
  body: { transcriptOutputKey: string },
  signal?: AbortSignal,
): Promise<VoiceResultOutcome> {
  let res: Response;
  try {
    res = await apiFetch(
      '/worker/onboarding/voice-result',
      { method: 'POST', body: JSON.stringify(body), signal },
      token,
    );
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 202) return { kind: 'pending' };
  if (res.status === 410) return { kind: 'unusable' };
  if (res.ok) {
    const parsed = await res.json().catch(() => null) as
      { transcript?: unknown; confidence?: unknown } | null;
    if (typeof parsed?.transcript !== 'string' || parsed.transcript.trim().length === 0) {
      return { kind: 'unusable' };
    }
    return {
      kind: 'transcribed',
      transcript: parsed.transcript,
      ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
    };
  }
  return { kind: 'failed' };
}
