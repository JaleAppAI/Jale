import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext, setInternalUserRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const postId = event.pathParameters?.post_id;
    if (!postId || !UUID_RE.test(postId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_post_id' }) };
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
    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (userRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) };
    }
    const workerId: string = userRes.rows[0].id;
    await setInternalUserRlsContext(client, workerId);

    const updateRes = await client.query(
      `UPDATE worker_posts
       SET status = 'deleted'
       WHERE id = $1 AND worker_id = $2 AND status = 'published'
       RETURNING id`,
      [postId, workerId],
    );
    await client.query('COMMIT');
    if (updateRes.rowCount === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'post_not_found' }) };
    }
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ deleted: true }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-post-delete error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
