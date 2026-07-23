import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
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

    // Verify this job belongs to the caller (RLS returns no rows if not)
    const jobCheck = await client.query('SELECT id FROM jobs WHERE id = $1 AND employer_id = $2', [jobId, employerId]);
    if (jobCheck.rowCount === 0) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    // Build applicant query with optional filters
    const qs = event.queryStringParameters ?? {};
    const conditions: string[] = ['ja.job_id = $1', 'j.employer_id = $2'];
    const params: (string | number | string[])[] = [jobId, employerId];
    let idx = 3;

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
         ARRAY(
           SELECT ws.skill
           FROM worker_skills ws
           WHERE ws.worker_id = ja.worker_id
           ORDER BY ws.skill
         ) AS skills,
         wp.availability,
         wp.years_experience,
         wp.location
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ja.applied_at DESC`,
      params,
    );

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ applicants: result.rows, total: result.rowCount }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('employer-job-applicants error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
