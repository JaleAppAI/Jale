import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { remainingCount, remainingView, snapshotFromRow } from '../lib/application-stage-view';
import { computeRemaining, detailsStatusFor } from '../lib/application-requirements';
import { buildHireSummary } from '../lib/application-hire-view';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    // The jobs_worker_read_applied policy (migration 070) is keyed on
    // app.current_internal_user_id; without it the join below drops every
    // non-active job the worker applied to. Same idiom as worker-jobs-detail.
    const workerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (workerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    await setInternalUserRlsContext(client, workerRes.rows[0].id);

    // employer_display_name() flips a transaction-local GUC that makes ALL
    // employer_profiles rows readable until COMMIT (migration 031) — no query
    // touching employer_profiles may be added after this one in this
    // transaction. paused is coalesced to closed: billing auto-pause is the
    // employer's private state (spec: workers never see 'paused').
    const result = await client.query(
      `SELECT a.id AS application_id, a.job_id,
              CASE a.status
                WHEN 'reviewed' THEN 'contacted'
                WHEN 'rejected' THEN 'not_interested'
                ELSE a.status
              END AS status,
              a.applied_at,
              a.details_requested_at,
              a.details_completed_at,
              -- 095 hire celebration. COALESCE, not a bare a.hired_at: a
              -- worker hired in the window between migration 095 and this
              -- code deploy has a NULL hired_at (nothing wrote it yet) and
              -- must still get their celebration. updated_at is NOT NULL
              -- (003), so the projected value is never null -- which is what
              -- lets the response contract promise a non-null hire.hired_at.
              -- Every historical hire was stamped by 095 itself, so this
              -- fallback can never resurrect an old one.
              COALESCE(a.hired_at, a.updated_at) AS hired_at,
              a.hired_seen_at,
              a.hired_ack_at,
              j.title AS job_title,
              employer_display_name(j.employer_id) AS company_name,
              CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status,
              -- 091 engine inputs. All of these are STRIPPED below: this list
              -- publishes only the derived stage vocabulary, never the raw
              -- answers or the job's requirement arrays.
              a.application_answers, a.prompt_answers,
              j.required_fields, j.optional_fields,
              j.required_docs, j.optional_docs,
              j.certification_requirements, j.pre_application_prompts,
              -- The job facts the celebration repeats under "You've been
              -- hired". Also stripped below, and published ONLY through the
              -- hire object on a hired row. job_-prefixed so a strip that
              -- misses one is obvious in the response rather than silently
              -- shadowing an application column.
              --
              -- to_char, because jobs.start_date is a DATE: node-postgres parses a DATE
              -- into a JS Date at LOCAL midnight, which JSON.stringify then
              -- emits as a full ISO timestamp -- and, west of UTC, as the
              -- PREVIOUS calendar day.
              to_char(j.start_date, 'YYYY-MM-DD') AS job_start_date,
              j.location AS job_location,
              j.city AS job_city,
              j.state AS job_state,
              j.pay AS job_pay,
              j.pay_min AS job_pay_min,
              j.pay_max AS job_pay_max,
              j.pay_interval AS job_pay_interval,
              j.shift_schedule AS job_shift_schedule,
              -- JOB-SCOPED, matching what 091's hire gate measures and what
              -- the employer's own list reports. No document sync here: the
              -- sync writes to FORCE-RLS worker_documents and this is a
              -- read-only list.
              ARRAY(
                SELECT DISTINCT wd.doc_type
                  FROM worker_documents wd
                 WHERE wd.worker_id = a.worker_id
                   AND wd.job_id = a.job_id
              ) AS have_docs
       FROM job_applications a
       JOIN jobs j ON j.id = a.job_id
       ORDER BY a.applied_at DESC
       LIMIT 200`,
    );
    await client.query('COMMIT');

    // One pure computeRemaining per row on columns already selected -- no
    // per-application engine round trip, and the same answer the worker's
    // own job page and the employer's applicant list give.
    const applications = result.rows.map((row: any) => {
      const {
        application_answers: _answers,
        prompt_answers: _promptAnswers,
        have_docs: _haveDocs,
        required_fields: _requiredFields,
        optional_fields: _optionalFields,
        required_docs: _requiredDocs,
        optional_docs: _optionalDocs,
        certification_requirements: _certReqs,
        pre_application_prompts: _prompts,
        // 095: raw hire state and raw job facts. Stripped on EVERY row,
        // hired or not -- `hire` below is the only thing that publishes them,
        // so a non-hired row is byte-for-byte what it was before 095.
        hired_at: _hiredAt,
        hired_seen_at: _hiredSeenAt,
        hired_ack_at: _hiredAckAt,
        job_start_date: _jobStartDate,
        job_location: _jobLocation,
        job_city: _jobCity,
        job_state: _jobState,
        job_pay: _jobPay,
        job_pay_min: _jobPayMin,
        job_pay_max: _jobPayMax,
        job_pay_interval: _jobPayInterval,
        job_shift_schedule: _jobShiftSchedule,
        ...application
      } = row;
      const remaining = computeRemaining(snapshotFromRow(row));
      // Only a hired row carries a celebration. `buildHireSummary` returns
      // null only for a row with no hire timestamp at all, which the COALESCE
      // above makes unreachable from the database -- and if it ever happened,
      // no `hire` key is the right answer, not a null timestamp the browser
      // would render as an empty hire date.
      const hire = row.status === 'hired' ? buildHireSummary(row) : null;
      return {
        ...application,
        details_status: detailsStatusFor(row, remaining),
        stage: row.details_requested_at ? 'details' : 'apply',
        remaining_count: remainingCount(remaining),
        remaining: remainingView(remaining),
        ...(hire ? { hire } : {}),
      };
    });

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ applications }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-applications-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
