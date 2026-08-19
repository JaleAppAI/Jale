import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { DOC_TYPES, MAX_CERTIFICATION_FILES } from '../lib/job-fields';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;
const VALID_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const CERTIFICATION_DOC_LIMIT_CONSTRAINT = 'certification_document_limit';

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

    const { s3_key, doc_type, file_name, file_size, mime_type } = body;
    if (!s3_key || !doc_type || !file_name || typeof file_size !== 'number' || !mime_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields' }) };
    }
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }) };
    }
    if (!VALID_MIME.has(mime_type)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_mime_type' }) };
    }

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
          `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)
           RETURNING id, doc_type, s3_key, file_name, file_size, uploaded_at`,
          [workerId, doc_type, s3_key, file_name, file_size, mime_type],
        );
      } catch (insertErr) {
        const pgErr = insertErr as { code?: string; constraint?: string };
        const isCertLimit = pgErr?.code === UNIQUE_VIOLATION
          || (pgErr?.code === CHECK_VIOLATION && pgErr?.constraint === CERTIFICATION_DOC_LIMIT_CONSTRAINT);
        if (isCertLimit) {
          await client.query('ROLLBACK');
          return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'certification_document_limit' }) };
        }
        throw insertErr;
      }
    } else {
      insertRes = await client.query(
        `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)
         RETURNING id, doc_type, s3_key, file_name, file_size, uploaded_at`,
        [workerId, doc_type, s3_key, file_name, file_size, mime_type],
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
