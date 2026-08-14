import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
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
              j.title AS job_title,
              employer_display_name(j.employer_id) AS company_name,
              CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status
       FROM job_applications a
       JOIN jobs j ON j.id = a.job_id
       ORDER BY a.applied_at DESC
       LIMIT 200`,
    );
    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ applications: result.rows }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-applications-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
