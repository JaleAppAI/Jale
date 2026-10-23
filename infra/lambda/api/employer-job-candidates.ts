import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { listEmployerCandidates } from '../lib/employer-candidate-ranking';
import { checkCompliance } from '../legal/check-compliance';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { recordAccess, recordAttempt, responseFieldNames, type AttemptEvent } from '../lib/audit/record';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SURFACE = 'employer.job_candidates';

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
  let caller: AuditCaller | undefined;
  let attempt: Omit<AttemptEvent, 'outcome'> | undefined;
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
    if (!UUID_REGEX.test(jobId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_job_id' }) };
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

    const resolved = await resolveEmployerActor(client, cognitoSub);
    if (!resolved.ok) {
      await client.query('COMMIT');
      return employerActorFailureResponse(resolved, CORS_HEADERS);
    }
    const { actor } = resolved;
    caller = auditCaller(event, { kind: 'employer', id: actor.userId }, 'web');
    const purpose = { kind: 'job', id: jobId } as const;
    attempt = { surface: SURFACE, purpose };

    const jobCheck = await client.query('SELECT id FROM jobs WHERE id = $1 AND employer_id = ANY($2::uuid[])', [jobId, actor.scopeUserIds]);
    if (jobCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      // The denial rolls back, so its attempt is written after, on its own.
      await recordAttempt(client, caller, { ...attempt, outcome: 'denied' });
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'forbidden' }) };
    }

    const ranked = await listEmployerCandidates(client, jobId, { limit, includeContact: true });
    if (ranked.shouldEnqueueRerank) {
      rerankRequest = { jobId, requestedLimit: limit, sourceHash: ranked.sourceHash };
    }

    // A cached ranking is recorded like any other: the contact fields come
    // from this transaction's read either way.
    const candidates = ranked.response.candidates;
    await recordAccess(client, caller, {
      surface: SURFACE,
      subjectUserIds: candidates.map((candidate) => candidate.worker_id),
      recordIds: candidates.map((candidate) => candidate.worker_id),
      resultCount: candidates.length,
      fieldNames: responseFieldNames(candidates),
      purpose,
    });
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
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      if (caller && attempt) await recordAttempt(client, caller, { ...attempt, outcome: 'failed' });
    }
    console.error('employer-job-candidates error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
