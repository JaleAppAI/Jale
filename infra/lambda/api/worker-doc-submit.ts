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

    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE document_upload_tokens token
       SET used = true, used_at = now()
       WHERE token_hash = $1
         AND used = false
         AND expires_at > now()
         AND EXISTS (
           SELECT 1
           FROM document_upload_token_slots slots
           WHERE slots.token_hash = token.token_hash
             AND slots.confirmed_at IS NOT NULL
         )
       RETURNING token_hash`,
      [tokenHash],
    );

    if (result.rowCount === 0) {
      const tokenState = await client.query(
        `SELECT used, expires_at > now() AS unexpired
         FROM document_upload_tokens
         WHERE token_hash = $1`,
        [tokenHash],
      );

      if (tokenState.rows[0]?.used === true) {
        await client.query('COMMIT');
        return {
          statusCode: 200,
          headers: CORS_HEADERS,
          body: JSON.stringify({ success: true }),
        };
      }

      if (tokenState.rows[0]?.unexpired === true) {
        await client.query('ROLLBACK');
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'no_confirmed_documents' }),
        };
      }

      await client.query('ROLLBACK');
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_token' }),
      };
    }

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
