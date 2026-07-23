import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    let body: { token?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json' }),
      };
    }

    const { token } = body;
    if (!token) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_fields', required: ['token'] }),
      };
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const pool = await getDbPool();
    client = await pool.connect();

    const result = await client.query(
      `UPDATE document_upload_tokens token
          SET used = true, used_at = COALESCE(used_at, now())
        WHERE token.token_hash = $1
          AND token.expires_at > now()
          AND EXISTS (
            SELECT 1 FROM document_upload_token_slots slots
            WHERE slots.token_hash = token.token_hash
              AND slots.confirmed_at IS NOT NULL
          )
        RETURNING token.used`,
      [tokenHash],
    );
    if (result.rowCount === 1) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true }),
      };
    }

    const exists = await client.query(
      `SELECT (expires_at > now()) AS unexpired FROM document_upload_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    if (exists.rows.length === 0 || exists.rows[0].unexpired !== true) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_token' }),
      };
    }

    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'confirm_required' }),
    };
  } catch (err) {
    console.error('worker-doc-submit error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
