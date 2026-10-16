import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { listEmployerConversations } from '../lib/job-messaging';
import { checkCompliance } from '../legal/check-compliance';
import { auditCaller, type AuditCaller } from '../lib/audit/caller';
import { recordAccess, recordAttempt, responseFieldNames } from '../lib/audit/record';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';


const CORS_HEADERS = corsHeaders();
const SURFACE = 'employer.conversations_list';
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let caller: AuditCaller | undefined;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
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

    const resolved = await resolveEmployerActor(client, cognitoSub);
    if (!resolved.ok) {
      await client.query('COMMIT');
      return employerActorFailureResponse(resolved, CORS_HEADERS);
    }
    const { actor } = resolved;
    caller = auditCaller(event, { kind: 'employer', id: actor.userId }, 'web');

    const conversations = await listEmployerConversations(client, actor.scopeUserIds);
    const items = conversations;
    await recordAccess(client, caller, {
      surface: SURFACE,
      subjectUserIds: items.map((item) => item.worker_id),
      recordIds: items.map((item) => item.id),
      resultCount: items.length,
      fieldNames: responseFieldNames(items),
    });
    await client.query('COMMIT');

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ conversations }),
    };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch {}
      if (caller) await recordAttempt(client, caller, { surface: SURFACE, outcome: 'failed' });
    }
    console.error('employer-conversations-list error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
