import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { computeRemaining, detailsStatusFor } from '../lib/application-requirements';
import { remainingView, snapshotFromRow } from '../lib/application-stage-view';
import { parsePreApplicationPromptList } from '../lib/pre-application-prompts';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_id' }) };
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

    const workerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (workerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    const workerId: string = workerRes.rows[0].id;
    await setInternalUserRlsContext(client, workerId);

    // employer_display_name() flips a transaction-local employer_profiles read
    // flag until COMMIT (migration 031). The queries after this one touch only
    // worker_documents and job_applications — keep it that way.
    const jobRes = await client.query(
      `SELECT j.id, j.title, j.location, j.pay, j.job_type, CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS status, j.description, j.required_docs, j.created_at,
              j.pay_min, j.pay_max, j.pay_interval, j.start_date, j.expected_duration, j.shift_schedule,
              j.transportation_required, j.work_authorization_required, j.language_preference, j.number_of_workers_needed,
              j.workers_hired AS hired_count,
              GREATEST(j.number_of_workers_needed - j.workers_hired, 0) AS open_count,
              j.trade_category, j.required_experience_years, j.required_experience_months, j.certifications,
              j.trade_category_other, j.expected_duration_bucket, j.work_days, j.shift_start, j.shift_end, j.certification_requirements,
              j.public_listing_enabled, j.city_key,
              j.required_fields, j.optional_fields, j.optional_docs,
              j.pre_application_prompts,
              employer_display_name(j.employer_id) AS company_name
       FROM jobs j
       WHERE j.id = $1
         AND (
           j.status = 'active'
           OR EXISTS (
             SELECT 1
             FROM job_applications ja
             WHERE ja.job_id = j.id
               AND ja.worker_id = $2
           )
         )`,
      [jobId, workerId],
    );
    if (jobRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_found' }) };
    }
    const job = jobRes.rows[0];
    const requiredDocs: string[] = Array.isArray(job.required_docs) ? job.required_docs : [];
    const optionalDocs: string[] = Array.isArray(job.optional_docs) ? job.optional_docs : [];
    const requiredFields: string[] = Array.isArray(job.required_fields) ? job.required_fields : [];
    const optionalFields: string[] = Array.isArray(job.optional_fields) ? job.optional_fields : [];

    // ── TWO doc scopes from ONE probe ────────────────────────────────────
    // `job_scoped` marks the rows already attached to THIS job -- the only
    // ones 091's hire gate and the employer's `remaining` count. The full
    // set (vault rows included) is what the WORKER's own "do I still need to
    // upload this?" question means, and it is what missing_docs has always
    // answered; narrowing it to job-scoped would tell every vault-holding
    // worker to re-upload, since only a worker-session document sync
    // materializes those job rows and this handler deliberately runs none
    // (jale_admin session -- the sync sets a worker GUC and writes to
    // FORCE-RLS worker_documents).
    //
    // The probe now covers OPTIONAL doc types too: without that widening,
    // every optional doc would read as missing no matter what the worker
    // holds, and optional_unanswered below would name all of them.
    const probeDocTypes = Array.from(new Set([...requiredDocs, ...optionalDocs]));
    const docsRes = probeDocTypes.length > 0
      ? await client.query(
        `SELECT DISTINCT doc_type, (job_id IS NOT NULL AND job_id = $3::uuid) AS job_scoped
           FROM worker_documents
          WHERE worker_id = $1
            AND doc_type = ANY($2::text[])
            AND (job_id IS NULL OR job_id = $3::uuid)`,
        [workerId, probeDocTypes, jobId],
      )
      : { rows: [] };
    const docRows: any[] = Array.isArray(docsRes.rows) ? docsRes.rows : [];
    const vaultOrJobDocs = docRows.map((r) => r.doc_type);
    const jobScopedDocs = docRows.filter((r) => r.job_scoped).map((r) => r.doc_type);

    const appRes = await client.query(
      `SELECT id AS application_id,
              CASE status
                WHEN 'reviewed' THEN 'contacted'
                WHEN 'rejected' THEN 'not_interested'
                ELSE status
              END AS status,
              application_answers,
              prompt_answers,
              details_requested_at,
              details_completed_at
       FROM job_applications
       WHERE job_id = $1 AND worker_id = $2`,
      [jobId, workerId],
    );
    const already_applied = appRes.rows.length > 0;
    const app = already_applied ? appRes.rows[0] : {};
    const application_status = already_applied ? app.status : null;

    // The hand-rolled key-presence lists are gone: BOTH bucket sets below now
    // come from the shared pure engine, so this page can never disagree with
    // what the employer sees or with what the stage-2 door will ask for.
    // Before the worker applies there is no application row at all -- the
    // snapshot is then built from the job's columns alone and everything
    // reads as outstanding, exactly as before.
    const jobColumns = {
      job_id: jobId,
      job_status: job.status,
      required_fields: requiredFields,
      optional_fields: optionalFields,
      required_docs: requiredDocs,
      optional_docs: optionalDocs,
      certification_requirements: job.certification_requirements,
      pre_application_prompts: job.pre_application_prompts,
    };

    // Published `remaining`: JOB-SCOPED docs, so it agrees with the employer
    // surfaces and with 091's hire gate.
    const remaining = computeRemaining(snapshotFromRow({ ...jobColumns, ...app, have_docs: jobScopedDocs }));
    // Legacy worker-facing keys: the SAME engine on the VAULT-OR-JOB set,
    // which is what those three keys have always meant. See the probe above.
    const workerRemaining = computeRemaining(snapshotFromRow({ ...jobColumns, ...app, have_docs: vaultOrJobDocs }));

    // `docs` (not requiredDocs minus uploaded) so an UNCOLLECTABLE legacy
    // required doc -- 'ssn', which no flow can collect -- stops being shown
    // to a worker who can never satisfy it.
    const missing_docs = workerRemaining.docs;
    const missing_fields = workerRemaining.fields;
    // Widened by 091 to include missing OPTIONAL DOCS alongside unanswered
    // optional fields, matching the employer's `not_provided` list.
    const optional_unanswered = [...workerRemaining.optionalFields, ...workerRemaining.optionalDocs];

    await client.query('COMMIT');
    // Never spread `job` directly into the response after this point without
    // checking it doesn't carry application_answers -- it doesn't (that
    // column lives on job_applications, not jobs), but the omission below is
    // deliberate: this v1 endpoint is write-once and must expose only
    // derived key lists (missing_fields/optional_unanswered), never raw
    // answer values, to the worker.
    return {
      statusCode: 200, headers: CORS_HEADERS,
      body: JSON.stringify({
        ...job,
        required_docs: requiredDocs,
        optional_docs: optionalDocs,
        required_fields: requiredFields,
        optional_fields: optionalFields,
        pre_application_prompts: parsePreApplicationPromptList(job.pre_application_prompts),
        already_applied,
        application_status,
        missing_docs,
        missing_fields,
        optional_unanswered,
        // Stage vocabulary only once there IS an application -- there is no
        // stage to report for a job the worker has not applied to.
        ...(already_applied
          ? {
            application_id: app.application_id,
            details_status: detailsStatusFor(app, remaining),
            stage: app.details_requested_at ? 'details' : 'apply',
            remaining: remainingView(remaining),
          }
          : {}),
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-detail error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
