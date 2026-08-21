import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { DOC_TYPES } from '../lib/job-fields';
import { validateCertName } from '../lib/cert-name';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const VALID_DOC_TYPES = DOC_TYPES;
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    let body: { doc_type?: string; mime_type?: string; cert_name?: string | null };
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_json' }) }; }

    const { doc_type, mime_type, cert_name } = body;
    if (!doc_type || !mime_type) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_fields', required: ['doc_type', 'mime_type'] }) };
    }
    if (!VALID_DOC_TYPES.includes(doc_type as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_doc_type', valid: VALID_DOC_TYPES }) };
    }
    // cert_name is OPTIONAL here even for certification_doc -- no frontend
    // caller sends it at presign time (it's supplied later, at confirm; see
    // ../lib/cert-name.ts). This only rejects a cert_name that's malformed or
    // present on the wrong doc_type, as fail-fast validation before the
    // client burns a presigned PUT on an upload that would 400 at confirm.
    const certResult = validateCertName(doc_type, cert_name, false);
    if (!certResult.ok) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: certResult.error }) };
    }
    const ext = MIME_TO_EXT[mime_type];
    if (!ext) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_mime_type', valid: Object.keys(MIME_TO_EXT) }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    // Compliance first — uses cognito_sub RLS convention.
    await setRlsContext(client, cognitoSub);
    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion }) };
    }

    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (userRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_found' }) };
    }
    const workerId: string = userRes.rows[0].id;
    await client.query('COMMIT');

    const s3Key = `documents/vault/${workerId}/${doc_type}/${randomUUID()}.${ext}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: process.env.DOCUMENTS_BUCKET!, Key: s3Key, ContentType: mime_type }),
      { expiresIn: 900 },
    );

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ url, s3_key: s3Key }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-doc-upload-url-auth error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
