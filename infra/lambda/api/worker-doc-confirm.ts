import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'];

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    let body: {
      token?: string;
      s3_key?: string;
      doc_type?: string;
      file_name?: string;
      file_size?: number;
      mime_type?: string;
    };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json' }),
      };
    }

    const { token, s3_key, doc_type, file_name, file_size, mime_type } = body;
    if (!token || !s3_key || !doc_type || !file_name || file_size == null || !mime_type) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_fields' }),
      };
    }
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_doc_type' }),
      };
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');

    const tokenResult = await client.query(
      `SELECT worker_id, job_id FROM document_upload_tokens
       WHERE token_hash = $1 AND used = false AND expires_at > now()`,
      [tokenHash],
    );
    if (tokenResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_token' }),
      };
    }

    const { worker_id, job_id } = tokenResult.rows[0];
    // Set token-auth context to the worker's internal UUID. Cognito-sub RLS
    // uses app.current_user_id; internal UUID flows use this separate setting.
    await client.query("SELECT set_config('app.current_internal_user_id', $1, true)", [worker_id]);

    await client.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (worker_id, job_id, doc_type) DO UPDATE
         SET s3_key = EXCLUDED.s3_key, file_name = EXCLUDED.file_name,
             file_size = EXCLUDED.file_size, mime_type = EXCLUDED.mime_type,
             uploaded_at = now()`,
      [worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type],
    );

    await client.query('COMMIT');
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('worker-doc-confirm error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
