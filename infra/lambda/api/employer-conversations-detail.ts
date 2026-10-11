import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { getEmployerConversationDetail } from '../lib/job-messaging';
import { checkCompliance } from '../legal/check-compliance';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { conversationReadEvent } from '../lib/audit/conversations';
import { recordAccess, recordAttempt, type AttemptEvent } from '../lib/audit/record';


const CORS_HEADERS = corsHeaders();
const SURFACE = 'employer.conversation_detail';
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let caller: AuditCaller | undefined;
  let attempt: Omit<AttemptEvent, 'outcome'> | undefined;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    const conversationId = event.pathParameters?.conversationId;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    if (!conversationId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_conversation_id' }) };
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
    caller = auditCaller(event, { kind: 'employer', id: employerId }, 'web');
    attempt = { surface: SURFACE, recordIds: [conversationId] };

    const detail = await getEmployerConversationDetail(client, conversationId, employerId);
    if (detail) await recordAccess(client, caller, conversationReadEvent(SURFACE, detail));
    await client.query('COMMIT');

    if (!detail) {
      // Not found on a named thread: recorded once the transaction has ended.
      await recordAttempt(client, caller, { ...attempt, outcome: 'not_found' });
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'conversation_not_found' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(detail),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      if (caller && attempt) await recordAttempt(client, caller, { ...attempt, outcome: 'failed' });
    }
    console.error('employer-conversations-detail error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
