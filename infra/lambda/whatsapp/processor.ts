import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import type { PoolClient } from 'pg';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AuthFlowType,
  ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { getDbPool, setRlsContext } from '../lib/db';
import { parseFormBody, type TwilioSecret } from './lib/twilio';
import {
  t,
  detectLanguage,
  type Lang,
  type TemplateKey,
} from './lib/templates';
import {
  isGreetingKeyword,
  isJobsKeyword,
  isAccept,
  isDecline,
  parseButtonPayload,
  parseProfileAnswer,
  computeNextField,
  type ConversationState,
  type ProfileField,
  type ProfileStateContext,
} from './lib/flows';
import { decodeIdTokenSub } from './lib/jwt';

// ── Module-level AWS clients ────────────────────────────────────
const cognito = new CognitoIdentityProviderClient({});
const secretsManager = new SecretsManagerClient({});

// ── Twilio secret cache (5-min TTL) ─────────────────────────────
let cachedTwilio: TwilioSecret | null = null;
let twilioCacheExp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getTwilioSecret(): Promise<TwilioSecret> {
  const now = Date.now();
  if (cachedTwilio && now < twilioCacheExp) return cachedTwilio;
  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN not set');
  const r = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error('TWILIO secret empty');
  cachedTwilio = JSON.parse(r.SecretString) as TwilioSecret;
  twilioCacheExp = now + CACHE_TTL_MS;
  return cachedTwilio;
}

// ── Twilio send (session-message, plain text) ───────────────────
async function sendTwilioMessage(to: string, body: string): Promise<void> {
  const secret = await getTwilioSecret();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${secret.accountSid}/Messages.json`;
  const form = new URLSearchParams({
    MessagingServiceSid: secret.messagingServiceSid,
    To: to, // Already in "whatsapp:+1..." format from Twilio inbound event
    Body: body,
  });
  const auth = Buffer.from(`${secret.accountSid}:${secret.authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio send failed ${res.status}: ${text}`);
  }
}

// ── Outbox helpers (Fix Plan v3, 2026-04-17) ────────────────────
//
// Replies are NO LONGER sent inline by handlers. Instead every reply writes
// a row to `whatsapp_outbox` within the same DB transaction as the state
// change, and `sendPendingOutbox` flushes them to Twilio AFTER the
// transaction commits. This prevents the "state advanced but reply never
// arrived" class of silent bug that SQS retries used to create.

async function queueText(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  body: string,
): Promise<void> {
  const whatsappNumber = to.replace(/^whatsapp:/, '');
  // Computing the next sequence in-SQL is race-free within the enclosing
  // transaction — all queue writes for one inbound SID happen in one tx.
  await client.query(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, body)
     VALUES (
       $1,
       (SELECT COALESCE(MAX(sequence), 0) + 1
          FROM whatsapp_outbox
         WHERE inbound_message_sid = $1),
       $2, $3
     )`,
    [inboundMessageSid, whatsappNumber, body],
  );
}

async function queueReply(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  key: TemplateKey,
  lang: Lang,
  vars?: Record<string, string>,
): Promise<void> {
  await queueText(client, inboundMessageSid, to, t(key, lang, vars));
}

// Thin facade so handler code reads `reply(client, msg, key, ...)` instead of
// plumbing messageSid + msg.from through every call site.
async function reply(
  client: PoolClient,
  msg: IncomingMessage,
  key: TemplateKey,
  lang: Lang,
  vars?: Record<string, string>,
): Promise<void> {
  await queueReply(client, msg.messageSid, msg.from, key, lang, vars);
}

/**
 * Drain pending outbox rows to Twilio. Called AFTER the DB transaction
 * commits. On first failure, records the error and re-throws so the SQS
 * handler can retry; subsequent retry invocations resume from 'db_committed'
 * via `processRecord`'s conflict branch and re-enter this function.
 */
async function sendPendingOutbox(
  client: PoolClient,
  inboundMessageSid: string,
): Promise<void> {
  const pending = await client.query<{
    id: string;
    sequence: number;
    whatsapp_number: string;
    body: string;
  }>(
    `SELECT id, sequence, whatsapp_number, body
       FROM whatsapp_outbox
      WHERE inbound_message_sid = $1
        AND status IN ('pending', 'failed')
      ORDER BY sequence`,
    [inboundMessageSid],
  );
  for (const row of pending.rows) {
    try {
      await sendTwilioMessage(`whatsapp:${row.whatsapp_number}`, row.body);
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'sent', sent_at = now()
          WHERE id = $1`,
        [row.id],
      );
    } catch (err) {
      await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'failed',
                attempt_count = attempt_count + 1,
                last_error = $1
          WHERE id = $2`,
        [(err as Error).message, row.id],
      );
      // Propagate so SQS retries the whole message. The next retry will see
      // `processed_messages.status = 'db_committed'` and re-enter
      // sendPendingOutbox without re-executing any state mutations.
      throw err;
    }
  }
}

async function markCompleted(
  client: PoolClient,
  inboundMessageSid: string,
): Promise<void> {
  await client.query(
    `UPDATE whatsapp_processed_messages
        SET status = 'completed',
            completed_at = now(),
            updated_at = now()
      WHERE message_sid = $1`,
    [inboundMessageSid],
  );
}

