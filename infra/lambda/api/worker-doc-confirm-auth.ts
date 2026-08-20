import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { DOC_TYPES, MAX_CERTIFICATION_FILES, MAX_CERTIFICATION_FILES_PER_NAME } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;
const VALID_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const CERTIFICATION_DOC_LIMIT_CONSTRAINT = 'certification_document_limit';
// Introduced by 078_worker_documents_cert_name.sql alongside the total-cap
// raise (5 -> 20) -- a DIFFERENT constraint name than the one above on
// purpose, so this catch block can tell "too many files in this slot" apart
// from "too many files under this one name/label" and answer each with its
// own error code (see the per-name pre-check below for the full rationale).
const CERTIFICATION_DOC_NAME_LIMIT_CONSTRAINT = 'certification_document_name_limit';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const { s3_key, doc_type, file_name, file_size, mime_type, cert_name } = body;
    if (!s3_key || !doc_type || !file_name || typeof file_size !== 'number' || !mime_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields' }) };
    }
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }) };
    }
    if (!VALID_MIME.has(mime_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_mime_type' }) };
    }
    // cert_name is REQUIRED on a certification_doc confirm (the frontend's
    // confirmAuthUpload(..., cert_name) call site supplies it) and forbidden
    // on every other doc_type -- mirrors worker_documents_cert_name_valid.
    // See ../lib/cert-name.ts for why upload-url (the presign step) does not
    // enforce this same requirement.
    const certResult = validateCertName(doc_type, cert_name, true);
    if (!certResult.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: certResult.error }) };
    }
    const certName = certResult.certName;

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');

    // Compliance with cognito_sub convention.
    await setRlsContext(client, cognitoSub);
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) { await client.query('COMMIT'); return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) }; }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (userRes.rows.length === 0) { await client.query('COMMIT'); return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) }; }
    const workerId: string = userRes.rows[0].id;

    // Vault uploads are only ever issued under the caller's own prefix
    // (see worker-doc-upload-url-auth.ts). Reject any client-supplied
    // s3_key that doesn't fall under it to prevent an IDOR where a worker
    // claims another user's uploaded object as their own document.
    const expectedPrefix = `documents/vault/${workerId}/`;
    if (typeof s3_key !== 'string' || !s3_key.startsWith(expectedPrefix)) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET!, Key: s3_key }));
      if (head.ContentType !== mime_type || !head.ServerSideEncryption
          || head.ContentLength == null || head.ContentLength <= 0) {
        await client.query('COMMIT');
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_upload' }) };
      }
    } catch (headErr) {
      // Log the real S3 failure. NoSuchKey (the object genuinely is not there)
      // and AccessDenied (this Lambda lacks s3:GetObject on the bucket) are
      // indistinguishable to the client, which sees only the generic error
      // below — so without this line a misconfigured grant looks exactly like a
      // failed browser upload. The response body stays generic on purpose; S3
      // details are not the caller's business.
      console.error('worker-doc-confirm-auth HeadObject failed:', errorMessage(headErr));
      await client.query('COMMIT');
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'uploaded_object_not_found' }) };
    }

    // Switch to worker_documents RLS convention (user.id::text).
    await setInternalUserRlsContext(client, workerId);

    const isCertification = doc_type === 'certification_doc';

    // Entry point note for the WhatsApp side (Ivan's team): the
    // applications.ts snapshot-copy path (copyRequiredDocumentSnapshots)
    // writes worker_documents rows through the SAME
    // enforce_certification_document_limit() trigger this lambda's pre-checks
    // and catch-mapping defend against below -- there is no separate cap for
    // that insert path, so any WhatsApp-originated certification_doc write
    // is subject to the identical total (20) and per-name (5) caps, and can
    // raise the identical two constraint names.
    if (isCertification) {
      // certification_doc allows up to MAX_CERTIFICATION_FILES rows per slot
      // (worker, NULL job_id) -- append, never delete the existing ones. The
      // count check is defense-in-depth: 075_worker_documents_multi_certification.sql
      // adds a DB trigger enforcing the same cap (errcode 23514, constraint
      // certification_document_limit), which the insert's catch below also maps.
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL`,
        [workerId, doc_type],
      );
      if (countRes.rows[0].count >= MAX_CERTIFICATION_FILES) {
        await client.query('COMMIT');
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'certification_document_limit' }) };
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
      const nameCountRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL AND cert_name IS NOT DISTINCT FROM $3`,
        [workerId, doc_type, certName],
      );
      if (nameCountRes.rows[0].count >= MAX_CERTIFICATION_FILES_PER_NAME) {
        await client.query('COMMIT');
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'certification_document_name_limit' }) };
      }
    } else {
      // Replace any existing vault row for (worker, doc_type, NULL).
      await client.query(
        `DELETE FROM worker_documents WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL`,
        [workerId, doc_type],
      );
    }

    let insertRes;
    if (isCertification) {
      try {
        insertRes = await client.query(
          `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
           RETURNING id, doc_type, s3_key, file_name, file_size, uploaded_at, cert_name`,
          [workerId, doc_type, s3_key, file_name, file_size, mime_type, certName],
        );
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
      // cert_name is always NULL here (validateCertName rejects any non-blank
      // value on a non-certification_doc, above) -- included for column
      // symmetry with the cert-path INSERT, not because it's ever non-NULL.
      insertRes = await client.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type, cert_name)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
         RETURNING id, doc_type, s3_key, file_name, file_size, uploaded_at, cert_name`,
        [workerId, doc_type, s3_key, file_name, file_size, mime_type, certName],
      );
    }

    await client.query('COMMIT');
    return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(insertRes.rows[0]) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-doc-confirm-auth error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
