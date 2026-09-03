import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getPublicJobsDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { normalizeCode, isValidJobCode } from '../lib/referral-codes';
import { parsePreApplicationPromptList } from '../lib/pre-application-prompts';

/**
 * GET /public/jobs/{code}
 *
 * Unauthenticated. Connects as jale_public_jobs (see lib/db.ts getPublicJobsDbPool).
 * NEVER calls setRlsContext -- there is no Cognito sub on this route. Access
 * control is the jobs_public_read RLS policy plus the column-scoped GRANT from
 * migration 056, not handler discipline.
 *
 * Open-recording (the `r` share-code param, crawler filtering, visitor
 * hashing, the job_share_opens insert + open_count bump) lives in the sibling
 * POST /public/jobs/{code}/open handler (public-job-open.ts), not here -- this
 * route is a pure, idempotent read.
 */

const CORS_HEADERS = corsHeaders();

// Column list matches exactly the GRANT SELECT (...) ON jobs TO jale_public_jobs
// list in migration 056, extended by migration 061's column-scoped grant of
// city/state_region/updated_at (added for the public job page's schema.org
// jobLocation), and further extended by migration 077's column-scoped grant
// of the six BE-T2 structured fields below, and by migration 091's
// column-scoped grant of pre_application_prompts (the public job page shows
// the employer's stage-1 questions before a visitor signs up). employer_id
// and any OTHER geo column from 009 remain deliberately absent from that
// grant and must never be added here.
const PUBLIC_JOB_COLUMNS = `
  id, public_code AS code, title, company, location, city, state_region,
  job_type, description,
  pay, pay_min, pay_max, pay_interval, start_date, expected_duration,
  shift_schedule, trade_category, required_experience_years,
  required_experience_months, certifications, language_preference,
  transportation_required, work_authorization_required,
  number_of_workers_needed, required_docs, status, created_at,
  trade_category_other, expected_duration_bucket, work_days,
  shift_start, shift_end, certification_requirements, pre_application_prompts
`;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const rawCode = event.pathParameters?.code;
    if (!rawCode) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_code' }) };
    }
    const code = normalizeCode(rawCode);
    if (!isValidJobCode(code)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_code' }) };
    }

    const pool = await getPublicJobsDbPool();
    client = await pool.connect();

    // RLS's jobs_public_read policy (public_listing_enabled) already makes an
    // opted-out job invisible here -- it lands in the same zero-row branch as
    // a code that never existed, which is exactly the point: both are 404,
    // identically.
    const jobResult = await client.query(
      `SELECT ${PUBLIC_JOB_COLUMNS} FROM jobs WHERE public_code = $1`,
      [code],
    );

    if (jobResult.rows.length === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    const job = jobResult.rows[0];

    // Fails OPEN, like every other reader of this column: a corrupt or
    // hand-edited row degrades to "this job asks no prompts" rather than
    // 500-ing an unauthenticated, crawler-visible page.
    job.pre_application_prompts = parsePreApplicationPromptList(job.pre_application_prompts);

    // Older jobs predate the `company` column backfill; fall back to the
    // employer's profile via the SECURITY DEFINER function rather than
    // widening this role's grant onto employer_profiles.
    if (!job.company) {
      const cr = await client.query('SELECT public_job_company($1) AS company', [job.id]);
      job.company = cr.rows[0]?.company ?? null;
    }

    if (job.status !== 'active') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          code: job.code,
          title: job.title,
          company: job.company,
          location: job.location,
          status: 'closed',
          applications_closed: true,
        }),
      };
    }

    // `id` IS included here, deliberately, for an active job only -- the
    // closed view above must never gain it. Any authenticated worker can
    // already read any active job by UUID (RLS policy jobs_worker_read_active,
    // migration 007/020b/038), so this leaks nothing new; it's what lets the
    // post-signup redirect land straight on the existing /worker/jobs/{id}
    // page with zero new lookup endpoints.
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(job),
    };
  } catch (err) {
    console.error('public-job error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
