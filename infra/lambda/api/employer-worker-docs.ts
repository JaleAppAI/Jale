import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDbPool, setRlsContext } from '../lib/db';
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

    const docsResult = await client.query(
      `SELECT doc_type, s3_key, file_name, file_size, uploaded_at, s3_version_id
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

    const documents = await Promise.all(
      docsResult.rows.map(async (doc) => {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.DOCUMENTS_BUCKET!,
            Key: doc.s3_key,
            ...(doc.s3_version_id ? { VersionId: doc.s3_version_id } : {}),
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
