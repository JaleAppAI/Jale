import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { DOC_TYPES, MAX_CERTIFICATION_FILES, MAX_CERTIFICATION_FILES_PER_NAME } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES: readonly string[] = DOC_TYPES;
const MAX_FILE_NAME_LENGTH = 255;
const s3 = new S3Client({});
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const CERTIFICATION_DOC_LIMIT_CONSTRAINT = 'certification_document_limit';
// Introduced by 078_worker_documents_cert_name.sql alongside the total-cap
// raise (5 -> 20) -- a DIFFERENT constraint name than the one above on
// purpose, so this catch block can tell "too many files in this slot" apart
// from "too many files under this one name/label" and answer each with its
// own error code (see the per-name pre-check below for the full rationale).
const CERTIFICATION_DOC_NAME_LIMIT_CONSTRAINT = 'certification_document_name_limit';

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
      cert_name?: string | null;
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

    const { token, s3_key, doc_type, file_name, file_size, mime_type, cert_name } = body;
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
    // cert_name is OPTIONAL on this (tokenized) surface's certification_doc
    // confirm -- deliberately asymmetric with worker-doc-confirm-auth.ts,
    // where it's required. This is the WhatsApp-sent upload-link flow
    // (/upload/[token]): it collects no label UI today, so an omitted
    // cert_name inserts NULL and lands in 078's unlabeled bucket (still
    // capped at 5 via `cert_name IS NOT DISTINCT FROM NULL`, same ceiling
    // this surface has always had). A non-blank cert_name is still forbidden
    // on every other doc_type -- mirrors worker_documents_cert_name_valid.
    // If a labeled-upload UI is ever added to this tokenized surface, tighten
    // `required` to true here to match the authed confirm. Ivan's WhatsApp
    // flows reach documents through this tokenized path, so any labeling
    // work on the WhatsApp side interacts with this exact toggle.
    const certResult = validateCertName(doc_type, cert_name, false);
    if (!certResult.ok) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: certResult.error }),
      };
    }
    const certName = certResult.certName;

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

    // Entry point note for the WhatsApp side (Ivan's team): the
    // applications.ts snapshot-copy path (copyRequiredDocumentSnapshots)
    // writes worker_documents rows through the SAME
    // enforce_certification_document_limit() trigger the pre-checks and
    // catch-mapping below defend against -- there is no separate cap for that
    // insert path, so any WhatsApp-originated certification_doc write is
    // subject to the identical total (20) and per-name (5) caps, and can
    // raise the identical two constraint names.
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

      // Per-name cap, added by 078_worker_documents_cert_name.sql alongside
      // the total-cap raise above (5 -> 20). `cert_name IS NOT DISTINCT FROM`
      // (not `=`) is required: cert_name is nullable, and every unlabeled
      // certification_doc row in this slot -- every legacy row, and any
      // future upload that omits a label -- shares ONE bucket under NULL, so
      // `=` would silently never match and this cap would never fire for the
      // unlabeled case. See 078's header NULL-GROUPING SEMANTIC section for
      // the full empirical verification. This is also defense-in-depth: the
      // insert's catch below maps the same trigger's certification_document_name_limit
      // constraint (errcode 23514) as a TOCTOU backstop.
      const nameCountResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'certification_doc' AND cert_name IS NOT DISTINCT FROM $3`,
        [worker_id, slot.job_id, certName],
      );
      if (nameCountResult.rows[0].count >= MAX_CERTIFICATION_FILES_PER_NAME) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return {
          statusCode: 409,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'certification_document_name_limit' }),
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
      certName,
    ];
    // cert_name is always NULL here for non-certification doc_types
    // (validateCertName rejects any non-blank value on them, above) --
    // included for column symmetry with the certification-path insert, not
    // because it's ever non-NULL on those rows.
    const insertSql = `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, s3_version_id, cert_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`;

    if (isCertification) {
      try {
        await client.query(insertSql, insertParams);
      } catch (insertErr) {
        const pgErr = insertErr as { code?: string; constraint?: string };
        const isCertLimit = pgErr?.code === UNIQUE_VIOLATION
          || (pgErr?.code === CHECK_VIOLATION && pgErr?.constraint === CERTIFICATION_DOC_LIMIT_CONSTRAINT);
        // TOCTOU backstop for the per-name pre-check above: two concurrent
        // confirms can each pass the pre-check's count and then collide in
        // the trigger, same race the total cap already accepts (078's header).
        const isCertNameLimit = pgErr?.code === CHECK_VIOLATION
          && pgErr?.constraint === CERTIFICATION_DOC_NAME_LIMIT_CONSTRAINT;
        if (isCertLimit || isCertNameLimit) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return {
            statusCode: 409,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: isCertNameLimit ? CERTIFICATION_DOC_NAME_LIMIT_CONSTRAINT : CERTIFICATION_DOC_LIMIT_CONSTRAINT,
            }),
          };
        }
        throw insertErr;
      }
    } else {
      try {
        await client.query(insertSql, insertParams);
      } catch (insertErr) {
        // Concurrent confirms of two independently-issued token slots for the
        // same (worker, job, doc_type) can race the DELETE-then-INSERT above:
        // both DELETEs see the same prior row (or none), then the second
        // INSERT collides on worker_documents_per_job_unique. Map it to a 409
        // rather than a 500 — the transaction rolls back cleanly and the
        // caller can simply retry (the first confirm's row stands).
        const pgErr = insertErr as { code?: string };
        if (pgErr?.code === UNIQUE_VIOLATION) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return {
            statusCode: 409,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'document_conflict' }),
          };
        }
        throw insertErr;
      }
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
