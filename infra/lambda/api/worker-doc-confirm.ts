import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { DOC_TYPES, MAX_CERTIFICATION_FILES } from '../lib/job-fields';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES: readonly string[] = DOC_TYPES;
const MAX_FILE_NAME_LENGTH = 255;
const s3 = new S3Client({});
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const CERTIFICATION_DOC_LIMIT_CONSTRAINT = 'certification_document_limit';

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
  let transactionStarted = false;
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

    const slotResult = await client.query(
      `SELECT token.worker_id,
              token.job_id,
              slots.doc_type,
              slots.issued_s3_key,
              slots.expected_mime_type,
              slots.max_file_size
       FROM document_upload_tokens token
       JOIN document_upload_token_slots slots
         ON slots.token_hash = token.token_hash
       JOIN job_applications ja
         ON ja.job_id = token.job_id
        AND ja.worker_id = token.worker_id
       WHERE token.token_hash = $1
         AND slots.doc_type = $2
         AND slots.issued_s3_key = $3
         AND slots.expected_mime_type = $4
         AND slots.confirmed_at IS NULL
         AND token.used = false
         AND token.expires_at > now()`,
      [tokenHash, doc_type, s3_key, mime_type],
    );
    if (slotResult.rows.length === 0) {
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
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_file_size' }),
      };
    }

    if (head.ContentType !== slot.expected_mime_type) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_mime_type' }),
      };
    }

    if (!head.ServerSideEncryption) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_encryption' }),
      };
    }

    const safeFileName = sanitizeFileName(file_name) || `${doc_type}.${mime_type.split('/')[1] ?? 'file'}`;
    const s3VersionId = head.VersionId ?? null;

    const { worker_id } = slot;
    const isCertification = doc_type === 'certification_doc';
    await client.query('BEGIN');
    transactionStarted = true;

    // Set token-auth context to the worker's internal UUID. Cognito-sub RLS
    // uses app.current_user_id; internal UUID flows use this separate setting.
    await client.query("SELECT set_config('app.current_internal_user_id', $1, true)", [worker_id]);

    if (isCertification) {
      // Defense-in-depth cap, mirrored by the DB trigger added in
      // 075_worker_documents_multi_certification.sql (errcode 23514, constraint
      // certification_document_limit -- also mapped below). Checked BEFORE the
      // slot is confirmed: a cap rejection must never burn the upload slot,
      // since the guarded UPDATE below can only ever fire once per slot.
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'certification_doc'`,
        [worker_id, slot.job_id],
      );
      if (countResult.rows[0].count >= MAX_CERTIFICATION_FILES) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return {
          statusCode: 409,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'certification_document_limit' }),
        };
      }
    }

    // Guards the slot against races and re-confirmation: only ever fires once
    // per slot (confirmed_at IS NULL), and never mutates document_upload_tokens
    // -- a still-pending sibling slot on the same token must stay confirmable.
    const confirmResult = await client.query(
      `WITH valid_token AS (
         SELECT token.worker_id, token.job_id
         FROM document_upload_tokens token
         WHERE token.token_hash = $1
           AND token.used = false
           AND token.expires_at > now()
           AND EXISTS (
             SELECT 1
             FROM job_applications ja
             WHERE ja.job_id = token.job_id
               AND ja.worker_id = token.worker_id
           )
       ),
       confirmed_slot AS (
         UPDATE document_upload_token_slots slots
         SET confirmed_at = now(),
             s3_version_id = $6
         FROM valid_token token
         WHERE slots.token_hash = $1
           AND slots.doc_type = $2
           AND slots.issued_s3_key = $3
           AND slots.expected_mime_type = $4
           AND slots.max_file_size = $5
           AND slots.confirmed_at IS NULL
         RETURNING token.worker_id,
                   token.job_id,
                   slots.doc_type,
                   slots.issued_s3_key,
                   slots.expected_mime_type
       )
       SELECT worker_id, job_id, doc_type, issued_s3_key, expected_mime_type FROM confirmed_slot`,
      [
        tokenHash,
        doc_type,
        slot.issued_s3_key,
        slot.expected_mime_type,
        Number(slot.max_file_size),
        s3VersionId,
      ],
    );

    if (confirmResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_or_confirmed_upload' }),
      };
    }

    const confirmed = confirmResult.rows[0];

    // worker_documents_per_job_unique (and, pre-075, the plain implicit index)
    // only ever admits one row per (worker, job, doc_type) for non-certification
    // types, so this DELETE-then-INSERT is the "replace" -- no ON CONFLICT
    // arbiter, so it keeps working once 075 narrows that index's predicate to
    // exclude certification_doc (an arbiter's WHERE clause must match an
    // index's predicate exactly, so widening the index would otherwise break
    // inference for every doc type, not just certifications).
    if (!isCertification) {
      await client.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = $3`,
        [confirmed.worker_id, confirmed.job_id, confirmed.doc_type],
      );
    }

    const insertParams = [
      confirmed.worker_id,
      confirmed.job_id,
      confirmed.doc_type,
      confirmed.issued_s3_key,
      safeFileName,
      head.ContentLength,
      confirmed.expected_mime_type,
      s3VersionId,
    ];
    const insertSql = `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`;

    if (isCertification) {
      try {
        await client.query(insertSql, insertParams);
      } catch (insertErr) {
        const pgErr = insertErr as { code?: string; constraint?: string };
        const isCertLimit = pgErr?.code === UNIQUE_VIOLATION
          || (pgErr?.code === CHECK_VIOLATION && pgErr?.constraint === CERTIFICATION_DOC_LIMIT_CONSTRAINT);
        if (isCertLimit) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return {
            statusCode: 409,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'certification_document_limit' }),
          };
        }
        throw insertErr;
      }
    } else {
      await client.query(insertSql, insertParams);
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    if (client && transactionStarted) {
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
