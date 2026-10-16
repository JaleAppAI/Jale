import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { auditCaller } from '../lib/audit/caller';
import { setAuditContext } from '../lib/audit/context';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { DOC_TYPES } from '../lib/job-fields';
import { isUuid } from '../lib/uuid';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    const docType = event.pathParameters?.doc_type;
    if (!docType || !VALID_DOC_TYPES.includes(docType as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }) };
    }

    // A single-row delete names its row by `id` (below), which must be a UUID.
    const id = event.queryStringParameters?.id;
    if (id !== undefined && !isUuid(id)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_document_id' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');

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

    await setInternalUserRlsContext(client, workerId);
    await setAuditContext(client, auditCaller(event, { kind: 'worker', id: workerId }, 'web'), 'worker.document_delete');

    // Optional `id` query parameter targets a single row -- needed to delete
    // one of several certification_doc files from a slot without touching the
    // others. Without it, the delete is the original type-wide vault delete.
    // The row must also be of the route's document type, so an id never
    // deletes a document of another type.
    const delRes = id
      ? await client.query(
          `DELETE FROM worker_documents
           WHERE worker_id = $1 AND id = $2 AND doc_type = $3 AND job_id IS NULL
           RETURNING s3_key`,
          [workerId, id, docType],
        )
      : await client.query(
          `DELETE FROM worker_documents
           WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL
           RETURNING s3_key`,
          [workerId, docType],
        );

    // An application's documents are job-scoped COPIES of vault rows that
    // share the vault row's s3_key (copyRequiredDocumentSnapshots in
    // lib/applications.ts). Removing the object while a copy still names it
    // would take the document away from an application that was sent with
    // it, so the object goes only once no row of this worker names the key.
    // Asked here, inside the transaction: worker_documents is FORCE RLS and
    // the caller settings above are transaction-local.
    const s3Key: string | undefined = delRes.rows[0]?.s3_key;
    let keyStillReferenced = false;
    if ((delRes.rowCount ?? 0) > 0 && s3Key) {
      const refRes = await client.query<{ referenced: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM worker_documents WHERE worker_id = $1 AND s3_key = $2) AS referenced`,
        [workerId, s3Key],
      );
      keyStillReferenced = refRes.rows?.[0]?.referenced === true;
    }
    await client.query('COMMIT');

    if (delRes.rowCount === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    // Best-effort S3 delete — vault row is gone regardless.
    if (s3Key && !keyStillReferenced) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET!, Key: s3Key }));
      } catch (s3Err) {
        console.error('worker-doc-delete S3 delete failed (non-fatal):', errorMessage(s3Err));
      }
    }

    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-doc-delete error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
