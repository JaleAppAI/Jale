import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isPlainObject } from '../lib/application-answers';
import { promptAnswersView, stageView } from '../lib/application-stage-view';
import { parsePreApplicationPromptList } from '../lib/pre-application-prompts';
import { APPLICATION_STATUSES } from '../lib/job-fields';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string = event.requestContext.authorizer?.claims?.sub;

    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_job_id' }) };
    }
    if (!UUID_REGEX.test(jobId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_id' }) };
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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    const employerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    const employerId: string | undefined = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    await setInternalUserRlsContext(client, employerId);

    // Verify this job belongs to the caller (RLS returns no rows if not).
    // Also carries optional_fields/optional_docs so the applicant query
    // below can compute each applicant's not_provided list without a
    // second round trip -- and, since 091, the rest of the job's
    // requirement columns too. Those are job-level, identical for every
    // applicant, so they are fetched ONCE here and folded into each row's
    // snapshot below rather than re-joined per applicant.
    const jobCheck = await client.query(
      `SELECT id, optional_fields, optional_docs,
              required_fields, required_docs,
              certification_requirements, pre_application_prompts
         FROM jobs WHERE id = $1 AND employer_id = $2`,
      [jobId, employerId],
    );
    if (jobCheck.rowCount === 0) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }
    const jobRow = (jobCheck.rows ?? [])[0] ?? {};
    const optionalFields: string[] = Array.isArray(jobRow.optional_fields) ? jobRow.optional_fields : [];
    const optionalDocs: string[] = Array.isArray(jobRow.optional_docs) ? jobRow.optional_docs : [];
    const preApplicationPrompts = parsePreApplicationPromptList(jobRow.pre_application_prompts);

    // Build applicant query with optional filters
    const qs = event.queryStringParameters ?? {};
    const conditions: string[] = ['ja.job_id = $1', 'j.employer_id = $2'];
    const params: (string | number | string[])[] = [jobId, employerId, optionalDocs];
    let idx = 4;

    if (qs.status) {
      if (!APPLICATION_STATUSES.includes(qs.status as any)) {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_status', valid: APPLICATION_STATUSES }) };
      }
      if (qs.status === 'contacted') {
        conditions.push(`ja.status = ANY($${idx++}::text[])`);
        params.push(['contacted', 'reviewed']);
      } else if (qs.status === 'not_interested') {
        conditions.push(`ja.status = ANY($${idx++}::text[])`);
        params.push(['not_interested', 'rejected']);
      } else {
        conditions.push(`ja.status = $${idx++}`);
        params.push(qs.status);
      }
    }
    if (qs.availability) {
      conditions.push(`wp.availability = $${idx++}`);
      params.push(qs.availability);
    }
    if (qs.min_experience) {
      conditions.push(`wp.years_experience >= $${idx++}`);
      params.push(parseInt(qs.min_experience, 10));
    }
    if (qs.skills) {
      // skills is a comma-separated list — match any skill using the && (overlap) operator
      const skillList = qs.skills
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (skillList.length > 0) {
        conditions.push(`EXISTS (
          SELECT 1
          FROM worker_skills ws
          WHERE ws.worker_id = ja.worker_id
            AND ws.skill = ANY($${idx++}::text[])
        )`);
        params.push(skillList);
      }
    }

    const result = await client.query(
      `SELECT
         ja.id            AS application_id,
         ja.worker_id,
         COALESCE(wp.full_name, u.full_name) AS full_name,
         COALESCE(wp.phone, u.phone)         AS phone,
         CASE ja.status
           WHEN 'reviewed' THEN 'contacted'
           WHEN 'rejected' THEN 'not_interested'
           ELSE ja.status
         END AS status,
         ja.applied_at,
         ja.application_answers,
         -- 091 stage columns. stage/details_status are derived from these
         -- TIMESTAMPS, never from the literal status, so moving a
         -- details_requested applicant on to contacted/talking does not
         -- silently reset the stage.
         ja.prompt_answers,
         ja.details_requested_at,
         ja.details_completed_at,
         ARRAY(
           SELECT ws.skill
           FROM worker_skills ws
           WHERE ws.worker_id = ja.worker_id
           ORDER BY ws.skill
         ) AS skills,
         wp.availability,
         wp.years_experience,
         wp.location,
         -- Optional docs (job's optional_docs, param $3) this applicant's
         -- vault/job worker_documents rows do NOT cover -- folded into
         -- not_provided below alongside skipped optional_fields answers.
         ARRAY(
           SELECT dt FROM unnest($3::text[]) AS dt
           WHERE NOT EXISTS (
             SELECT 1 FROM worker_documents wd
              WHERE wd.worker_id = ja.worker_id
                AND wd.doc_type = dt
                AND (wd.job_id IS NULL OR wd.job_id = ja.job_id)
           )
         ) AS missing_optional_docs,
         -- JOB-SCOPED doc types, the input computeRemaining expects and
         -- exactly what 091's hire gate measures. DELIBERATELY narrower than
         -- missing_optional_docs above, which also counts vault rows
         -- (job_id IS NULL): that one answers "did the worker skip an
         -- optional item", this one answers "can this application be hired".
         -- The two can disagree on the same row; both are correct.
         --
         -- No syncDocumentSnapshots here: this is an employer (jale_admin)
         -- session, and the sync sets a WORKER GUC and writes worker_documents
         -- (FORCE RLS). Only worker sessions may do that.
         ARRAY(
           SELECT DISTINCT wd.doc_type
             FROM worker_documents wd
            WHERE wd.worker_id = ja.worker_id
              AND wd.job_id = ja.job_id
         ) AS have_docs
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ja.applied_at DESC`,
      params,
    );

    await client.query('COMMIT');

    // The employer must see exactly which optional items were skipped:
    // not_provided = optional_fields absent from this applicant's answers,
    // plus optional_docs missing_optional_docs computed in SQL above.
    // missing_optional_docs is an internal helper column, dropped from the
    // response -- only its contribution to not_provided is exposed.
    const applicants = result.rows.map((row: any) => {
      const { missing_optional_docs, have_docs, ...applicant } = row;
      // Guard + normalize, not just guard: application_answers is JSONB NOT
      // NULL DEFAULT '{}' and node-pg returns it pre-parsed in production,
      // but if it ever arrived as something else, ship the normalized {}
      // rather than passing a non-object value through to the employer.
      const answers = isPlainObject(applicant.application_answers) ? applicant.application_answers : {};
      const notProvided = [
        ...optionalFields.filter((field) => !Object.prototype.hasOwnProperty.call(answers, field)),
        ...(Array.isArray(missing_optional_docs) ? missing_optional_docs : []),
      ];
      // The shared stage vocabulary, computed by the SAME pure functions the
      // worker's own door runs -- fed a snapshot assembled from the columns
      // already selected, so no per-row engine round trip.
      const stage = stageView({
        ...row,
        // The selected `status` is the CASE-remapped one; the snapshot wants
        // the application status only for exits it never evaluates here, so
        // either is safe -- passed explicitly for clarity.
        application_status: row.status,
        required_fields: jobRow.required_fields,
        optional_fields: jobRow.optional_fields,
        required_docs: jobRow.required_docs,
        optional_docs: jobRow.optional_docs,
        certification_requirements: jobRow.certification_requirements,
        pre_application_prompts: jobRow.pre_application_prompts,
        have_docs,
      });
      return {
        ...applicant,
        application_answers: answers,
        not_provided: notProvided,
        ...stage,
        // Overwrites the RAW jsonb column with the joined view: the employer
        // must never have to correlate answer ids against the job's prompts
        // themselves, and an answer to a since-deleted prompt still shows.
        prompt_answers: promptAnswersView(jobRow.pre_application_prompts, row.prompt_answers),
      };
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        applicants,
        total: result.rowCount,
        pre_application_prompts: preApplicationPrompts,
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-job-applicants error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