// ── Conversation row shape (subset of the DB columns) ───────────
interface ConversationRow {
  id: string;
  user_id: string | null;
  whatsapp_number: string;
  language: Lang;
  conversation_state: ConversationState;
  state_context: ProfileStateContext;
  otp_attempts: number;
  otp_expires_at: Date | null;
  last_processed_message_sid: string | null;
}

// ── DB: conversation lookup / upsert ────────────────────────────
//
// After Fix Plan v3, the processor always calls
// `getOrCreateConversationForUpdate` to serialize concurrent Lambdas
// against the same whatsapp_number. The plain `getOrCreateConversation`
// is retained for job-alert and read-only callers.
async function getOrCreateConversation(
  client: PoolClient,
  whatsappNumber: string,
  defaultLang: Lang,
): Promise<ConversationRow> {
  const existing = await client.query<ConversationRow>(
    `SELECT id, user_id, whatsapp_number, language,
            conversation_state, state_context, otp_attempts,
            otp_expires_at, last_processed_message_sid
       FROM whatsapp_conversations
      WHERE whatsapp_number = $1`,
    [whatsappNumber],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0];

  const created = await client.query<ConversationRow>(
    `INSERT INTO whatsapp_conversations (whatsapp_number, language)
     VALUES ($1, $2)
     RETURNING id, user_id, whatsapp_number, language,
               conversation_state, state_context, otp_attempts,
               otp_expires_at, last_processed_message_sid`,
    [whatsappNumber, defaultLang],
  );
  return created.rows[0];
}

/**
 * Same as getOrCreateConversation but takes a row-level lock on an existing
 * row via `FOR UPDATE`. Used by processRecord so two Lambdas processing
 * different MessageSids for the same whatsapp_number serialize — the second
 * one blocks until the first's transaction commits.
 *
 * If the row doesn't exist yet, INSERT races are resolved by the
 * `UNIQUE (whatsapp_number)` constraint on the table: one INSERT wins, the
 * other fails with a duplicate-key error and SQS retries the losing message.
 * This is rare in practice (only fires on two messages landing within the
 * same millisecond before any row exists).
 */
async function getOrCreateConversationForUpdate(
  client: PoolClient,
  whatsappNumber: string,
  defaultLang: Lang,
): Promise<ConversationRow> {
  const existing = await client.query<ConversationRow>(
    `SELECT id, user_id, whatsapp_number, language,
            conversation_state, state_context, otp_attempts,
            otp_expires_at, last_processed_message_sid
       FROM whatsapp_conversations
      WHERE whatsapp_number = $1
      FOR UPDATE`,
    [whatsappNumber],
  );
  if (existing.rowCount && existing.rowCount > 0) return existing.rows[0];

  const created = await client.query<ConversationRow>(
    `INSERT INTO whatsapp_conversations (whatsapp_number, language)
     VALUES ($1, $2)
     RETURNING id, user_id, whatsapp_number, language,
               conversation_state, state_context, otp_attempts,
               otp_expires_at, last_processed_message_sid`,
    [whatsappNumber, defaultLang],
  );
  return created.rows[0];
}

async function updateConversation(
  client: PoolClient,
  id: string,
  patch: Partial<{
    user_id: string;
    language: Lang;
    conversation_state: ConversationState;
    state_context: ProfileStateContext;
    otp_attempts: number;
    otp_expires_at: Date | null;
    last_processed_message_sid: string;
  }>,
): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = entries.map(([, v]) =>
    typeof v === 'object' && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v,
  );
  await client.query(
    `UPDATE whatsapp_conversations SET ${sets}, updated_at = now() WHERE id = $1`,
    [id, ...values],
  );
}

// ── Main SQS handler ────────────────────────────────────────────
export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error('[processor] record failed:', err);
      // Re-throw so SQS retries via visibility timeout → eventually DLQ
      throw err;
    }
  }
};

