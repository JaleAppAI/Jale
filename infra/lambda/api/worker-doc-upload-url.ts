import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash, randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'] as const;
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
    let body: { token?: string; doc_type?: string; mime_type?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json' }),
      };
    }

    const { token, doc_type, mime_type } = body;
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
    const s3Key = `documents/${job_id}/${worker_id}/${doc_type}/${randomUUID()}.${ext}`;

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: process.env.DOCUMENTS_BUCKET!,
        Key: s3Key,
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
