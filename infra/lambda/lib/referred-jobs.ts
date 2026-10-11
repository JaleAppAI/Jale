import type { PoolClient } from 'pg';

/**
 * The per-worker referred-jobs list (`worker_referred_jobs`, migration 103):
 * the jobs a worker came to Jale for, recorded from every door and read by
 * the feed pin and the web onboarding Done screen. It is NOT referral credit
 * -- first-touch credit stays in `worker_attribution` (referral-attribution.ts).
 *
 * Every statement carries an explicit `worker_id = $1`: that predicate is the
 * boundary and the table's policies are defence in depth only; every jobs
 * read that means "open" says `status = 'active'` itself for the same reason.
 *
 * Caller owns the transaction, the role's RLS setting (`setRlsContext` for
 * the request login, `setInternalUserRlsContext` for jale_whatsapp) and any
 * SAVEPOINT: nothing here opens one, and a database error reaches the caller.
 */

export type ReferredJobSource = 'share_link' | 'job_page' | 'whatsapp_token' | 'typed_code' | 'backfill';

/**
 * Upserts the (worker, job) row in the caller's transaction -- ONLY while the
 * job exists and is active: the INSERT selects from jobs, so an unknown,
 * paused, filled or closed job writes nothing and can never raise a foreign
 * key error. A re-record keeps first_seen_at and moves last_seen_at (the sort
 * key) and source. Returns true when a row was inserted or refreshed.
 */
export async function recordReferredJob(
  client: PoolClient,
  input: { workerId: string; jobId: string; source: ReferredJobSource; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await client.query(
    `INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
     SELECT $1::uuid, j.id, $3::text, $4::timestamptz, $4::timestamptz
       FROM jobs j
      WHERE j.id = $2
        AND j.status = 'active'
     ON CONFLICT (worker_id, job_id) DO UPDATE
        SET last_seen_at = EXCLUDED.last_seen_at,
            source = EXCLUDED.source`,
    [input.workerId, input.jobId, input.source, now.toISOString()],
  );
  return result.rowCount === 1;
}

/**
 * The not-applied predicate, bound to the worker explicitly: ANY
 * job_applications row for (job, this worker) counts as applied, and another
 * worker's application must never hide this worker's job.
 */
const NOT_APPLIED_BY_WORKER = `NOT EXISTS (
            SELECT 1
              FROM job_applications ja
             WHERE ja.job_id = r.job_id
               AND ja.worker_id = $1
          )`;

/**
 * Ids of the worker's referred jobs that are open (status = 'active') and not
 * applied to, newest last_seen_at first, job id breaking ties. No limit means
 * all of them.
 */
export async function listOpenReferredJobIds(
  client: PoolClient,
  workerId: string,
  opts: { limit?: number } = {},
): Promise<string[]> {
  const result = await client.query<{ job_id: string }>(
    `SELECT r.job_id
       FROM worker_referred_jobs r
       JOIN jobs j ON j.id = r.job_id
      WHERE r.worker_id = $1
        AND j.status = 'active'
        AND ${NOT_APPLIED_BY_WORKER}
      ORDER BY r.last_seen_at DESC, r.job_id
      LIMIT $2`,
    // A NULL LIMIT is no limit.
    [workerId, opts.limit ?? null],
  );
  return result.rows.map((row) => row.job_id);
}

export interface ReferredJobSummary {
  id: string;
  title: string;
  /** COALESCE(j.company, 'Jale') -- the feed's expression (job-matching.ts). */
  company: string;
  location: string;
  payMin: number | null;
  payMax: number | null;
  payInterval: string | null;
  /** jobs.pay, the employer's own pay text. */
  payRaw: string | null;
  /** jobs.status = 'active'. */
  open: boolean;
}

interface ReferredJobSummaryRow {
  id: string;
  title: string;
  company: string;
  location: string;
  pay_min: number | null;
  pay_max: number | null;
  pay_interval: string | null;
  pay_raw: string | null;
  open: boolean;
}

/**
 * The one job for the web Done screen and job strip: the newest UNAPPLIED
 * referred job, open ones first -- so a job that closed after it was recorded
 * still comes back (open: false) once nothing open is left. The company is
 * read straight off jobs, never through employer_display_name(): that is a
 * SECURITY DEFINER with a transaction-wide side effect, and jale_whatsapp has
 * no employer_profiles grant.
 */
export async function getReferredJobForOnboarding(
  client: PoolClient,
  workerId: string,
): Promise<ReferredJobSummary | null> {
  const result = await client.query<ReferredJobSummaryRow>(
    `SELECT j.id,
            j.title,
            COALESCE(j.company, 'Jale') AS company,
            j.location,
            j.pay_min,
            j.pay_max,
            j.pay_interval,
            j.pay AS pay_raw,
            (j.status = 'active') AS open
       FROM worker_referred_jobs r
       JOIN jobs j ON j.id = r.job_id
      WHERE r.worker_id = $1
        AND ${NOT_APPLIED_BY_WORKER}
      ORDER BY (j.status = 'active') DESC, r.last_seen_at DESC, r.job_id
      LIMIT 1`,
    [workerId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    payMin: row.pay_min,
    payMax: row.pay_max,
    payInterval: row.pay_interval,
    payRaw: row.pay_raw,
    open: row.open,
  };
}
