import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { isJobViewSource, recordJobView, type JobViewSource } from '../lib/analytics-capture';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders } from '../lib/http';
import { isUuid } from '../lib/uuid';

/**
 * POST /worker/jobs/{jobId}/view -- worker authorizer (contract K3.6,
 * analytics item 17). The job page reports one visit, with where the worker
 * came from (`{ source: 'feed' | 'public_link' | 'whatsapp' | 'direct' }`),
 * and jale_cap.record_job_view keeps at most one row per worker, job and
 * hour.
 *
 * Always 204 with no body: bad input, a caller who is not a worker, a failed
 * write and an unreachable database all answer the same, and the page never
 * waits on or shows anything from this call. Served by the job detail Lambda
 * (worker-job-dispatch.ts), on the same login and grants.
 */
const NO_CONTENT = (): APIGatewayProxyResult => ({ statusCode: 204, headers: corsHeaders(), body: '' });

function sourceOf(body: string | null | undefined): JobViewSource | null {
  try {
    const parsed: unknown = JSON.parse(body ?? 'null');
    const source = typeof parsed === 'object' && parsed !== null ? (parsed as { source?: unknown }).source : undefined;
    return isJobViewSource(source) ? source : null;
  } catch {
    return null;
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const cognitoSub: unknown = event.requestContext?.authorizer?.claims?.sub;
  const jobId = event.pathParameters?.jobId;
  const source = sourceOf(event.body);
  if (typeof cognitoSub !== 'string' || cognitoSub === '' || !isUuid(jobId) || !source) {
    return NO_CONTENT();
  }

  let client;
  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);
    const worker = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 AND user_type = 'worker'`,
      [cognitoSub],
    );
    const workerId = worker.rows[0]?.id;
    if (workerId) {
      // The function takes the worker from this context, never an argument.
      await setInternalUserRlsContext(client, workerId);
      await recordJobView(client, jobId, source);
    }
    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* released below */ }
    }
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
    console.warn(JSON.stringify({ metric: 'AnalyticsCaptureSkipped', capture: 'job_view', code }));
  } finally {
    client?.release();
  }
  return NO_CONTENT();
};
