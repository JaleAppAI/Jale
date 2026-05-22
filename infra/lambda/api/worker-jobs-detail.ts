import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
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

    const workerRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1`, [cognitoSub]);
    if (workerRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    const workerId: string = workerRes.rows[0].id;
    await setInternalUserRlsContext(client, workerId);

    const jobRes = await client.query(
      `SELECT j.id, j.title, j.location, j.job_type, j.description, j.required_docs, j.created_at,
              u.full_name AS company_name
       FROM jobs j JOIN users u ON u.id = j.employer_id
       WHERE j.id = $1 AND j.status = 'active'`,
      [jobId],
    );
    if (jobRes.rows.length === 0) {
      await client.query('COMMIT');
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'job_not_found' }) };
    }
    const job = jobRes.rows[0];
    const requiredDocs: string[] = Array.isArray(job.required_docs) ? job.required_docs : [];

    const docsRes = requiredDocs.length > 0
      ? await client.query(
        `SELECT DISTINCT doc_type FROM worker_documents
         WHERE worker_id = $1
           AND doc_type = ANY($2::text[])
           AND (job_id IS NULL OR job_id = $3::uuid)`,
        [workerId, requiredDocs, jobId],
      )
      : { rows: [] };
    const uploadedTypes = new Set(docsRes.rows.map((r: any) => r.doc_type));
    const missing_docs = requiredDocs.filter(d => !uploadedTypes.has(d));

    const appRes = await client.query(
      `SELECT status FROM job_applications
       WHERE job_id = $1 AND worker_id = $2`,
      [jobId, workerId],
    );
    const already_applied = appRes.rows.length > 0;
    const application_status = already_applied ? appRes.rows[0].status : null;

    await client.query('COMMIT');
    return {
      statusCode: 200, headers: CORS_HEADERS,
      body: JSON.stringify({ ...job, required_docs: requiredDocs, already_applied, application_status, missing_docs }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-detail error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
