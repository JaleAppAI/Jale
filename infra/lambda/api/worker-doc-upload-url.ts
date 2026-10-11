import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { DOC_TYPES } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** The resolve call's refusals, answered exactly as before the call existed. */
const RESOLVE_REFUSALS = new Map<string, { statusCode: number; body: Record<string, unknown> }>([
  ['invalid_token', { statusCode: 401, body: { error: 'invalid_token' } }],
  ['document_already_confirmed', { statusCode: 409, body: { error: 'document_already_confirmed' } }],
  ['invalid_doc_type', { statusCode: 400, body: { error: 'invalid_doc_type', valid: DOC_TYPES } }],
  ['invalid_mime_type', { statusCode: 400, body: { error: 'invalid_mime_type', valid: Object.keys(MIME_TO_EXT) } }],
]);

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    let body: { token?: string; doc_type?: string; mime_type?: string; cert_name?: string | null };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json' }),
      };
    }

    const { token, doc_type, mime_type, cert_name } = body;
    if (!token || !doc_type || !mime_type) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'missing_fields',
          required: ['token', 'doc_type', 'mime_type'],
        }),
      };
    }
    if (!VALID_DOC_TYPES.includes(doc_type as (typeof VALID_DOC_TYPES)[number])) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }),
      };
    }
    // cert_name is OPTIONAL here even for certification_doc -- no frontend
    // caller sends it at presign time (it's supplied later, at confirm; see
    // ../lib/cert-name.ts). This only rejects a cert_name that's malformed or
    // present on the wrong doc_type, as fail-fast validation before the
    // client burns a presigned PUT on an upload that would 400 at confirm.
    const certResult = validateCertName(doc_type, cert_name, false);
    if (!certResult.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: certResult.error }),
      };
    }
    const ext = MIME_TO_EXT[mime_type];
    if (!ext) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'invalid_mime_type',
          valid: Object.keys(MIME_TO_EXT),
        }),
      };
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const pool = await getDbPool();
    client = await pool.connect();

    // All of the database work is one capability call: it validates the
    // token (unexpired, unsubmitted, application still present), the doc
    // type and the MIME type, and issues or re-issues the slot -- never a
    // confirmed one -- with an object key built in the database from the
    // token's job and worker. The presign runs inside the same transaction,
    // so a failed presign leaves no slot issued.
    await client.query('BEGIN');
    const resolved = await client.query<{ outcome: string; s3_key: string | null }>(
      `SELECT outcome, s3_key FROM jale_cap.upload_token_resolve($1, $2, $3)`,
      [tokenHash, doc_type, mime_type],
    );
    const outcome = resolved.rows[0]?.outcome;
    const refusal = outcome === undefined ? undefined : RESOLVE_REFUSALS.get(outcome);
    if (refusal) {
      await client.query('ROLLBACK');
      return { statusCode: refusal.statusCode, headers: CORS_HEADERS, body: JSON.stringify(refusal.body) };
    }
    const s3Key = resolved.rows[0]?.s3_key;
    if (outcome !== 'ok' || !s3Key) {
      throw new Error(`upload_token_resolve_unexpected_outcome:${String(outcome)}`);
    }

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.DOCUMENTS_BUCKET!,
        Key: s3Key,
        ContentType: mime_type,
      }),
      { expiresIn: 900 },
    );

    await client.query('COMMIT');
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ url, s3_key: s3Key }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('worker-doc-upload-url error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
