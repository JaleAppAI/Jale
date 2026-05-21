import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'];
const MAX_FILE_NAME_LENGTH = 255;
const s3 = new S3Client({});

function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
}

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

    const slotResult = await client.query(
      `UPDATE document_upload_token_slots slots
       SET confirmed_at = now()
       FROM document_upload_tokens token
       JOIN job_applications ja
         ON ja.job_id = token.job_id
        AND ja.worker_id = token.worker_id
       WHERE slots.token_hash = token.token_hash
         AND slots.token_hash = $1
         AND slots.doc_type = $2
         AND slots.issued_s3_key = $3
         AND slots.expected_mime_type = $4
         AND slots.confirmed_at IS NULL
         AND token.used = false
         AND token.expires_at > now()
       RETURNING token.worker_id,
                 token.job_id,
                 slots.doc_type,
                 slots.issued_s3_key,
                 slots.expected_mime_type,
                 slots.max_file_size`,
      [tokenHash, doc_type, s3_key, mime_type],
    );
    if (slotResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_or_confirmed_upload' }),
      };
    }

    const slot = slotResult.rows[0];
    let head;
    try {
      head = await s3.send(
        new HeadObjectCommand({
          Bucket: process.env.DOCUMENTS_BUCKET!,
          Key: slot.issued_s3_key,
        }),
      );
    } catch {
      await client.query('ROLLBACK');
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'uploaded_object_not_found' }),
      };
    }

    if (
      head.ContentLength == null ||
      head.ContentLength <= 0 ||
      head.ContentLength > Number(slot.max_file_size)
    ) {
      await client.query('ROLLBACK');
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_file_size' }),
      };
    }

    if (head.ContentType !== slot.expected_mime_type) {
      await client.query('ROLLBACK');
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_mime_type' }),
      };
    }

    if (!head.ServerSideEncryption) {
      await client.query('ROLLBACK');
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_encryption' }),
      };
    }

    const safeFileName = sanitizeFileName(file_name) || `${doc_type}.${mime_type.split('/')[1] ?? 'file'}`;
    const s3VersionId = head.VersionId ?? null;

    await client.query(
      `UPDATE document_upload_token_slots
       SET s3_version_id = $3
       WHERE token_hash = $1 AND doc_type = $2`,
      [tokenHash, doc_type, s3VersionId],
    );

    const { worker_id, job_id } = slot;
    // Set token-auth context to the worker's internal UUID. Cognito-sub RLS
    // uses app.current_user_id; internal UUID flows use this separate setting.
    await client.query("SELECT set_config('app.current_internal_user_id', $1, true)", [worker_id]);

    await client.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (worker_id, job_id, doc_type) WHERE job_id IS NOT NULL DO UPDATE
         SET s3_key = EXCLUDED.s3_key, file_name = EXCLUDED.file_name,
             file_size = EXCLUDED.file_size, mime_type = EXCLUDED.mime_type,
             s3_version_id = EXCLUDED.s3_version_id,
             uploaded_at = now()`,
      [
        worker_id,
        job_id,
        doc_type,
        slot.issued_s3_key,
        safeFileName,
        head.ContentLength,
        slot.expected_mime_type,
        s3VersionId,
      ],
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
