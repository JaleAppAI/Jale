import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import {
  createApplicantConversation,
  getEmployerConversationDetail,
  normalizeMessageBody,
  sendPendingJobMessageOutbox,
} from '../lib/job-messaging';
import { checkCompliance } from '../legal/check-compliance';


const CORS_HEADERS = corsHeaders();
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let outbox: { conversationId: string; employerId: string } | null = null;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }

    const body = JSON.parse(event.body ?? '{}') as { job_id?: unknown; worker_id?: unknown; initial_message?: unknown };
    const jobId = typeof body.job_id === 'string' ? body.job_id : '';
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : '';
    const initialMessage = normalizeMessageBody(body.initial_message);
    if (!jobId || !workerId || !initialMessage) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_conversation_request' }) };
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
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION }),
      };
    }

    const employerRes = await client.query<{ id: string }>('SELECT id FROM users WHERE cognito_sub = $1', [cognitoSub]);
    const employerId = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    await setInternalUserRlsContext(client, employerId);

    const created = await createApplicantConversation(client, employerId, jobId, workerId, initialMessage);
    const detail = await getEmployerConversationDetail(client, created.conversationId, employerId);
    outbox = { conversationId: created.conversationId, employerId };
    await client.query('COMMIT');

    if (outbox) {
      await sendPendingJobMessageOutbox(client, {
        conversationId: outbox.conversationId,
        actorUserId: outbox.employerId,
      });
    }

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify(detail),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    const message = errorMessage(err);
    if (message === 'applicant_not_found') {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'applicant_not_found' }) };
    }
    if (message === 'worker_whatsapp_unavailable') {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'worker_whatsapp_unavailable' }) };
    }
    console.error('employer-conversations-create error:', message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