async function processRecord(record: SQSRecord): Promise<void> {
  const params = parseFormBody(record.body);
  const messageSid = params.MessageSid;
  const from = params.From; // "whatsapp:+15125551234"
  const body = params.Body ?? '';
  const buttonPayload = params.ButtonPayload; // present on template button taps

  if (!from || !messageSid) {
    console.warn('[processor] skipping: missing From/MessageSid', { messageSid, from });
    return;
  }

  const whatsappNumber = from.replace(/^whatsapp:/, '');
  const defaultLang = detectLanguage(body);

  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    // ── Claim + side-effects transaction (Fix Plan v3, 2026-04-17) ────────
    //
    // Atomic MessageSid claim via `INSERT ... ON CONFLICT DO NOTHING
    // RETURNING`. UNIQUE(message_sid) on whatsapp_processed_messages (PK)
    // means concurrent Lambdas racing on the same SID — whether from Twilio
    // webhook retries or SQS Standard re-delivery — deterministically elect
    // one winner. The loser rolls back with no side effects.
    //
    // Side effects and outbox writes both live inside this tx, so COMMIT
    // atomically publishes the state transition AND the replies that must
    // follow it. If any step throws, ROLLBACK discards everything including
    // the claim, and SQS retry cleanly re-claims.
    let claimed = false;
    await client.query('BEGIN');
    try {
      const claim = await client.query<{ message_sid: string }>(
        `INSERT INTO whatsapp_processed_messages
            (message_sid, whatsapp_number, status)
         VALUES ($1, $2, 'processing')
         ON CONFLICT (message_sid) DO NOTHING
         RETURNING message_sid`,
        [messageSid, whatsappNumber],
      );

      if (claim.rowCount === 0) {
        // Another invocation already holds the claim. Lock the row and
        // branch on its current status.
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM whatsapp_processed_messages
            WHERE message_sid = $1
            FOR UPDATE`,
          [messageSid],
        );
        const status = existing.rows[0]?.status;
        await client.query('COMMIT');

        if (status === 'db_committed') {
          // Prior invocation committed state but its Twilio sends didn't
          // fully land (Lambda crash, timeout, Twilio outage). Resume from
          // the outbox without re-executing any state mutations.
          console.log('[processor] resuming db_committed claim', { messageSid });
          await sendPendingOutbox(client, messageSid);
          await markCompleted(client, messageSid);
          return;
        }
        // completed → no-op. processing → another invocation is in flight;
        // SQS will redeliver and we will re-evaluate then. failed → operator
        // review (DLQ).
        console.log('[processor] skipping already-claimed SID', { messageSid, status });
        return;
      }

      claimed = true;

      // Serialize concurrent Lambdas targeting the same whatsapp_number.
      // Defense-in-depth: the claim above already blocks duplicate SIDs,
      // but the FOR UPDATE lock ensures two DIFFERENT messages for the
      // same conversation process in order.
      const conv = await getOrCreateConversationForUpdate(
        client,
        whatsappNumber,
        defaultLang,
      );

      await routeMessage(client, conv, { body, buttonPayload, messageSid, from });

      // Flip the claim to 'db_committed' in the SAME tx. After COMMIT, SQS
      // retries re-enter via the conflict branch above and resume from the
      // outbox — no re-execution of state mutations.
      await client.query(
        `UPDATE whatsapp_processed_messages
            SET status = 'db_committed', updated_at = now()
          WHERE message_sid = $1`,
        [messageSid],
      );
      await client.query('COMMIT');
    } catch (err) {
      // On any failure inside the tx, ROLLBACK discards the claim. SQS retry
      // re-claims cleanly. We swallow rollback errors because the
      // connection may already be in an aborted state.
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      if (!claimed) {
        console.warn('[processor] claim failed before first mutation', {
          messageSid,
          err: (err as Error).message,
        });
      }
      throw err;
    }

    // Phase 2 — outside the tx, do the Twilio sends. If any throw, SQS
    // retry resumes from 'db_committed'. No DB rollback: the state is
    // already durably committed.
    await sendPendingOutbox(client, messageSid);
    await markCompleted(client, messageSid);
  } finally {
    client.release();
  }
}

// ── State router ────────────────────────────────────────────────
interface IncomingMessage {
  body: string;
  buttonPayload: string | undefined;
  messageSid: string;
  from: string;
}

async function routeMessage(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const from = msg.from;

  // Button-payload taps on job alerts are self-identifying. Route them first
  // — they can arrive in any state except onboarding (worker must be linked).
  if (msg.buttonPayload) {
    const parsed = parseButtonPayload(msg.buttonPayload);
    if (parsed && (conv.conversation_state === 'idle' || conv.user_id)) {
      await handleJobButton(client, conv, parsed, from, msg.messageSid);
      return;
    }
  }

  switch (conv.conversation_state) {
    case 'new':
    case 'otp_timeout':
    case 'legal_declined':
      // On re-contact with a greeting, restart onboarding from `new`.
      if (isGreetingKeyword(msg.body) || conv.conversation_state === 'new') {
        await handleNewOrRestart(client, conv, msg);
      } else {
        await reply(client, msg, 'welcome_new_user', conv.language);
      }
      return;

    case 'awaiting_otp':
      await handleAwaitingOtp(client, conv, msg);
      return;

    case 'awaiting_legal':
      await handleAwaitingLegal(client, conv, msg);
      return;

    case 'building_profile':
      await handleBuildingProfile(client, conv, msg);
      return;

    case 'idle':
      await handleIdle(client, conv, msg);
      return;
  }
}

// ── new / restart — SignUp + InitiateAuth(CUSTOM_AUTH) ──────────
async function handleNewOrRestart(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const lang = detectLanguage(msg.body);
  const whatsappNumber = conv.whatsapp_number;

  // Try SignUp — if user already exists, Cognito returns UsernameExistsException.
  const clientId = process.env.WORKER_CLIENT_ID;
  if (!clientId) throw new Error('WORKER_CLIENT_ID not set');
  const poolId = process.env.WORKER_POOL_ID;
  if (!poolId) throw new Error('WORKER_POOL_ID not set');

  let isNewUser = true;
  try {
    // Password is random — we never use it. Custom auth does passwordless OTP.
    const randomPassword =
      'Jale!' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await cognito.send(new SignUpCommand({
      ClientId: clientId,
      Username: whatsappNumber,
      Password: randomPassword,
      UserAttributes: [
        { Name: 'phone_number', Value: whatsappNumber },
        { Name: 'custom:user_type', Value: 'worker' },
      ],
    }));

    // Confirm immediately via admin API — custom auth needs a CONFIRMED user.
    // AdminConfirmSignUp does NOT fire PostConfirmation, but we defensively
    // insert the DB row in the processor regardless (Codex Door-2 fix).
    await cognito.send(new AdminConfirmSignUpCommand({
      UserPoolId: poolId,
      Username: whatsappNumber,
    }));
  } catch (err: any) {
    if (err?.name === 'UsernameExistsException') {
      isNewUser = false;
    } else {
      throw err;
    }
  }

  // Defensive INSERT: ensure the DB row exists whether this is a new or
  // existing user. PostConfirmation is not guaranteed to have fired, so the
  // processor must own this concern (Codex review outcome).
  // Uses jale_whatsapp's INSERT grant on users (granted in 003_whatsapp.sql).
  await client.query(
    `INSERT INTO users (cognito_sub, user_type, phone)
     VALUES ($1, 'worker', $2)
     ON CONFLICT (cognito_sub) DO NOTHING`,
    [
      // cognito_sub is the phone for phone-auth pool until we resolve the real sub.
      // We'll refresh this after the AuthResult returns tokens (in handleAwaitingOtp).
      whatsappNumber,
      whatsappNumber,
    ],
  );

  // InitiateAuth with CUSTOM_AUTH — triggers DefineAuthChallenge → CreateAuthChallenge.
  // CreateAuthChallenge sends the 6-digit OTP via Twilio SMS and returns a
  // Cognito Session containing challengeMetadata. We PERSIST that Session on
  // the conversation row and reuse it in handleAwaitingOtp (Fix 1, 2026-04-17)
  // so subsequent webhook deliveries don't trigger fresh Twilio sends that
  // would invalidate the code the worker actually received.
  const init = await cognito.send(new InitiateAuthCommand({
    AuthFlow: AuthFlowType.CUSTOM_AUTH,
    ClientId: clientId,
    AuthParameters: {
      USERNAME: whatsappNumber,
    },
  }));

  // Atomic state transition: advance state AND record the MessageSid in one
  // UPDATE, so an SQS retry can never reach routeMessage after state has
  // advanced but before the SID is stamped.
  await updateConversation(client, conv.id, {
    language: lang,
    conversation_state: 'awaiting_otp',
    state_context: {
      cognito_session: init.Session,
      otp_issued_at: new Date().toISOString(),
    },
    otp_attempts: 0,
    otp_expires_at: new Date(Date.now() + 10 * 60 * 1000), // 10-min TTL
    last_processed_message_sid: msg.messageSid,
  });

  await reply(
    client,
    msg,
    isNewUser ? 'welcome_new_user' : 'welcome_existing_user',
    lang,
  );
}

// ── awaiting_otp — RespondToAuthChallenge (Fix 1 + Fix 2, 2026-04-17) ──
//
// The previous implementation called a fresh InitiateAuth before every
// RespondToAuthChallenge, which triggered CreateAuthChallenge → Twilio SMS
// of a NEW 6-digit code → the worker's submitted code was validated against
// a code they never received. Codex catch.
//
// Fix:
//   - Persist the Cognito Session returned by the initial InitiateAuth into
//     state_context.cognito_session (done in handleNewOrRestart).
//   - Reuse that Session here (no fresh InitiateAuth).
//   - On wrong OTP: Cognito re-issues a CUSTOM_CHALLENGE with a new Session;
//     persist it. create-auth-challenge's reuse branch preserves the same
//     OTP (no new SMS) as long as `challengeMetadata` is on the session.
//   - On "Invalid session"/expired session: call fresh InitiateAuth once,
//     store the new Session, reply `otp_expired_retry` — NOT a counted
//     attempt.
//   - On success: decode the real Cognito `sub` from the ID token and
//     reconcile the users row (see reconcileUserRow).

async function handleAwaitingOtp(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const otp = msg.body.trim();
  const clientId = process.env.WORKER_CLIENT_ID;
  if (!clientId) throw new Error('WORKER_CLIENT_ID not set');

  // Local 10-minute TTL (separate from Cognito's 3-min session TTL). If this
  // fires, send worker back to `new` — they restart onboarding.
  if (conv.otp_expires_at && conv.otp_expires_at.getTime() < Date.now()) {
    await updateConversation(client, conv.id, {
      conversation_state: 'new',
      state_context: {},
      last_processed_message_sid: msg.messageSid,
    });
    await reply(client, msg,'otp_expired', conv.language);
    return;
  }

  const session = conv.state_context?.cognito_session;
  if (!session) {
    // No Session persisted — shouldn't happen in the normal state machine
    // (handleNewOrRestart always writes one), but if a pre-Fix-1 conversation
    // row is still in `awaiting_otp` we fall through to re-issue.
    await reissueOtp(client, conv, msg, clientId, 'missing_session');
    return;
  }

  let resp;
  try {
    resp = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: ChallengeNameType.CUSTOM_CHALLENGE,
      Session: session,
      ChallengeResponses: {
        USERNAME: conv.whatsapp_number,
        ANSWER: otp,
      },
    }));
  } catch (err: any) {
    const name: string = err?.name ?? '';
    const detail: string = err?.message ?? '';
    // Expired Cognito session → re-issue with fresh InitiateAuth. NOT a
    // counted attempt. Cognito's exact error text for an expired session
    // tends to include the word "session"; match broadly.
    if (name === 'NotAuthorizedException' && /session/i.test(detail)) {
      await reissueOtp(client, conv, msg, clientId, 'expired_session');
      return;
    }
    // Other NotAuthorizedException (e.g. Cognito's own max-retries fail) →
    // treat as wrong code, no new Session to store.
    await recordWrongOtp(client, conv, msg, undefined);
    return;
  }

  // Cognito returned normally. Two shapes:
  //   - AuthenticationResult present → OTP correct
  //   - ChallengeName present + no AuthenticationResult → OTP wrong; Cognito
  //     has re-issued a CUSTOM_CHALLENGE and the new Session carries forward
  //     the same challengeMetadata (→ create-auth-challenge reuses the OTP,
  //     no new SMS).
  if (!resp.AuthenticationResult?.IdToken) {
    await recordWrongOtp(client, conv, msg, resp.Session);
    return;
  }

  // OTP correct. Resolve the real Cognito sub from the ID token (Fix 2).
  const idToken = resp.AuthenticationResult.IdToken;
  const realSub = decodeIdTokenSub(idToken);

  // Reconcile the users row: either promote the placeholder (Case A) or
  // link WhatsApp to an existing real-sub row and delete the orphan
  // placeholder (Case B/C).
  const { userId, tosVersion } = await reconcileUserRow(
    client,
    realSub,
    conv.whatsapp_number,
  );

  const requiredVersion = process.env.REQUIRED_TOS_VERSION ?? '1.0';

  if (tosVersion !== requiredVersion) {
    // Advance to awaiting_legal. Clear the cognito_session (OTP flow is done).
    await updateConversation(client, conv.id, {
      user_id: userId,
      conversation_state: 'awaiting_legal',
      state_context: {},
      last_processed_message_sid: msg.messageSid,
    });
    // Mutate in-memory so any downstream helper that reads conv.user_id gets
    // the right value. (Post-route stamp also needs `conv`; staying safe.)
    conv.user_id = userId;
    await reply(client, msg,'legal_prompt', conv.language, {
      tos_url: 'https://jale.app/legal/tos',
    });
  } else {
    // Already compliant — jump to profile builder or idle depending on profile completeness.
    await updateConversation(client, conv.id, {
      user_id: userId,
      state_context: {},
      last_processed_message_sid: msg.messageSid,
    });
    conv.user_id = userId;
    await enterProfileBuilderOrIdle(client, conv, userId, msg.from, msg.messageSid);
  }
}

/**
 * Record a wrong-OTP attempt. If newSession is provided (from Cognito's
 * retry-challenge response), persist it so the next RespondToAuthChallenge
 * uses it (create-auth-challenge reuses the same OTP — no new SMS). Three
 * attempts → otp_timeout.
 */
async function recordWrongOtp(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  newSession: string | undefined,
): Promise<void> {
  const newAttempts = conv.otp_attempts + 1;
  if (newAttempts >= 3) {
    await updateConversation(client, conv.id, {
      conversation_state: 'otp_timeout',
      otp_attempts: newAttempts,
      state_context: {},
      last_processed_message_sid: msg.messageSid,
    });
    await reply(client, msg,'otp_timeout', conv.language);
    return;
  }
  const nextSession = newSession ?? conv.state_context?.cognito_session;
  await updateConversation(client, conv.id, {
    otp_attempts: newAttempts,
    state_context: {
      ...conv.state_context,
      cognito_session: nextSession,
    },
    last_processed_message_sid: msg.messageSid,
  });
  await reply(client, msg,'otp_retry', conv.language);
}

/**
 * Cognito session expired or missing. Fire a fresh InitiateAuth (which
 * triggers CreateAuthChallenge → new Twilio SMS), persist the new Session,
 * reply `otp_expired_retry`. Does NOT increment otp_attempts.
 */
async function reissueOtp(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  clientId: string,
  reason: 'missing_session' | 'expired_session',
): Promise<void> {
  console.log('[processor] reissuing OTP', {
    reason,
    whatsappNumber: conv.whatsapp_number,
  });
  const init = await cognito.send(new InitiateAuthCommand({
    AuthFlow: AuthFlowType.CUSTOM_AUTH,
    ClientId: clientId,
    AuthParameters: { USERNAME: conv.whatsapp_number },
  }));
  await updateConversation(client, conv.id, {
    state_context: {
      ...conv.state_context,
      cognito_session: init.Session,
      otp_issued_at: new Date().toISOString(),
    },
    // Reset the local TTL — the worker just got a fresh code.
    otp_expires_at: new Date(Date.now() + 10 * 60 * 1000),
    last_processed_message_sid: msg.messageSid,
  });
  await reply(client, msg,'otp_expired_retry', conv.language);
}

/**
 * Promote the placeholder users row (Case A) OR link WhatsApp to an existing
 * real-sub row and delete the orphan placeholder (Case B/C). Wrapped in a
 * BEGIN/COMMIT so the reconcile is atomic and never leaves two rows.
 *
 * Returns the surviving user's id and tos_version.
 */
async function reconcileUserRow(
  client: PoolClient,
  realSub: string,
  whatsappNumber: string,
): Promise<{ userId: string; tosVersion: string | null }> {
  // Runs inside processRecord's outer transaction (Fix Plan v3): no inner
  // BEGIN/COMMIT. Any throw here propagates up and the outer tx ROLLBACKs
  // everything, including the whatsapp_processed_messages claim.

  // Does a real-sub row already exist? (Worker may have signed up via web
  // before messaging us on WhatsApp.) `cognito_sub` is UNIQUE, so we cannot
  // UPDATE the placeholder to `realSub` without first checking.
  const existing = await client.query<{ id: string; tos_version: string | null }>(
    `SELECT id, tos_version FROM users
      WHERE cognito_sub = $1 AND user_type = 'worker'`,
    [realSub],
  );

  if ((existing.rowCount ?? 0) > 0) {
    // Case B/C: real-sub row exists. Link WhatsApp to it.
    await client.query(
      `UPDATE users
          SET whatsapp_number = $1,
              whatsapp_linked_at = now()
        WHERE cognito_sub = $2 AND user_type = 'worker'`,
      [whatsappNumber, realSub],
    );
    // ABORT guard (Fix 3, 2026-04-17): before DELETEing the placeholder,
    // verify it has no dependent rows in legal_consent_log or
    // job_applications. Greenfield deploys should never trip this; it
    // exists as defense-in-depth in case a pre-Fix-2 placeholder
    // accumulated data. If tripped: throw → outer tx ROLLBACK → SQS DLQ →
    // operator reconciliation. FK `ON DELETE RESTRICT` on both tables
    // (migration 006 §B) is the DB-side safety net below this check.
    const deps = await client.query<{ has_deps: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM legal_consent_log
            WHERE user_id = (
              SELECT id FROM users
               WHERE cognito_sub = $1 AND user_type = 'worker'
            )
         )
         OR
         EXISTS (
           SELECT 1 FROM job_applications
            WHERE user_id = (
              SELECT id FROM users
               WHERE cognito_sub = $1 AND user_type = 'worker'
            )
         )
         AS has_deps`,
      [whatsappNumber],
    );
    if (deps.rows[0]?.has_deps) {
      throw new Error(
        `reconcileUserRow: placeholder for ${whatsappNumber} has dependent legal_consent_log or job_applications rows; aborting reconcile — manual ops merge required`,
      );
    }
    // Case B: remove the orphan placeholder. The RLS policy
    // `wa_users_delete_placeholder` filters by
    //   (user_type = 'worker' AND cognito_sub = phone AND whatsapp_number IS NULL)
    // so a freshly-linked row is immune.
    await client.query(
      `DELETE FROM users
        WHERE cognito_sub = $1
          AND user_type = 'worker'
          AND cognito_sub <> $2`,
      [whatsappNumber, realSub],
    );
    return {
      userId: existing.rows[0].id,
      tosVersion: existing.rows[0].tos_version,
    };
  }

  // Case A: no real-sub row yet. Promote the placeholder in place.
  const promoted = await client.query<{ id: string; tos_version: string | null }>(
    `UPDATE users
        SET cognito_sub = $1,
            whatsapp_number = $2,
            whatsapp_linked_at = now()
      WHERE cognito_sub = $2 AND user_type = 'worker'
      RETURNING id, tos_version`,
    [realSub, whatsappNumber],
  );
  if ((promoted.rowCount ?? 0) === 0) {
    throw new Error(
      `reconcileUserRow: neither real-sub row nor placeholder found for ${whatsappNumber}`,
    );
  }
  return {
    userId: promoted.rows[0].id,
    tosVersion: promoted.rows[0].tos_version,
  };
}

