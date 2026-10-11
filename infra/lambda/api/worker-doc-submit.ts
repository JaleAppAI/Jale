import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  let transactionOpen = false;
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

    // One capability call: marks the token used once at least one slot is
    // confirmed. A repeat submit is still ok; an unknown or expired token is
    // invalid_token; a live token with nothing confirmed is confirm_required.
    // It runs in a transaction of its own so that whoever holds the link is
    // named as the actor of what it writes.
    await client.query('BEGIN');
    transactionOpen = true;
    await setAuditContext(client, auditCaller(event, { kind: 'token_holder' }, 'web'), 'token_holder.document_submit');
    const result = await client.query<{ outcome: string }>(
      `SELECT outcome FROM jale_cap.upload_token_submit($1)`,
      [tokenHash],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    const outcome = result.rows[0]?.outcome;
    if (outcome === 'ok') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true }),
      };
    }
    if (outcome === 'invalid_token') {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_token' }),
      };
    }
    if (outcome === 'confirm_required') {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'confirm_required' }),
      };
    }
    throw new Error(`upload_token_submit_unexpected_outcome:${String(outcome)}`);
  } catch (err) {
    if (client && transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
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
