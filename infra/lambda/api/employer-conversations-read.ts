import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { markEmployerConversationRead } from '../lib/job-messaging';
import { checkCompliance } from '../legal/check-compliance';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /employer/conversations/{conversationId}/read — stamp
 * `job_conversations.employer_last_read_at` for a thread in the caller's
 * scope: their own, or, for the company's owner, any member's.
 *
 * This is the write half of the employer unread badge. `lib/employer-inbox.ts`
 * derives `unread` from `last_inbound_message_at > employer_last_read_at` --
 * the newest message the worker actually SENT, not last_worker_message_at,
 * which the "Open conversation" path stamps without a message row -- so this
 * endpoint is the only thing that ever clears it.
 *
 * The UPDATE itself lives in `lib/job-messaging.ts` as
 * `markEmployerConversationRead`, alongside the other five employer
 * conversation statements, so there is exactly one place where SQL against
 * `job_conversations` is written and reviewed. Its own doc comment carries the
 * `now()`-not-a-client-timestamp reasoning and the RLS contract; this handler
 * owns the HTTP shape.
 *
 * ── TWO RLS CONTEXTS, BOTH LOAD-BEARING ───────────────────────────────────
 * `job_conversations` is ENABLE + FORCE ROW LEVEL SECURITY (025:87-88). This
 * Lambda connects as the request login, jale_api (DB_EXPECTED_LOGIN, from
 * `dedicatedDbLogin(this, 'jale_api')` in api-stack.ts), and two permissive
 * policies admit its UPDATE, both keyed on `app.current_internal_user_id`:
 * `job_conversations_employer_all__api` (106's copy of 025:93-97), the
 * caller's own threads, and 119's `job_conversations_org_owner_all`, which
 * admits a company owner's mark-read on every member's threads. So the
 * internal id `resolveEmployerActor` binds is not bookkeeping: without it the
 * UPDATE below matches ZERO rows and the employer gets a 404 on their own
 * conversation. `setRlsContext` (app.current_user_id) is what the
 * legal/compliance read keys on.
 *
 * Column rights: the access manifest grants jale_api UPDATE on
 * `employer_last_read_at` (added by 028:37) among job_conversations' columns
 * (106).
 *
 * ── 404 MEANS "NOT YOURS **OR** NOT THERE" ────────────────────────────────
 * The UPDATE is scoped by RLS *and* by an explicit `employer_id = ANY(scope)`
 * predicate, so a conversation outside the caller's scope and a conversation
 * that does not exist both come back as zero rows and both answer the same
 * 404 with the same body. Distinguishing them would turn this endpoint into an
 * existence oracle over every conversation id in the system.
 *
 * ── THE updated_at SIDE EFFECT (accepted) ─────────────────────────────────
 * 025:74-76 puts an unconditional `BEFORE UPDATE ... set_updated_at()` trigger
 * on this table, so marking a thread read advances its `updated_at`. Nothing
 * orders or sweeps on that column -- the inbox and both conversation lists
 * order by `COALESCE(last_message_at, created_at)` -- so the only consequence
 * is a newer `updated_at` on the conversation summary the frontend already
 * receives.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;

  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    const conversationId = event.pathParameters?.conversationId;
    if (!cognitoSub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'unauthorized' }) };
    }
    if (!conversationId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'missing_conversation_id' }) };
    }
    // Rejected here rather than at the database: a non-UUID reaches Postgres as
    // a 22P02 invalid_text_representation, which the catch-all below would
    // report as a 500 -- a client error dressed up as an outage.
    if (!UUID_REGEX.test(conversationId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid_conversation_id' }) };
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

    // `checkCompliance` above SELECTs only `tos_version`
    // (legal/check-compliance.ts:21) and never returns the internal id, which is
    // what job_conversations_employer_all keys on. resolveEmployerActor reads it
    // (with the caller's company scope) and binds it, the same as every sibling
    // handler (employer-conversations-update.ts, -detail.ts, -send.ts,
    // employer-inbox.ts).
    const resolved = await resolveEmployerActor(client, cognitoSub);
    if (!resolved.ok) {
      await client.query('COMMIT');
      return employerActorFailureResponse(resolved, CORS_HEADERS);
    }
    const { actor } = resolved;

    const readAt = await markEmployerConversationRead(client, conversationId, actor.scopeUserIds);
    await client.query('COMMIT');

    if (readAt === null) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'conversation_not_found' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        conversation_id: conversationId,
        employer_last_read_at: readAt,
      }),
    };
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('employer-conversations-read error:', errorMessage(err));
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'internal_error' }) };
  } finally {
    if (client) client.release();
  }
};
