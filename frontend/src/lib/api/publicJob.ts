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
  /** Structured location columns added by a parallel backend task, for
   * schema.org jobLocation. May be absent on older payloads -- code
   * defensively against undefined, same as `id` above. */
  city?: string | null;
  state_region?: string | null;
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

/** One row of the public job listing feed (GET /public/jobs), used by the
 * sitemap and RSS feed. A narrower projection than PublicJobActive --
 * mirrors whatever `infra/lambda/api/public-job-list.ts` (a parallel
 * backend task) actually returns for this endpoint. */
export interface PublicJobListItem {
  code: string;
  title: string;
  city?: string | null;
  state_region?: string | null;
  trade_category?: string | null;
  created_at: string;
  updated_at: string;
}

interface PublicJobsListResponse {
  jobs: PublicJobListItem[];
  next_cursor: string | null;
}

/** Maximum pages to follow before giving up, so a misbehaving API (a
 * `next_cursor` that never goes null) can't hang the sitemap/feed build. */
const MAX_LIST_PAGES = 200;

/** How many times to retry the SAME page on a 429 before giving up on it. */
const MAX_PAGE_RETRIES = 2;

/** Delay between 429 retries. A fixed backoff, not exponential -- this is a
 * best-effort sitemap/feed build, not a critical write path, so the extra
 * complexity of backoff growth isn't worth it for two retries. */
const RETRY_DELAY_MS = 500;

/** Default delay implementation. Tests inject their own via the `delayFn`
 * parameter (fake timers interact poorly with an async retry loop awaiting a
 * real setTimeout, so an injectable delay is simpler to assert against). */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fetches every active public job by following `next_cursor` until it goes
 * null. Used to build the sitemap and RSS feed at request time.
 *
 * A 429 on any single page is retried in place (same cursor, same page) up
 * to MAX_PAGE_RETRIES times with a fixed delay, before that page is treated
 * like any other non-ok response. Whenever the walk ends early for a non-ok
 * response (429 exhausted or any other non-2xx status), a
 * 'PublicJobsListTruncated' metric is logged with the status that caused it,
 * so a partial sitemap/feed is observable instead of silently looking
 * complete.
 *
 * Never throws: sitemap.ts and feed.xml must never 500, so any fetch or
 * parse failure here is swallowed and whatever pages were already
 * accumulated (possibly none) are returned instead.
 */
export async function getPublicJobsList(
  delayFn: (ms: number) => Promise<void> = defaultDelay,
): Promise<PublicJobListItem[]> {
  const results: PublicJobListItem[] = [];
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return results;

  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const qs = new URLSearchParams({ limit: '500' });
      if (cursor) qs.set('cursor', cursor);
      const url = `${base}/public/jobs?${qs.toString()}`;

      let res: Response = await fetch(url, { cache: 'no-store' });
      for (let retry = 0; res.status === 429 && retry < MAX_PAGE_RETRIES; retry += 1) {
        await delayFn(RETRY_DELAY_MS);
        res = await fetch(url, { cache: 'no-store' });
      }

      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ metric: 'PublicJobsListTruncated', status: res.status }));
        break;
      }
      const body: PublicJobsListResponse = await res.json();
      if (Array.isArray(body?.jobs)) results.push(...body.jobs);
      cursor = body?.next_cursor ?? null;
      if (!cursor) break;
    }
  } catch {
    // Tolerate any fetch/parse failure -- return whatever was accumulated.
  }
  return results;
}
