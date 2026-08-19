import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { isPlainObject } from '../lib/application-answers';
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
    // second round trip.
    const jobCheck = await client.query(
      'SELECT id, optional_fields, optional_docs FROM jobs WHERE id = $1 AND employer_id = $2',
      [jobId, employerId],
    );
    if (jobCheck.rowCount === 0) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }
    const jobRow = (jobCheck.rows ?? [])[0] ?? {};
    const optionalFields: string[] = Array.isArray(jobRow.optional_fields) ? jobRow.optional_fields : [];
    const optionalDocs: string[] = Array.isArray(jobRow.optional_docs) ? jobRow.optional_docs : [];

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
         ) AS missing_optional_docs
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
      const { missing_optional_docs, ...applicant } = row;
      // Guard + normalize, not just guard: application_answers is JSONB NOT
      // NULL DEFAULT '{}' and node-pg returns it pre-parsed in production,
      // but if it ever arrived as something else, ship the normalized {}
      // rather than passing a non-object value through to the employer.
      const answers = isPlainObject(applicant.application_answers) ? applicant.application_answers : {};
      const notProvided = [
        ...optionalFields.filter((field) => !Object.prototype.hasOwnProperty.call(answers, field)),
        ...(Array.isArray(missing_optional_docs) ? missing_optional_docs : []),
      ];
      return { ...applicant, application_answers: answers, not_provided: notProvided };
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ applicants, total: result.rowCount }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-job-applicants error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
