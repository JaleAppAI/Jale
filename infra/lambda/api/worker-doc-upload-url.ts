import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash, randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { DOC_TYPES } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

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

    await client.query('BEGIN');

    const tokenResult = await client.query(
      `SELECT t.worker_id, t.job_id
       FROM document_upload_tokens t
       JOIN job_applications ja
         ON ja.job_id = t.job_id
        AND ja.worker_id = t.worker_id
       WHERE t.token_hash = $1
         AND t.used = false
         AND t.expires_at > now()`,
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
    const s3Key = `documents/${job_id}/${worker_id}/${doc_type}/${randomUUID()}.${ext}`;

    const slotResult = await client.query(
      `INSERT INTO document_upload_token_slots (
         token_hash, doc_type, issued_s3_key, expected_mime_type, max_file_size, requested_at
       )
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (token_hash, doc_type) DO UPDATE
         SET issued_s3_key = EXCLUDED.issued_s3_key,
             expected_mime_type = EXCLUDED.expected_mime_type,
             max_file_size = EXCLUDED.max_file_size,
             requested_at = now(),
             s3_version_id = NULL
       WHERE document_upload_token_slots.confirmed_at IS NULL
       RETURNING issued_s3_key`,
      [tokenHash, doc_type, s3Key, mime_type, MAX_FILE_SIZE],
    );

    if (slotResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'document_already_confirmed' }),
      };
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
