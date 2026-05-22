import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = ['resume', 'driver_license', 'ssn'] as const;

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

    const delRes = await client.query(
      `DELETE FROM worker_documents
       WHERE worker_id = $1 AND doc_type = $2 AND job_id IS NULL
       RETURNING s3_key`,
      [workerId, docType],
    );
    await client.query('COMMIT');

    if (delRes.rowCount === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not_found' }) };
    }

    // Best-effort S3 delete — vault row is gone regardless.
    const s3Key = delRes.rows[0].s3_key;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET!, Key: s3Key }));
    } catch (s3Err) {
      console.error('worker-doc-delete S3 delete failed (non-fatal):', errorMessage(s3Err));
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