// ── awaiting_legal — record consent via setRlsContext (no jale_consent role) ──
async function handleAwaitingLegal(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  if (isDecline(msg.body, conv.language)) {
    await updateConversation(client, conv.id, {
      conversation_state: 'legal_declined',
      last_processed_message_sid: msg.messageSid,
    });
    await reply(client, msg,'legal_declined', conv.language);
    return;
  }

  if (!isAccept(msg.body, conv.language)) {
    // Re-prompt with legal message (no state change; post-route stamp covers
    // idempotency)
    await reply(client, msg,'legal_prompt', conv.language, {
      tos_url: 'https://jale.app/legal/tos',
    });
    return;
  }

  // Accept: do the consent transaction using setRlsContext (same as accept-tos.ts).
  // jale_whatsapp has UPDATE grants on tos/privacy columns directly (no jale_consent role).
  if (!conv.user_id) throw new Error('user_id missing on awaiting_legal');
  const userRow = await client.query<{ cognito_sub: string }>(
    `SELECT cognito_sub FROM users WHERE id = $1`,
    [conv.user_id],
  );
  if (userRow.rowCount === 0) throw new Error('user missing at consent time');
  const cognitoSub = userRow.rows[0].cognito_sub;
  const requiredVersion = process.env.REQUIRED_TOS_VERSION ?? '1.0';

  // Consent transaction (Fix Plan v3): runs inside processRecord's outer tx.
  // No inner BEGIN/COMMIT; any throw propagates up and the outer tx rolls
  // back the entire message including the claim.
  // `setRlsContext` uses `set_config('app.current_user_id', $1, true)` —
  // its scope is the current tx, which is processRecord's outer tx here.
  await setRlsContext(client, cognitoSub);
  const upd = await client.query(
    `UPDATE users
        SET tos_version = $1, tos_accepted_at = now(),
            privacy_version = $1, privacy_accepted_at = now()
      WHERE cognito_sub = $2 AND tos_version IS DISTINCT FROM $1`,
    [requiredVersion, cognitoSub],
  );
  if (upd.rowCount && upd.rowCount > 0) {
    await client.query(
      `INSERT INTO legal_consent_log
          (user_id, document_type, document_version, ip_address, user_agent)
       SELECT id, 'tos', $1, NULL, 'whatsapp' FROM users WHERE cognito_sub = $2`,
      [requiredVersion, cognitoSub],
    );
    await client.query(
      `INSERT INTO legal_consent_log
          (user_id, document_type, document_version, ip_address, user_agent)
       SELECT id, 'privacy', $1, NULL, 'whatsapp' FROM users WHERE cognito_sub = $2`,
      [requiredVersion, cognitoSub],
    );
  }

  // Proceed to profile builder
  await enterProfileBuilderOrIdle(client, conv, conv.user_id, msg.from, msg.messageSid);
}

