import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { applyWorkerToJob } from '../lib/applications';
import { getDbPool, setRlsContext } from '../lib/db';
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
    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_id' }) };
    }

    let body: { answers?: unknown };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) };
    }
    const answers = body.answers as Record<string, unknown> | undefined;

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

    const applyResult = await applyWorkerToJob(client, { workerId, jobId, surface: 'web', answers });
    await client.query('COMMIT');

    if (applyResult.status === 'job_closed') {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_closed' }) };
    }
    if (applyResult.status === 'missing_documents') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_documents', missing_docs: applyResult.missing_docs }) };
    }
    if (applyResult.status === 'missing_answers') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_answers', missing_fields: applyResult.missing_fields }) };
    }
    if (applyResult.status === 'invalid_answers') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_answers', detail: applyResult.error }) };
    }
    if (applyResult.status === 'already_applied') {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'already_applied' }) };
    }
    if (applyResult.status === 'forbidden') {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'apply_forbidden' }) };
    }

    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(applyResult.application) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-apply error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
