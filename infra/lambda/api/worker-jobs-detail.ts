import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isPlainObject } from '../lib/application-answers';
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
              j.public_listing_enabled, j.city_key,
              j.required_fields, j.optional_fields, j.optional_docs,
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

    const docsRes = requiredDocs.length > 0
      ? await client.query(
        `SELECT DISTINCT doc_type FROM worker_documents
         WHERE worker_id = $1
           AND doc_type = ANY($2::text[])
           AND (job_id IS NULL OR job_id = $3::uuid)`,
        [workerId, requiredDocs, jobId],
      )
      : { rows: [] };
    const uploadedTypes = new Set(docsRes.rows.map((r: any) => r.doc_type));
    const missing_docs = requiredDocs.filter(d => !uploadedTypes.has(d));

    const appRes = await client.query(
      `SELECT CASE status
                WHEN 'reviewed' THEN 'contacted'
                WHEN 'rejected' THEN 'not_interested'
                ELSE status
              END AS status,
              application_answers
       FROM job_applications
       WHERE job_id = $1 AND worker_id = $2`,
      [jobId, workerId],
    );
    const already_applied = appRes.rows.length > 0;
    const application_status = already_applied ? appRes.rows[0].status : null;
    // Before the worker has applied, nothing has been answered -- every
    // required/optional field is unanswered. Once applied, key presence
    // (never the value) drives both lists. Guarded with isPlainObject
    // because application_answers is JSONB NOT NULL DEFAULT '{}' and node-pg
    // returns it pre-parsed; a non-object shape here would otherwise corrupt
    // Object.keys() silently.
    const rawAnswers = already_applied ? appRes.rows[0].application_answers : undefined;
    const answeredKeys = new Set(isPlainObject(rawAnswers) ? Object.keys(rawAnswers) : []);
    const missing_fields = requiredFields.filter((field) => !answeredKeys.has(field));
    const optional_unanswered = optionalFields.filter((field) => !answeredKeys.has(field));

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
        already_applied,
        application_status,
        missing_docs,
        missing_fields,
        optional_unanswered,
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
