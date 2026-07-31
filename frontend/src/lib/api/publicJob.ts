// Client for the unauthenticated public job page (GET /public/jobs/{code} and
// POST /public/jobs/{code}/apply-intent). No Authorization header is ever
// attached here -- these routes are reachable by a logged-out visitor who
// opened a shared link.
//
// Field names below mirror infra/lambda/api/public-job.ts's PUBLIC_JOB_COLUMNS
// and infra/lambda/api/public-job-apply-intent.ts's response body exactly --
// do not add fields the API cannot return (e.g. employer contact details).

export type JobLanguagePreference = 'any' | 'en' | 'es';
export type PublicJobDocType = 'resume' | 'driver_license' | 'ssn';

export interface PublicJobActive {
  code: string;
  /** Internal worker-job UUID; added by a parallel backend task, so it may
   * be absent on older payloads. Only used to build the "Apply on the
   * website" link -- code defensively against it being undefined. */
  id?: string;
  title: string;
  company: string;
  location: string;
  job_type: string;
  description: string | null;
  pay?: string | null;
  pay_min?: number | null;
  pay_max?: number | null;
  pay_interval?: string | null;
  start_date?: string | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  trade_category?: string | null;
  required_experience_years?: number | null;
  required_experience_months?: number | null;
  certifications?: string[] | null;
  language_preference?: JobLanguagePreference[] | null;
  transportation_required?: boolean | null;
  work_authorization_required?: boolean | null;
  number_of_workers_needed?: number | null;
  required_docs: PublicJobDocType[];
  status: 'active';
  created_at: string;
}

export interface PublicJobClosed {
  code: string;
  title: string;
  company: string;
  location: string;
  status: 'closed';
  applications_closed: true;
}

export type PublicJob = PublicJobActive | PublicJobClosed;

export function isClosedJob(job: PublicJob): job is PublicJobClosed {
  return 'applications_closed' in job && job.applications_closed === true;
}

export class PublicJobNotFoundError extends Error {
  constructor() {
    super('not_found');
    this.name = 'PublicJobNotFoundError';
    Object.setPrototypeOf(this, PublicJobNotFoundError.prototype);
  }
}

/**
 * Fetches the public projection of a job by its short public code.
 *
 * `shareCode` is the raw `?r=` value, passed straight through untouched -- a
 * missing or malformed value is not validated client-side; the API silently
 * ignores an unmatched share code and still returns the job normally.
 *
 * Uses `cache: 'no-store'` so status changes (e.g. a job closing) are always
 * reflected, and so the open-recording side effect on the API fires once per
 * real visit. Next.js's fetch request memoization (same URL + options within
 * one render pass) means calling this from both `generateMetadata` and the
 * page component for the same request dedupes to a single network call --
 * do not add a `no-cache`-busting query param or a differing options object
 * between those two call sites, or opens will be double-counted.
 */
export async function getPublicJob(code: string, shareCode?: string | null): Promise<PublicJob> {
  const qs = shareCode ? `?r=${encodeURIComponent(shareCode)}` : '';
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/public/jobs/${encodeURIComponent(code)}${qs}`,
    { cache: 'no-store' },
  );
  if (res.status === 404) throw new PublicJobNotFoundError();
  if (!res.ok) throw new Error('public_job_fetch_failed');
  return res.json();
}

export interface ApplyIntentResponse {
  token: string;
  whatsappUrl: string;
}

export async function applyIntent(code: string, shareCode?: string | null): Promise<ApplyIntentResponse> {
  const qs = shareCode ? `?r=${encodeURIComponent(shareCode)}` : '';
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_BASE_URL}/public/jobs/${encodeURIComponent(code)}/apply-intent${qs}`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!res.ok) throw new Error('apply_intent_failed');
  return res.json();
}
