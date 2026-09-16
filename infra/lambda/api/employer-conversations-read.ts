import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';

const CORS_HEADERS = corsHeaders();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /employer/conversations/{conversationId}/read — stamp
 * `job_conversations.employer_last_read_at` for the employer's OWN thread.
 *
 * This is the write half of the employer unread badge. `lib/employer-inbox.ts`
 * derives `unread` from `last_worker_message_at > employer_last_read_at`, so
 * this endpoint is the only thing that ever clears it.
 *
 * ── WHY `now()` AND NOT A CLIENT TIMESTAMP ────────────────────────────────
 * The stamp is compared against `last_worker_message_at`, which the WhatsApp
 * relay writes with the database's own clock. A client-supplied time would be
 * compared against a different clock: a browser running a few seconds fast
 * would mark messages read that had not arrived yet, silently swallowing the
 * badge for the next inbound message. Taking it from the same server clock is
 * what makes the comparison meaningful, and it is why this handler accepts no
 * request body at all.
 *
 * ── TWO RLS CONTEXTS, BOTH LOAD-BEARING ───────────────────────────────────
 * `job_conversations` is ENABLE + FORCE ROW LEVEL SECURITY (025:87-88) and
 * jale_admin -- the role this Lambda connects as, and the table's owner --
 * obeys its policies because of FORCE. The applicable one is
 * `job_conversations_employer_all FOR ALL TO jale_admin` (025:93-97), keyed on
 * `app.current_internal_user_id`. So `setInternalUserRlsContext` is not
 * bookkeeping: without it the UPDATE below matches ZERO rows and the employer
 * gets a 404 on their own conversation. `setRlsContext` (app.current_user_id)
 * is what the legal/compliance read keys on.
 *
 * No new grant was needed: 025:78 grants jale_admin table-level
 * SELECT, INSERT, UPDATE on job_conversations, and a table-level privilege
 * covers columns added later -- `employer_last_read_at` among them (added by
 * 028:37).
 *
 * ── 404 MEANS "NOT YOURS **OR** NOT THERE" ────────────────────────────────
 * The UPDATE is scoped by RLS *and* by an explicit `employer_id` predicate, so
 * a conversation belonging to another employer and a conversation that does
 * not exist both come back as zero rows and both answer the same 404 with the
 * same body. Distinguishing them would turn this endpoint into an existence
 * oracle over every conversation id in the system.
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

    const employerRes = await client.query<{ id: string }>('SELECT id FROM users WHERE cognito_sub = $1', [cognitoSub]);
    const employerId = employerRes.rows[0]?.id;
    if (!employerId) {
      await client.query('COMMIT');
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'user_not_provisioned' }) };
    }
    await setInternalUserRlsContext(client, employerId);

    const updated = await client.query<{ employer_last_read_at: string }>(
      `UPDATE job_conversations
          SET employer_last_read_at = now()
        WHERE id = $1
          AND employer_id = $2
      RETURNING employer_last_read_at`,
      [conversationId, employerId],
    );
    await client.query('COMMIT');

    if ((updated.rowCount ?? 0) === 0) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'conversation_not_found' }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        conversation_id: conversationId,
        employer_last_read_at: updated.rows[0].employer_last_read_at,
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
