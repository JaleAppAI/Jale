import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const search = event.queryStringParameters?.search?.trim() ?? '';
    const jobType = event.queryStringParameters?.job_type;
    if (jobType && !VALID_JOB_TYPES.includes(jobType as any)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_type', valid: VALID_JOB_TYPES }) };
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

    const params: any[] = [];
    const where: string[] = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(j.title ILIKE $${params.length} OR j.location ILIKE $${params.length})`);
    }
    if (jobType) {
      params.push(jobType);
      where.push(`j.job_type = $${params.length}`);
    }
    const whereClause = where.length > 0 ? `AND ${where.join(' AND ')}` : '';

    const result = await client.query(
      `SELECT j.id, j.title, j.location, j.job_type, j.required_docs, j.created_at,
              u.full_name AS company_name
       FROM jobs j
       JOIN users u ON u.id = j.employer_id
       WHERE j.status = 'active' ${whereClause}
       ORDER BY j.created_at DESC
       LIMIT 100`,
      params,
    );
    await client.query('COMMIT');

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ jobs: result.rows }) };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
