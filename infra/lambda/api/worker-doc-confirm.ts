import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'crypto';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { DOC_TYPES } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const VALID_DOC_TYPES: readonly string[] = DOC_TYPES;
const MAX_FILE_NAME_LENGTH = 255;
const s3 = new S3Client({});

/**
 * The confirm call's refusals and their answers. The certification caps
 * (20 per slot, 5 per name: 075/078) and the replace-or-append rules live in
 * jale_cap.upload_token_confirm; any refusal leaves the slot unconfirmed.
 */
const CONFIRM_REFUSALS = new Map<string, number>([
  ['invalid_or_confirmed_upload', 409],
  ['invalid_file_size', 400],
  ['document_conflict', 409],
  ['certification_document_limit', 409],
  ['certification_document_name_limit', 409],
]);

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

    // The slot pre-check, before the object is inspected, so an invalid,
    // confirmed or mismatched slot answers 409 ahead of every object check.
    // One read-only capability call; no transaction is open across S3.
    const slotResult = await client.query<{ outcome: string; max_file_size: number | string | null }>(
      `SELECT outcome, max_file_size FROM jale_cap.upload_token_slot($1, $2, $3, $4)`,
      [tokenHash, doc_type, s3_key, mime_type],
    );
    const slot = slotResult.rows[0];
    if (slot?.outcome === 'invalid_or_confirmed_upload') {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_or_confirmed_upload' }),
      };
    }
    if (slot?.outcome !== 'ok' || slot.max_file_size == null) {
      throw new Error(`upload_token_slot_unexpected_outcome:${String(slot?.outcome)}`);
    }

    let head;
    try {
      head = await s3.send(
        new HeadObjectCommand({
          Bucket: process.env.DOCUMENTS_BUCKET!,
          Key: s3_key,
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

    if (head.ContentType !== mime_type) {
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

    // All of confirm's database work, atomically, under the token's worker:
    // re-validates the token, the application and the unconfirmed slot bound
    // to this key and MIME type, checks the server-observed size against the
    // slot, applies the certification caps, marks the slot confirmed and
    // inserts or replaces the worker's document. Never mutates the token, so a
    // still-pending sibling slot stays confirmable.
    await client.query('BEGIN');
    transactionStarted = true;
    // Whoever holds the link is the actor; the link names no person.
    await setAuditContext(client, auditCaller(event, { kind: 'token_holder' }, 'web'), 'token_holder.document_confirm');
    const confirmResult = await client.query<{ outcome: string; document_id: string | null }>(
      `SELECT outcome, document_id FROM jale_cap.upload_token_confirm($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tokenHash, doc_type, s3_key, mime_type, safeFileName, head.ContentLength, s3VersionId, certName],
    );
    const outcome = confirmResult.rows[0]?.outcome;
    const refusalStatus = outcome === undefined ? undefined : CONFIRM_REFUSALS.get(outcome);
    if (refusalStatus !== undefined) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return {
        statusCode: refusalStatus,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: outcome }),
      };
    }
    if (outcome !== 'ok') {
      throw new Error(`upload_token_confirm_unexpected_outcome:${String(outcome)}`);
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