// ── Transition helper: enter building_profile OR skip to idle ───
async function enterProfileBuilderOrIdle(
  client: PoolClient,
  conv: ConversationRow,
  userId: string,
  from: string,
  messageSid: string,
): Promise<void> {
  const dbFilled = await loadProfileFromDb(client, userId);
  const next = computeNextField({}, dbFilled);
  if (next === null) {
    // Fully filled — skip the builder
    await updateConversation(client, conv.id, {
      conversation_state: 'idle',
      state_context: {},
      last_processed_message_sid: messageSid,
    });
    await queueReply(client, messageSid, from, 'idle_help', conv.language);
    return;
  }
  await updateConversation(client, conv.id, {
    conversation_state: 'building_profile',
    state_context: { pending_field: next, collected: {}, field_sids: {} },
    last_processed_message_sid: messageSid,
  });
  await queueReply(client, messageSid, from, 'legal_accepted', conv.language);
  await askProfileQuestion(client, messageSid, from, next, conv.language);
}

async function loadProfileFromDb(
  client: PoolClient,
  userId: string,
): Promise<Partial<Record<ProfileField, string | boolean | null>>> {
  const r = await client.query(
    `SELECT full_name, city, main_trade, main_trade_other,
            years_experience, has_transportation, availability
       FROM users WHERE id = $1`,
    [userId],
  );
  return (r.rows[0] ?? {}) as Partial<Record<ProfileField, string | boolean | null>>;
}

