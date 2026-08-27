import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized' }),
      };
    }

    const workerId = event.pathParameters?.worker_id;
    const jobId = event.queryStringParameters?.job_id;
    if (!workerId || !jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'missing_params',
          required: ['worker_id', 'job_id'],
        }),
      };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(
      client,
      cognitoSub,
      process.env.REQUIRED_TOS_VERSION!,
    );
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'user_not_provisioned' }),
      };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
        }),
      };
    }

    const employerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    const employerId: string | undefined = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'user_not_provisioned' }),
      };
    }
    await setInternalUserRlsContext(client, employerId);

    // Verify employer owns the job
    const jobCheck = await client.query(
      `SELECT id FROM jobs WHERE id = $1 AND employer_id = $2`,
      [jobId, employerId],
    );
    if (jobCheck.rows.length === 0) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'forbidden' }),
      };
    }

    const result = await client.query(
      `SELECT ja.worker_id, u.full_name, u.phone,
              ARRAY(
                SELECT ws.skill
                FROM worker_skills ws
                WHERE ws.worker_id = ja.worker_id
                ORDER BY ws.skill
              ) AS skills,
              wp.availability,
              wp.years_experience, wp.experience_months, wp.location,
              COALESCE(wp.certifications, '{}'::text[]) AS certifications,
              u.main_trade, u.main_trade_other, u.has_transportation, u.city,
              CASE ja.status
                WHEN 'reviewed' THEN 'contacted'
                WHEN 'rejected' THEN 'not_interested'
                ELSE ja.status
              END AS application_status,
              ja.applied_at
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
       WHERE ja.job_id = $1 AND ja.worker_id = $2 AND j.employer_id = $3`,
      [jobId, workerId, employerId],
    );

    if (result.rows.length === 0) {
      await client.query('COMMIT');
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'not_found' }),
      };
    }

    // Deliberately run AFTER the 404 check above (not parallelized on the
    // shared PoolClient, which can't run two queries concurrently) so a
    // worker/job combination that doesn't resolve to an applicant never pays
    // for a trust-assessment lookup whose result would just be discarded.
    const assessmentRes = await client.query(
      `SELECT profession_key, status, competency_score, score_components,
              answers, scored_at, rubric_version
         FROM worker_trust_assessments
        WHERE user_id = $1
        ORDER BY (status = 'scored') DESC, created_at DESC
        LIMIT 1`,
      [workerId],
    );
    const ta = assessmentRes.rows[0] ?? null;
    const trust_assessment = ta
      ? {
          profession_key: ta.profession_key,
          status: ta.status,
          competency_score: ta.status === 'scored' ? ta.competency_score : null,
          score_components: ta.status === 'scored' ? ta.score_components : null,
          // `rubric_version` is stored as TEXT (it mirrors the SSM parameter's
          // numeric Version) -- coerced to a number here so the frontend's
          // `rubric_version !== KNOWN_RUBRIC_VERSION` drift check compares
          // like types instead of silently always mismatching on a string.
          // A non-numeric stored value (e.g. the pending-status v2 sentinel
          // 'v2-trust-rubric-1') must NOT become NaN: JSON.stringify(NaN) is
          // `null` on the wire, which the frontend drift gate reads as "no
          // rubric_version reported" and renders bars anyway -- the exact
          // failure-open case this guard exists to prevent. -1 is used as an
          // explicit "unparseable version" sentinel instead: it can never
          // equal KNOWN_RUBRIC_VERSION, so it still degrades to plain
          // numbers, while true `null` (a pre-versioning legacy row) keeps
          // meaning "known scale, render bars".
          rubric_version: (() => {
            if (ta.rubric_version == null) return null;
            const rv = Number(ta.rubric_version);
            return Number.isFinite(rv) ? rv : -1;
          })(),
          answers: Array.isArray(ta.answers) ? ta.answers : [],
          scored_at: ta.scored_at,
        }
      : null;

    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...result.rows[0], trust_assessment }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('employer-worker-profile error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
