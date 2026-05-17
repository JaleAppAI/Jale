import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'] as const;
const VALID_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const { s3_key, doc_type, file_name, file_size, mime_type } = body;
    if (!s3_key || !doc_type || !file_name || typeof file_size !== 'number' || !mime_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields' }) };
    }
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }) };
    }
    if (!VALID_MIME.has(mime_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_mime_type' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');

    // Compliance with cognito_sub convention.
    await setRlsContext(client, cognitoSub);
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) { await client.query('COMMIT'); return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) }; }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (userRes.rows.length === 0) { await client.query('COMMIT'); return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) }; }
    const workerId: string = userRes.rows[0].id;

    // Switch to worker_documents RLS convention (user.id::text).
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);

    // Replace any existing vault row for (worker, doc_type, NULL).
    await client.query(
      `DELETE FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL`,
      [workerId, doc_type],
    );

    const insertRes = await client.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       RETURNING id, doc_type, s3_key, file_name, file_size, uploaded_at`,
      [workerId, doc_type, s3_key, file_name, file_size, mime_type],
    );

    await client.query('COMMIT');
    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(insertRes.rows[0]) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-doc-confirm-auth error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