// Mapping from ProfileField → question template key
const FIELD_PROMPT_KEY: Record<ProfileField, TemplateKey> = {
  full_name: 'ask_name',
  city: 'ask_city',
  main_trade: 'ask_trade',
  main_trade_other: 'ask_trade_freetext',
  years_experience: 'ask_experience',
  has_transportation: 'ask_transportation',
  availability: 'ask_availability',
};

async function askProfileQuestion(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  field: ProfileField,
  lang: Lang,
): Promise<void> {
  await queueReply(client, inboundMessageSid, to, FIELD_PROMPT_KEY[field], lang);
}

// ── building_profile — pending-field model (Fix 3, 2026-04-17) ──
//
// Replay protection runs at the top of processRecord (`isDuplicateSid` scans
// both `last_processed_message_sid` and `state_context.field_sids`), so any
// duplicate MessageSid has already been rejected before we get here. No
// in-handler stale-replay guard is needed, and the old field-ordering-based
// `isStaleReplay` has been removed from flows.ts — it could never detect
// out-of-order retries since its call site passed `pending` twice.
//
// When a valid answer is accepted we bind that answer to the inbound
// MessageSid via state_context.field_sids. Subsequent retries of the same
// SID — even after the pending_field has advanced — will match on the
// field_sids scan and short-circuit.
async function handleBuildingProfile(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  // "Jobs"/"Trabajos" during profile: block and re-prompt current question
  // (no state change; post-route stamp records the sid).
  if (isJobsKeyword(msg.body)) {
    const currentQ = conv.state_context?.pending_field
      ? t(FIELD_PROMPT_KEY[conv.state_context.pending_field], conv.language)
      : '';
    await reply(client, msg,'profile_jobs_blocked', conv.language, { question: currentQ });
    return;
  }

  const pending = conv.state_context?.pending_field;
  if (!pending) {
    // No pending field but we're still in building_profile — recompute from DB.
    if (!conv.user_id) throw new Error('user_id missing in building_profile');
    const dbFilled = await loadProfileFromDb(client, conv.user_id);
    const next = computeNextField(conv.state_context?.collected ?? {}, dbFilled);
    if (next === null) {
      await flushProfileAndAdvance(client, conv, msg.from, msg.messageSid);
      return;
    }
    await updateConversation(client, conv.id, {
      state_context: {
        ...conv.state_context,
        pending_field: next,
      },
      last_processed_message_sid: msg.messageSid,
    });
    await askProfileQuestion(client, msg.messageSid, msg.from, next, conv.language);
    return;
  }

  const collected = conv.state_context?.collected ?? {};
  const fieldSids = conv.state_context?.field_sids ?? {};

  const answer = parseProfileAnswer(pending, msg.body);
  if (answer === null) {
    // Invalid answer: re-prompt current question. No state change; post-route
    // stamp records the sid so an SQS retry of this same wrong answer won't
    // re-prompt the worker again.
    await reply(client, msg,'profile_reprompt', conv.language, {
      question: t(FIELD_PROMPT_KEY[pending], conv.language),
    });
    return;
  }

  // Bind this field's accepted answer to the MessageSid that produced it.
  // The isDuplicateSid() check at processRecord's top uses field_sids to
  // reject out-of-order retries.
  const newCollected = { ...collected, [pending]: answer };
  const newFieldSids = { ...fieldSids, [pending]: msg.messageSid };

  if (!conv.user_id) throw new Error('user_id missing');
  const dbFilled = await loadProfileFromDb(client, conv.user_id);
  const next = computeNextField(newCollected, dbFilled);

  if (next === null) {
    // Done — flush to DB and advance to idle. flushProfileAndAdvance owns
    // the final state transition (including the sid stamp).
    await flushProfileAndAdvance(
      client,
      conv,
      msg.from,
      msg.messageSid,
      newCollected,
    );
    return;
  }

  await updateConversation(client, conv.id, {
    state_context: {
      pending_field: next,
      collected: newCollected,
      field_sids: newFieldSids,
    },
    last_processed_message_sid: msg.messageSid,
  });
  await askProfileQuestion(client, msg.messageSid, msg.from, next, conv.language);
}

