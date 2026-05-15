import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { listEmployerCandidates } from '../lib/employer-candidate-ranking';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();

function parseLimit(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(Math.trunc(parsed), 100));
}

async function enqueueRerank(jobId: string, requestedLimit: number, sourceHash: string): Promise<void> {
  const queueUrl = process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL;
  if (!queueUrl) {
    console.warn('[employer-job-candidates] rerank queue URL not configured');
    return;
  }

  const sqsClient = new SQSClient({});
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      jobId,
      requestedLimit,
      sourceHash,
      requestedAt: new Date().toISOString(),
    }),
  }));
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let rerankRequest: { jobId: string; requestedLimit: number; sourceHash: string } | null = null;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const jobId = event.pathParameters?.jobId;
    if (!jobId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_job_id' }) };
    }

    const limit = parseLimit(event.queryStringParameters?.limit);
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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    const jobCheck = await client.query('SELECT id FROM jobs WHERE id = $1', [jobId]);
    if (jobCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    const ranked = await listEmployerCandidates(client, jobId, { limit });
    if (ranked.shouldEnqueueRerank) {
      rerankRequest = { jobId, requestedLimit: limit, sourceHash: ranked.sourceHash };
    }

    await client.query('COMMIT');

    if (rerankRequest) {
      try {
        await enqueueRerank(rerankRequest.jobId, rerankRequest.requestedLimit, rerankRequest.sourceHash);
      } catch (err) {
        console.error('[employer-job-candidates] rerank enqueue failed:', errorMessage(err));
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(ranked.response),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('employer-job-candidates error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
