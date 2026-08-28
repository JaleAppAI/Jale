import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const s3 = new S3Client({});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'unauthorized' }),
      };
    }

    const workerId = event.pathParameters?.worker_id;
    const jobId = event.queryStringParameters?.job_id;
    if (!workerId || !jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_params' }),
      };
    }
    if (!UUID_RE.test(workerId) || !UUID_RE.test(jobId)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_params' }),
      };
    }

    const pool = await getDbPool();
    client = await pool.connect();

    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(
      client,
      cognitoSub,
      process.env.REQUIRED_TOS_VERSION!,
    );
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'user_not_provisioned' }),
      };
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'legal_required',
          requiredVersion: process.env.REQUIRED_TOS_VERSION,
        }),
      };
    }

    // Same two-lane bind as the sibling employer reads
    // (`employer-worker-profile`, `employer-worker-posts`): `setRlsContext`
    // above stays bound because `worker_documents_employer_select` (018)
    // resolves the employer through `app.current_user_id`, and
    // `setInternalUserRlsContext` writes a SEPARATE GUC that the newer
    // internal-id policies key on. It must carry the EMPLOYER's id -- the
    // worker's would satisfy the worker-self policies instead.
    const employerRes = await client.query(
      `SELECT id FROM users WHERE cognito_sub = $1`,
      [cognitoSub],
    );
    const employerId: string | undefined = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'user_not_provisioned' }),
      };
    }
    await setInternalUserRlsContext(client, employerId);

    const applicantCheck = await client.query(
      `SELECT 1
       FROM job_applications ja
       JOIN jobs j ON j.id = ja.job_id
       JOIN users employer ON employer.id = j.employer_id
       WHERE ja.worker_id = $1
         AND ja.job_id = $2
         AND employer.cognito_sub = $3
       LIMIT 1`,
      [workerId, jobId, cognitoSub],
    );
    if (applicantCheck.rows.length === 0) {
      await client.query('COMMIT');
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'forbidden' }),
      };
    }

    // cert_name is additive here (BE-T3): lets the employer see which
    // labeled certification file they're looking at (e.g. "OSHA 30" vs
    // "Forklift cert") among the up-to-20 files a slot may hold.
    const docsResult = await client.query(
      `SELECT id, doc_type, s3_key, file_name, file_size, uploaded_at, s3_version_id, cert_name
       FROM worker_documents wd
       JOIN job_applications ja ON ja.worker_id = wd.worker_id AND ja.job_id = wd.job_id
       JOIN jobs j ON j.id = ja.job_id
       JOIN users employer ON employer.id = j.employer_id
       WHERE wd.worker_id = $1
         AND wd.job_id = $2
         AND employer.cognito_sub = $3`,
      [workerId, jobId, cognitoSub],
    );

    await client.query('COMMIT');

    // `s3_key`/`s3_version_id` are destructured OUT rather than spread
    // through: the bucket is private, every read the browser makes is this
    // server-minted presigned URL, and the key is an internal storage address
    // that also spells out the worker/job it belongs to. Both are still
    // SELECTed -- they are what the presigner signs, including the version pin
    // that keeps an employer looking at the exact bytes that were uploaded.
    const documents = await Promise.all(
      docsResult.rows.map(async ({ s3_key, s3_version_id, ...doc }) => {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.DOCUMENTS_BUCKET!,
            Key: s3_key,
            ...(s3_version_id ? { VersionId: s3_version_id } : {}),
          }),
          { expiresIn: 900 },
        );
        return { ...doc, url };
      }),
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ documents }),
    };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    console.error('employer-worker-docs error:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'internal_error' }),
    };
  } finally {
    if (client) client.release();
  }
};