async function flushProfileAndAdvance(
  client: PoolClient,
  conv: ConversationRow,
  from: string,
  messageSid: string,
  collected?: Partial<Record<ProfileField, string | boolean>>,
): Promise<void> {
  const data = collected ?? conv.state_context?.collected ?? {};
  if (!conv.user_id) throw new Error('user_id missing at flush');

  // Build dynamic UPDATE — only set fields that were collected this session
  const fields: ProfileField[] = [
    'full_name', 'city', 'main_trade', 'main_trade_other',
    'years_experience', 'has_transportation', 'availability',
  ];
  const setFields = fields.filter((f) => data[f] !== undefined);
  if (setFields.length > 0) {
    const sets = setFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const vals = setFields.map((f) => data[f] as string | boolean);
    await client.query(
      `UPDATE users SET ${sets} WHERE id = $1 AND user_type = 'worker'`,
      [conv.user_id, ...vals],
    );
  }

  // Final state transition — atomic with the sid stamp. state_context is
  // cleared on entry to `idle` (cognito_session, field_sids, etc. are
  // profile-builder-scoped and have no meaning in `idle`).
  await updateConversation(client, conv.id, {
    conversation_state: 'idle',
    state_context: {},
    last_processed_message_sid: messageSid,
  });
  await queueReply(client, messageSid, from, 'profile_complete', conv.language);
}

