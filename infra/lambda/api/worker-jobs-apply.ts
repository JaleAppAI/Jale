import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    const jobId = event.pathParameters?.id;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_id' }) };
    }

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
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

    // 1. Re-check job is active.
    const jobRes = await client.query(
      `SELECT id, required_docs FROM jobs WHERE id = $1 AND status = 'active'`,
      [jobId],
    );
    if (jobRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_closed' }) };
    }
    const requiredDocs: string[] = jobRes.rows[0].required_docs ?? [];

    // 2. Re-check missing_docs.
    const docsRes = await client.query(
      `SELECT DISTINCT doc_type FROM worker_documents
       WHERE worker_id = (SELECT id FROM users WHERE cognito_sub = $1)
         AND doc_type = ANY($2::text[])`,
      [cognitoSub, requiredDocs],
    );
    const uploaded = new Set(docsRes.rows.map((r: any) => r.doc_type));
    const missing_docs = requiredDocs.filter(d => !uploaded.has(d));
    if (missing_docs.length > 0) {
      await client.query('COMMIT');
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_documents', missing_docs }) };
    }

    // 3. Insert application (UNIQUE constraint catches already-applied).
    try {
      const insertRes = await client.query(
        `INSERT INTO job_applications (job_id, worker_id)
         VALUES ($1, (SELECT id FROM users WHERE cognito_sub = $2))
         RETURNING id, job_id, status, applied_at`,
        [jobId, cognitoSub],
      );

      // 4. Copy each required doc into a per-job row for employer visibility.
      //    Prefer vault row, fall back to any other per-job row.
      if (requiredDocs.length > 0) {
        await client.query(
          `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
           SELECT DISTINCT ON (doc_type) worker_id, $1::uuid, doc_type, s3_key, file_name, file_size, mime_type
           FROM worker_documents
           WHERE worker_id = (SELECT id FROM users WHERE cognito_sub = $2)
             AND doc_type = ANY($3::text[])
           ORDER BY doc_type, (job_id IS NULL) DESC, uploaded_at DESC
           ON CONFLICT DO NOTHING`,
          [jobId, cognitoSub, requiredDocs],
        );
      }

      await client.query('COMMIT');
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify(insertRes.rows[0]) };
    } catch (insertErr: any) {
      if (insertErr?.code === '23505') {
        await client.query('ROLLBACK');
        return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'already_applied' }) };
      }
      throw insertErr;
    }
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-apply error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
