import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { cityAnchorsFrom, listMatchedJobsForWorker, loadWorkerPreferredCities } from '../lib/job-matching';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const VALID_JOB_TYPES = ['full-time', 'part-time', 'contract'] as const;
/** Below this many city-matched jobs, also return recent jobs from OUTSIDE the
 * worker's preferred cities in a separate `other_jobs` array. */
const FALLBACK_THRESHOLD = 5;
/** The out-of-city fallback list is a teaser, not a second feed. */
const OTHER_JOBS_CAP = 20;

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

    const workerResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1 AND user_type = 'worker'`,
      [cognitoSub],
    );
    const workerId = workerResult.rows[0]?.id;
    if (!workerId) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }

    const preferredCities = await loadWorkerPreferredCities(client, workerId);
    const cityKeys = preferredCities.map((row) => row.city_key);
    const cityAnchors = cityAnchorsFrom(preferredCities);

    const jobs = await listMatchedJobsForWorker(client, workerId, {
      limit: 100,
      channel: 'api',
      search,
      jobType,
      ...(cityKeys.length > 0 ? { cityKeys } : {}),
      ...(cityAnchors.length > 0 ? { cityAnchors } : {}),
    });

    let otherJobs: typeof jobs = [];
    if (cityKeys.length > 0 && jobs.length < FALLBACK_THRESHOLD) {
      const fallback = await listMatchedJobsForWorker(client, workerId, {
        limit: 100,
        channel: 'api',
        search,
        jobType,
        excludeCityKeys: cityKeys,
        ...(cityAnchors.length > 0 ? { cityAnchors } : {}),
      });
      // A referral-pinned job is fetched by id with no city filter, so it can
      // come back from both queries -- never show the same job twice.
      const seen = new Set(jobs.map((job) => job.id));
      otherJobs = fallback.filter((job) => !seen.has(job.id)).slice(0, OTHER_JOBS_CAP);
    }
    await client.query('COMMIT');

    const shape = (list: typeof jobs) =>
      list.map(({ company, required_docs, match_components, ...job }) => ({
        ...job,
        company,
        company_name: company,
        required_docs: required_docs ?? [],
      }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        jobs: shape(jobs),
        ...(otherJobs.length > 0 ? { other_jobs: shape(otherJobs) } : {}),
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('worker-jobs-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