// ── idle — handle Jobs keyword + button callbacks ───────────────
async function handleIdle(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  if (isJobsKeyword(msg.body)) {
    // Query the jobs table, send matching jobs. For V1, return a simple list.
    const jobs = await client.query<{
      id: string; title: string; company: string; location: string; pay: string;
    }>(`SELECT id, title, company, location, pay FROM jobs ORDER BY created_at DESC LIMIT 5`);
    if (jobs.rowCount === 0) {
      await reply(client, msg,'jobs_none', conv.language);
      return;
    }
    // V1: send a single summary message. Template button replies come in Phase 6.
    const lines = jobs.rows.map(
      (j) =>
        conv.language === 'es'
          ? `• ${j.title} en ${j.company}, ${j.location} — ${j.pay}`
          : `• ${j.title} at ${j.company}, ${j.location} — ${j.pay}`,
    );
    await queueText(client, msg.messageSid, msg.from, lines.join('\n'));
    return;
  }

  await reply(client, msg,'idle_help', conv.language);
}

async function handleJobButton(
  client: PoolClient,
  conv: ConversationRow,
  payload: { action: 'accept' | 'decline' | 'info'; jobId: string },
  from: string,
  inboundMessageSid: string,
): Promise<void> {
  // jobId is "job-<uuid>"; strip the prefix to get the bare UUID
  const bareJobId = payload.jobId.replace(/^job-/, '');

  const job = await client.query<{
    id: string; title: string; company: string;
    location: string; pay: string;
  }>(`SELECT id, title, company, location, pay FROM jobs WHERE id = $1`, [bareJobId]);
  if (job.rowCount === 0) {
    await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    return;
  }
  if (!conv.user_id) {
    // Button tap from an unlinked conversation — shouldn't happen, but treat as error
    await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    return;
  }

  if (payload.action === 'accept') {
    // Real job application insert. ON CONFLICT DO NOTHING handles double-taps
    // and SQS replays idempotently — the (job_id, user_id) unique constraint
    // from 005_job_applications.sql enforces one application per (job, worker).
    await client.query(
      `INSERT INTO job_applications (job_id, user_id, status)
       VALUES ($1, $2, 'submitted')
       ON CONFLICT (job_id, user_id) DO NOTHING`,
      [bareJobId, conv.user_id],
    );
    await queueReply(client, inboundMessageSid, from, 'job_accepted', conv.language);
  } else if (payload.action === 'decline') {
    // No DB write for decline in V1 — just acknowledge. Future: log for
    // recommendation tuning in a whatsapp_job_declines table.
    await queueReply(client, inboundMessageSid, from, 'job_declined', conv.language);
  } else {
    // info — V1 sends a richer detail message with the same Accept/Decline
    // buttons. In Phase 6 we can send a second template with all 5 vars;
    // for the processor path (where this tap arrives as a button callback),
    // the simplest move is a detail summary in the user's language.
    const r = job.rows[0];
    await queueText(client, inboundMessageSid, from,
      conv.language === 'es'
        ? `📋 ${r.title} en ${r.company}\n📍 ${r.location}\n💰 ${r.pay}`
        : `📋 ${r.title} at ${r.company}\n📍 ${r.location}\n💰 ${r.pay}`,
    );
  }
}
