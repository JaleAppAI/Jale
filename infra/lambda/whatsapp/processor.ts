import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
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
import {
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import { applyWorkerToJob } from '../lib/applications';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../lib/db';
import { listMatchedJobsForWorker } from '../lib/job-matching';
import {
  declineLatestWorkerConversationFromButtonText,
  declineWorkerConversationFromButton,
  openLatestWorkerConversationFromButtonText,
  openWorkerConversationFromButton,
  recordWorkerConversationReply,
  sendPendingJobMessageOutbox,
} from '../lib/job-messaging';
import { parseFormBody, type TwilioSecret } from './lib/twilio';
import { sendPendingOutbox, queueOutboxText } from './lib/outbox';
import {
  isLikelyOtpCode,
  resolveWorkerIdForWhatsappNumber,
  parseEmployerConversationTextAction,
  handleEmployerConversationButton,
  handleEmployerConversationTextAction,
  routeEmployerConversationReplyOverride,
  parseDisambiguationPick,
  handleDisambiguationPick,
  type ConversationRow,
  type IncomingMessage,
  type RouterDeps,
} from './lib/conversation-router';
import {
  t,
  detectLanguage,
  type Lang,
  type TemplateKey,
} from './lib/templates';
import {
  FIELD_PROMPT_KEY,
  loadProfileFromDb,
  loadTradeFromDb,
  profileQuestionBody,
  trustSignalColumnsAvailable,
  upsertWorkerProfileFromUsers,
} from './lib/profile-flow';
import {
  buildLegalInteractivePrompt,
  buildMediaInteractivePrompt,
  buildProfileInteractivePrompt,
  buildTrustInteractivePrompt,
  type InteractivePrompt,
} from './lib/interactive-templates';
import {
  isGreetingKeyword,
  isJobsKeyword,
  isHelpCommand,
  isProfileCommand,
  isSkipKeyword,
  isAccept,
  isDecline,
  parseButtonPayload,
  parseEmployerConversationButtonPayload,
  parseLegalReplyPayload,
  parseMediaPayload,
  parseProfilePayloadAnswer,
  parseTrustPayloadAnswer,
  parseTypedJobAction,
  parseProfileAnswer,
  parseTrustAnswer,
  buildTrustQuestion,
  computeNextField,
  TRUST_STEPS,
  type ConversationState,
  type ProfileField,
  type ProfileStateContext,
  type TrustAnswer,
} from './lib/flows';
import {
  detectMediaCategory,
  buildS3Key,
  downloadTwilioMedia,
  uploadMediaToS3,
} from './lib/media';
import { decodeIdTokenSub } from './lib/jwt';
import { handleBuildingCustomTrust } from './handlers/custom-trust';

// ── Module-level AWS clients ────────────────────────────────────
const cognito = new CognitoIdentityProviderClient({});
const secretsManager = new SecretsManagerClient({});
const sfn = new SFNClient({});

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
  await queueOutboxText(client, inboundMessageSid, to, body);
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

async function queueJobTemplate(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  lang: Lang,
  job: { id: string; title: string; company: string; location: string; pay: string },
): Promise<void> {
  const whatsappNumber = to.replace(/^whatsapp:/, '');
  const templateName = lang === 'en' ? 'job_alert_en' : 'job_alert_es';
  const variables = {
    '1': job.title,
    '2': job.company,
    '3': job.location,
    '4': job.pay,
    '5': `job-${job.id}`,
  };
  await client.query(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, content_template, content_variables)
     VALUES (
       $1::varchar,
       (SELECT COALESCE(MAX(sequence), 0) + 1
          FROM whatsapp_outbox
         WHERE inbound_message_sid = $1::varchar),
       $2, $3, $4
     )`,
    [inboundMessageSid, whatsappNumber, templateName, variables],
  );
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

async function queueInteractivePrompt(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  prompt: InteractivePrompt,
): Promise<void> {
  const whatsappNumber = to.replace(/^whatsapp:/, '');
  await client.query(
    `INSERT INTO whatsapp_outbox
        (inbound_message_sid, sequence, whatsapp_number, content_template, content_variables)
     VALUES (
       $1::varchar,
       (SELECT COALESCE(MAX(sequence), 0) + 1
          FROM whatsapp_outbox
         WHERE inbound_message_sid = $1::varchar),
       $2, $3, $4
     )`,
    [
      inboundMessageSid,
      whatsappNumber,
      prompt.templateName,
      {
        ...prompt.variables,
        __fallback_body: prompt.fallbackBody,
      },
    ],
  );
}

async function queueLegalPrompt(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  lang: Lang,
): Promise<void> {
  await queueInteractivePrompt(
    client,
    inboundMessageSid,
    to,
    buildLegalInteractivePrompt(lang, 'https://jale.app/legal/tos'),
  );
}

async function queueMediaPrompt(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  lang: Lang,
  prompt: Parameters<typeof buildMediaInteractivePrompt>[0],
): Promise<void> {
  await queueInteractivePrompt(
    client,
    inboundMessageSid,
    to,
    buildMediaInteractivePrompt(prompt, lang),
  );
}

async function queueTrustPrompt(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  step: number,
  trade: string,
  lang: Lang,
): Promise<void> {
  await queueInteractivePrompt(
    client,
    inboundMessageSid,
    to,
    buildTrustInteractivePrompt(step, trade, lang),
  );
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
            otp_expires_at, last_processed_message_sid,
            focused_job_conversation_id
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
               otp_expires_at, last_processed_message_sid,
               focused_job_conversation_id`,
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
async function tableColumnExists(
  client: PoolClient,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = $1
          AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return r.rows[0]?.exists === true;
}

async function hasPlaceholderDependents(
  client: PoolClient,
  placeholderUserId: string,
): Promise<boolean> {
  // Placeholder rows may not be deleted if any audit/application rows already
  // reference them.
  if (await tableColumnExists(client, 'legal_consent_log', 'user_id')) {
    const legalDeps = await client.query<{ has_deps: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM legal_consent_log WHERE user_id = $1
       ) AS has_deps`,
      [placeholderUserId],
    );
    if (legalDeps.rows[0]?.has_deps) return true;
  }

  if (await tableColumnExists(client, 'job_applications', 'worker_id')) {
    const jobDeps = await client.query<{ has_deps: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM job_applications WHERE worker_id = $1
       ) AS has_deps`,
      [placeholderUserId],
    );
    if (jobDeps.rows[0]?.has_deps) return true;
  }

  return false;
}

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
  // WhatsApp List Picker rows can arrive with their response value in Body
  // rather than ButtonPayload/InteractiveData/ChannelMetadata. The 256-char
  // cap bounds findKnownPayload's work on hostile inputs; real Twilio
  // payloads are well under 50 chars.
  const interactivePayload =
    buttonPayload
    ?? extractInteractivePayload(params.InteractiveData)
    ?? extractInteractivePayload(params.ChannelMetadata)
    ?? (body.length <= 256 ? findKnownPayload(body) : undefined);
  const interactivePayloadSource: 'button' | 'interactive_data' | 'channel_metadata' | 'body' | 'none' =
    buttonPayload ? 'button'
    : extractInteractivePayload(params.InteractiveData) ? 'interactive_data'
    : extractInteractivePayload(params.ChannelMetadata) ? 'channel_metadata'
    : (body.length <= 256 && findKnownPayload(body)) ? 'body'
    : 'none';
  const numMedia = parseInt(params.NumMedia ?? '0', 10);
  const mediaUrl = params.MediaUrl0;
  const mediaSid = params.MediaSid0;
  const mediaContentType = params.MediaContentType0;

  if (!from || !messageSid) {
    console.warn('[processor] skipping: missing From/MessageSid', { messageSid, from });
    return;
  }

  const whatsappNumber = from.replace(/^whatsapp:/, '');
  const defaultLang = detectLanguage(body);

  const pool = await getDbPool();
  const client = await pool.connect();
  let jobOutboxActorUserId: string | null = null;
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
          const actor = await client.query<{ user_id: string | null }>(
            `SELECT user_id FROM whatsapp_conversations WHERE whatsapp_number = $1`,
            [whatsappNumber],
          );
          const actorUserId = actor.rows[0]?.user_id;
          if (actorUserId) {
            await sendPendingJobMessageOutbox(client, { actorUserId });
          }
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

      console.log('[processor] payload source', {
        messageSid,
        interactivePayloadSource,
        hasInteractivePayload: !!interactivePayload,
      });

      const routedWorkerId = await routeMessage(client, conv, {
        body,
        buttonPayload,
        interactivePayload,
        messageSid,
        from,
        numMedia,
        mediaUrl,
        mediaSid,
        mediaContentType,
      });
      jobOutboxActorUserId = routedWorkerId ?? jobOutboxActorUserId;

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
    if (jobOutboxActorUserId) {
      await sendPendingJobMessageOutbox(client, { actorUserId: jobOutboxActorUserId });
    }
    await markCompleted(client, messageSid);
  } finally {
    client.release();
  }
}

// ── State router ────────────────────────────────────────────────
function extractInteractivePayload(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return findKnownPayload(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function findKnownPayload(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return /^(legal|profile|trust|media|conversation):/.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKnownPayload(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findKnownPayload(nested);
      if (found) return found;
    }
  }
  return undefined;
}

async function setWorkerRlsContextByUserId(
  client: PoolClient,
  userId: string,
): Promise<void> {
  const userRow = await client.query<{ cognito_sub: string }>(
    `SELECT cognito_sub FROM users WHERE id = $1 AND user_type = 'worker'`,
    [userId],
  );
  const cognitoSub = userRow.rows[0]?.cognito_sub;
  if (!cognitoSub) throw new Error('worker cognito_sub missing before media write');
  await setRlsContext(client, cognitoSub);
}

// ── awaiting_media_photo — optional photo upload step ───────────
async function handleAwaitingMediaPhoto(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const { numMedia, mediaUrl, mediaSid, mediaContentType, from, messageSid } = msg;
  const mediaPayload = parseMediaPayload(msg.interactivePayload);

  // If a photo was already received, we are waiting for the classification reply (1 or 2).
  const pendingPhotoId = conv.state_context?.pending_media_photo_id;
  if (pendingPhotoId) {
    if (!conv.user_id) throw new Error('user_id missing before media write');
    await setWorkerRlsContextByUserId(client, conv.user_id);

    const bodyTrimmed = msg.body.trim();
    if (
      mediaPayload?.kind === 'photo_type'
      && mediaPayload.value === 'profile_photo'
    ) {
      await client.query(
        `UPDATE worker_profile_media SET media_type = 'profile_photo' WHERE id = $1`,
        [pendingPhotoId],
      );
    } else if (
      mediaPayload?.kind === 'photo_type'
      && mediaPayload.value === 'work_sample'
    ) {
      await client.query(
        `UPDATE worker_profile_media SET media_type = 'work_sample' WHERE id = $1`,
        [pendingPhotoId],
      );
    } else if (bodyTrimmed === '1' || /^profile/i.test(bodyTrimmed)) {
      await client.query(
        `UPDATE worker_profile_media SET media_type = 'profile_photo' WHERE id = $1`,
        [pendingPhotoId],
      );
    } else if (bodyTrimmed === '2' || /^work/i.test(bodyTrimmed)) {
      await client.query(
        `UPDATE worker_profile_media SET media_type = 'work_sample' WHERE id = $1`,
        [pendingPhotoId],
      );
    } else {
      // Invalid classification response — re-prompt
      await queueMediaPrompt(client, messageSid, from, conv.language, 'photo_type');
      return;
    }
    if (conv.state_context?.profile_completed === true) {
      await updateConversation(client, conv.id, {
        state_context: {},
        conversation_state: 'idle',
        last_processed_message_sid: messageSid,
      });
      return;
    }

    // Classification done during early media flow — advance to voice step
    await updateConversation(client, conv.id, {
      state_context: { ...conv.state_context, pending_media_photo_id: undefined },
      conversation_state: 'awaiting_media_voice',
      last_processed_message_sid: messageSid,
    });
    await queueMediaPrompt(client, messageSid, from, conv.language, 'voice_choice');
    return;
  }

  // Worker skipped or sent text (no photo yet) — proceed to voice step
  if (mediaPayload?.kind === 'photo' || numMedia === 0 || isSkipKeyword(msg.body)) {
    if (conv.state_context?.profile_completed === true) {
      await updateConversation(client, conv.id, {
        conversation_state: 'idle',
        state_context: {},
        last_processed_message_sid: messageSid,
      });
      return;
    }

    await updateConversation(client, conv.id, {
      conversation_state: 'awaiting_media_voice',
      last_processed_message_sid: messageSid,
    });
    await queueMediaPrompt(client, messageSid, from, conv.language, 'voice_choice');
    return;
  }

  if (!mediaUrl || !mediaContentType) {
    await queueReply(client, messageSid, from, 'media_photo_invalid', conv.language);
    return;
  }

  const category = detectMediaCategory(mediaContentType);
  if (category !== 'photo') {
    await queueReply(client, messageSid, from, 'media_photo_invalid', conv.language);
    return;
  }

  // Download from Twilio and upload to S3
  const twilioSecret = await getTwilioSecret();
  const mediaBuffer = await downloadTwilioMedia(mediaUrl, twilioSecret.accountSid, twilioSecret.authToken);

  const mediaId = randomUUID();
  if (!conv.user_id) throw new Error('user_id missing before media write');
  const s3Key = buildS3Key(conv.user_id, mediaId, 'photo');
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');

  await uploadMediaToS3(bucketName, s3Key, mediaBuffer, mediaContentType);
  await setWorkerRlsContextByUserId(client, conv.user_id);

  await client.query(
    `INSERT INTO worker_profile_media
       (id, user_id, media_type, s3_key, twilio_media_sid, content_type)
     VALUES ($1, $2, 'profile_photo', $3, $4, $5)`,
    [mediaId, conv.user_id, s3Key, mediaSid ?? null, mediaContentType],
  );

  await updateConversation(client, conv.id, {
    state_context: {
      ...conv.state_context,
      pending_media_photo_id: mediaId,
    },
    last_processed_message_sid: messageSid,
  });
  await queueMediaPrompt(client, messageSid, from, conv.language, 'photo_type');
}

// ── awaiting_media_voice — optional voice message step ──────────
function wantsVoiceProfile(text: string): boolean {
  return /^(1|voice|voz|audio|nota de voz)$/i.test(text.trim());
}

async function enterTextProfileFromVoiceChoice(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  if (!conv.user_id) throw new Error('user_id missing before text profile');
  const collected = conv.state_context?.collected ?? {};
  const fieldSids = conv.state_context?.field_sids ?? {};
  const dbFilled = await loadProfileFromDb(client, conv.user_id);
  const next = computeNextField(collected, dbFilled);

  if (next === null) {
    await flushProfileAndAdvance(client, conv, msg.from, msg.messageSid);
    return;
  }

  await updateConversation(client, conv.id, {
    conversation_state: 'building_profile',
    state_context: {
      ...conv.state_context,
      collected,
      field_sids: fieldSids,
      pending_field: next,
    },
    last_processed_message_sid: msg.messageSid,
  });
  await askProfileQuestion(client, msg.messageSid, msg.from, next, conv.language);
}

async function handleAwaitingMediaVoice(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const { numMedia, mediaUrl, mediaSid, mediaContentType, from, messageSid } = msg;
  const mediaPayload = parseMediaPayload(msg.interactivePayload);

  // Worker skipped or sent text — go straight to text questions
  if (numMedia === 0) {
    if (mediaPayload?.kind === 'voice' && mediaPayload.value === 'text') {
      await enterTextProfileFromVoiceChoice(client, conv, msg);
      return;
    }
    if (!msg.body.trim() || wantsVoiceProfile(msg.body)) {
      await queueMediaPrompt(client, messageSid, from, conv.language, 'voice_choice');
      return;
    }
    await enterTextProfileFromVoiceChoice(client, conv, msg);
    return;
  }

  if (!mediaUrl || !mediaContentType) {
    await queueReply(client, messageSid, from, 'media_voice_invalid', conv.language);
    return;
  }

  const category = detectMediaCategory(mediaContentType);
  if (category !== 'voice') {
    await queueReply(client, messageSid, from, 'media_voice_invalid', conv.language);
    return;
  }

  const twilioSecret = await getTwilioSecret();
  const mediaBuffer = await downloadTwilioMedia(mediaUrl, twilioSecret.accountSid, twilioSecret.authToken);

  const mediaId = randomUUID();
  if (!conv.user_id) throw new Error('user_id missing before media write');
  const s3Key = buildS3Key(conv.user_id, mediaId, 'voice');
  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const stateMachineArn = process.env.AI_PIPELINE_STATE_MACHINE_ARN;
  if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');
  if (!stateMachineArn) throw new Error('AI_PIPELINE_STATE_MACHINE_ARN not set');

  await uploadMediaToS3(bucketName, s3Key, mediaBuffer, mediaContentType);
  await setWorkerRlsContextByUserId(client, conv.user_id);

  await client.query(
    `INSERT INTO worker_profile_media
       (id, user_id, media_type, s3_key, twilio_media_sid, content_type)
     VALUES ($1, $2, 'voice_message', $3, $4, $5)`,
    [mediaId, conv.user_id, s3Key, mediaSid ?? null, mediaContentType],
  );

  // Language code for Transcribe
  const languageCode = conv.language === 'es' ? 'es-US' : 'en-US';
  const transcriptionJobName = `jale-${conv.user_id.replace(/-/g, '')}-${Date.now()}`;
  const mediaS3Uri = `s3://${bucketName}/${s3Key}`;
  const transcriptOutputKey = `${conv.user_id}/transcripts/${transcriptionJobName}.json`;

  // Start Step Functions execution
  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({
        userId: conv.user_id,
        conversationId: conv.id,
        inboundMessageSid: messageSid,
        whatsappNumber: conv.whatsapp_number,
        language: conv.language,
        mediaBucketName: bucketName,
        transcriptionJobName,
        languageCode,
        mediaS3Uri,
        transcriptOutputKey,
        voiceMessageMediaId: mediaId,
      }),
    }),
  );

  await updateConversation(client, conv.id, {
    conversation_state: 'processing_ai',
    state_context: {
      ...conv.state_context,
      ai_pipeline_execution_arn: execution.executionArn,
    },
    last_processed_message_sid: messageSid,
  });
  await queueReply(client, messageSid, from, 'ai_processing_ack', conv.language);
}

// ── processing_ai — waiting for AI pipeline to complete ─────────
async function handleProcessingAi(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const aiType = conv.state_context?.processing_ai_type;
  if (aiType === 'trust') {
    await queueReply(client, msg.messageSid, msg.from, 'ai_processing_wait', conv.language);
    return;
  }

  // Profile or legacy state transition happens when ai-profile-writer updates the conversation.
  await queueReply(client, msg.messageSid, msg.from, 'ai_processing_wait', conv.language);
}

async function routeMessage(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<string | null> {
  const from = msg.from;

  // Button-payload taps on job alerts are self-identifying. Route them first
  // — they can arrive in any state except onboarding (worker must be linked).
  if (msg.buttonPayload) {
    const conversationPayload = parseEmployerConversationButtonPayload(msg.buttonPayload);
    if (conversationPayload) {
      return await handleEmployerConversationButton(client, conv, msg, conversationPayload, routerDeps);
    }

    const parsed = parseButtonPayload(msg.buttonPayload);
    if (parsed && (conv.conversation_state === 'idle' || conv.user_id)) {
      await handleJobButton(client, conv, parsed, from, msg.messageSid);
      return null;
    }
  }

  if (conv.state_context?.conversation_disambiguation && parseDisambiguationPick(msg.body) !== null) {
    const workerId = conv.user_id ?? await resolveWorkerIdForWhatsappNumber(client, msg.from);
    if (workerId) {
      return await handleDisambiguationPick(client, conv, msg, workerId, routerDeps);
    }
  }

  if (isHelpCommand(msg.body)) {
    await reply(client, msg, 'help_menu', conv.language);
    return null;
  }

  if (isProfileCommand(msg.body)) {
    await handleProfileCommand(client, conv, msg);
    return null;
  }

  const textConversationAction = parseEmployerConversationTextAction(msg.body);
  if (textConversationAction) {
    return await handleEmployerConversationTextAction(client, conv, msg, textConversationAction, routerDeps);
  }

  const routedWorkerId = await routeEmployerConversationReplyOverride(client, conv, msg, routerDeps);
  if (routedWorkerId) {
    return routedWorkerId;
  }

  switch (conv.conversation_state) {
    case 'new':
      if (isGreetingKeyword(msg.body)) {
        await handleNewOrRestart(client, conv, msg);
      } else {
        await reply(client, msg, 'start_prompt', detectLanguage(msg.body));
      }
      return null;

    case 'otp_timeout':
    case 'legal_declined':
      // On re-contact with a greeting, restart onboarding from `new`.
      if (isGreetingKeyword(msg.body)) {
        await handleNewOrRestart(client, conv, msg);
      } else {
        await reply(client, msg, 'start_prompt', conv.language);
      }
      return null;

    case 'awaiting_otp':
      await handleAwaitingOtp(client, conv, msg);
      return null;

    case 'awaiting_legal':
      await handleAwaitingLegal(client, conv, msg);
      return null;

    case 'awaiting_media_photo':
      await handleAwaitingMediaPhoto(client, conv, msg);
      return null;

    case 'awaiting_media_voice':
      await handleAwaitingMediaVoice(client, conv, msg);
      return null;

    case 'processing_ai':
      await handleProcessingAi(client, conv, msg);
      return null;

    case 'building_profile':
      await handleBuildingProfile(client, conv, msg);
      return null;

    case 'building_trust_signal':
      await handleBuildingTrustSignal(client, conv, msg);
      return null;

    case 'building_custom_trust':
      await handleBuildingCustomTrust(client, conv, msg);
      return null;

    case 'idle':
      return await handleIdle(client, conv, msg);
  }

  return null;
}

// Processor-owned mutations injected into the conversation router module.
const routerDeps: RouterDeps = { updateConversation, queueLegalPrompt };

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
  // CreateAuthChallenge sends the 6-digit OTP via Twilio WhatsApp in dev and returns a
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
// RespondToAuthChallenge, which triggered CreateAuthChallenge → Twilio OTP
// of a NEW 6-digit code → the worker's submitted code was validated against
// a code they never received. Codex catch.
//
// Fix:
//   - Persist the Cognito Session returned by the initial InitiateAuth into
//     state_context.cognito_session (done in handleNewOrRestart).
//   - Reuse that Session here (no fresh InitiateAuth).
//   - On wrong OTP: Cognito re-issues a CUSTOM_CHALLENGE with a new Session;
//     persist it. create-auth-challenge's reuse branch preserves the same
  //     OTP (no new outbound message) as long as `challengeMetadata` is on the session.
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
  //     no new outbound message).
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
    await queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
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
 * uses it (create-auth-challenge reuses the same OTP — no new outbound message). Three
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
 * triggers CreateAuthChallenge → new Twilio WhatsApp OTP in dev), persist the new Session,
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
    const placeholder = await client.query<{ id: string }>(
      `SELECT id FROM users
        WHERE cognito_sub = $1 AND user_type = 'worker'`,
      [whatsappNumber],
    );
    const placeholderUserId = placeholder.rows[0]?.id;
    if (placeholderUserId && await hasPlaceholderDependents(client, placeholderUserId)) {
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
  const legalPayload = parseLegalReplyPayload(msg.interactivePayload);

  if (legalPayload === 'decline' || isDecline(msg.body, conv.language)) {
    await updateConversation(client, conv.id, {
      conversation_state: 'legal_declined',
      last_processed_message_sid: msg.messageSid,
    });
    await reply(client, msg,'legal_declined', conv.language);
    return;
  }

  if (legalPayload !== 'accept' && !isAccept(msg.body, conv.language)) {
    // Re-prompt with legal message (no state change; post-route stamp covers
    // idempotency)
    await queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
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
    await enterTrustSignalOrIdle(
      client,
      conv,
      from,
      messageSid,
      (dbFilled.main_trade as string | undefined) ?? 'other',
    );
    return;
  }
  await updateConversation(client, conv.id, {
    conversation_state: 'awaiting_media_voice',
    state_context: { collected: {}, field_sids: {} },
    last_processed_message_sid: messageSid,
  });
  await queueMediaPrompt(client, messageSid, from, conv.language, 'voice_choice');
}

interface WorkerProfileSummary {
  phone: string | null;
  whatsapp_number: string | null;
  full_name: string | null;
  city: string | null;
  main_trade: string | null;
  main_trade_other: string | null;
  years_experience: string | null;
  has_transportation: boolean | null;
  availability: string | null;
  trust_signals: unknown;
  trust_signals_completed_at: string | null;
  trust_assessment_profession_key: string | null;
  trust_assessment_status: string | null;
  trust_assessment_answers: unknown;
  trust_assessment_questions: unknown;
}

interface StoredTrustAnswer {
  label?: string;
}

interface StoredAssessmentAnswer {
  q_en?: string;
  answer_text?: string;
}

interface StoredAssessmentQuestion {
  q_en?: string;
  q_es?: string;
}

async function handleProfileCommand(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  if (!conv.user_id) {
    await reply(client, msg, 'profile_not_ready', conv.language);
    return;
  }

  const result = await client.query<WorkerProfileSummary>(
    `SELECT u.phone, u.whatsapp_number, u.full_name, u.city, u.main_trade, u.main_trade_other,
            u.years_experience, u.has_transportation, u.availability,
            u.trust_signals, u.trust_signals_completed_at,
            wta.profession_key AS trust_assessment_profession_key,
            wta.status AS trust_assessment_status,
            wta.answers AS trust_assessment_answers,
            tq.questions AS trust_assessment_questions
       FROM users u
       LEFT JOIN LATERAL (
         SELECT profession_key, status, answers, created_at
           FROM worker_trust_assessments
          WHERE user_id = u.id
          ORDER BY
            CASE status
              WHEN 'scored' THEN 0
              WHEN 'scoring' THEN 1
              WHEN 'pending' THEN 2
              ELSE 3
            END,
            created_at DESC
          LIMIT 1
       ) wta ON TRUE
       LEFT JOIN trade_questions tq ON tq.profession_key = wta.profession_key
      WHERE u.id = $1 AND u.user_type = 'worker'`,
    [conv.user_id],
  );

  const profile = result.rows[0];
  if (!profile) {
    await reply(client, msg, 'profile_not_ready', conv.language);
    return;
  }

  await queueText(
    client,
    msg.messageSid,
    msg.from,
    formatProfileSummary(profile, conv.language),
  );
}

function formatProfileSummary(profile: WorkerProfileSummary, lang: Lang): string {
  const trustSignals = parseTrustSignals(profile.trust_signals);
  const assessmentAnswers = parseAssessmentAnswers(profile.trust_assessment_answers);
  const assessmentQuestions = parseAssessmentQuestions(profile.trust_assessment_questions);
  const text = lang === 'es'
    ? {
        title: 'Tu perfil',
        phone: 'Telefono',
        name: 'Nombre',
        city: 'Ubicacion',
        trade: 'Oficio',
        experience: 'Experiencia',
        transportation: 'Transporte',
        availability: 'Disponibilidad',
        trust: 'Confianza',
        status: 'Estado',
        trustQuestions: 'Preguntas de confianza',
        answer: 'Respuesta',
        specialization: 'Especialidad',
        seniority: 'Nivel',
        tasks: 'Trabajo principal',
        missing: 'Sin completar',
        yes: 'Si',
        no: 'No',
      }
    : {
        title: 'Your profile',
        phone: 'Phone',
        name: 'Name',
        city: 'Location',
        trade: 'Trade',
        experience: 'Experience',
        transportation: 'Transportation',
        availability: 'Availability',
        trust: 'Trust',
        status: 'Status',
        trustQuestions: 'Trust questions',
        answer: 'Answer',
        specialization: 'Specialty',
        seniority: 'Level',
        tasks: 'Main work',
        missing: 'Not set',
        yes: 'Yes',
        no: 'No',
      };

  const mainTrade = profile.main_trade === 'other' && profile.main_trade_other
    ? profile.main_trade_other
    : labelFor('main_trade', profile.main_trade, lang);
  const transportation = typeof profile.has_transportation === 'boolean'
    ? (profile.has_transportation ? text.yes : text.no)
    : text.missing;

  const lines = [
    text.title,
    '',
    `${text.phone}: ${profile.whatsapp_number ?? profile.phone ?? text.missing}`,
    `${text.name}: ${profile.full_name ?? text.missing}`,
    `${text.city}: ${profile.city ?? text.missing}`,
    `${text.trade}: ${mainTrade}`,
    `${text.experience}: ${labelFor('years_experience', profile.years_experience, lang)}`,
    `${text.transportation}: ${transportation}`,
    `${text.availability}: ${labelFor('availability', profile.availability, lang)}`,
    '',
    text.trust,
  ];

  if (profile.trust_assessment_status || assessmentAnswers.length > 0) {
    if (profile.trust_assessment_status) {
      lines.push(`${text.status}: ${assessmentStatusLabel(profile.trust_assessment_status, lang)}`);
    }
    if (assessmentAnswers.length > 0) {
      lines.push('', text.trustQuestions);
      assessmentAnswers.forEach((answer, index) => {
        const question = displayQuestionForAnswer(answer, assessmentQuestions, lang);
        lines.push(
          `${index + 1}. ${question}`,
          `${text.answer}: ${answer.answer_text ?? text.missing}`,
        );
      });
    }
  } else if (profile.trust_signals_completed_at && trustSignals) {
    lines.push(
      `${text.specialization}: ${trustSignals.specialization?.label ?? text.missing}`,
      `${text.seniority}: ${trustSignals.seniority?.label ?? text.missing}`,
      `${text.tasks}: ${trustSignals.tasks?.label ?? text.missing}`,
    );
  } else {
    lines.push(text.missing);
  }

  return lines.join('\n');
}

function parseAssessmentAnswers(value: unknown): StoredAssessmentAnswer[] {
  return parseJsonArray<StoredAssessmentAnswer>(value);
}

function parseAssessmentQuestions(value: unknown): StoredAssessmentQuestion[] {
  return parseJsonArray<StoredAssessmentQuestion>(value);
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function displayQuestionForAnswer(
  answer: StoredAssessmentAnswer,
  questions: StoredAssessmentQuestion[],
  lang: Lang,
): string {
  const matched = questions.find((question) => question.q_en === answer.q_en);
  if (lang === 'es') {
    return matched?.q_es ?? answer.q_en ?? 'Pregunta';
  }
  return matched?.q_en ?? answer.q_en ?? 'Question';
}

function assessmentStatusLabel(status: string, lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    pending: { es: 'Pendiente', en: 'Pending' },
    scoring: { es: 'Calculando', en: 'Scoring' },
    scored: { es: 'Evaluado', en: 'Scored' },
    failed: { es: 'Fallido', en: 'Failed' },
  };
  return labels[status]?.[lang] ?? status;
}

function parseTrustSignals(value: unknown): Record<string, StoredTrustAnswer> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, StoredTrustAnswer>;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, StoredTrustAnswer>;
  }
  return null;
}

function labelFor(
  field: 'main_trade' | 'years_experience' | 'availability',
  value: string | null,
  lang: Lang,
): string {
  const labels: Record<typeof field, Record<string, Record<Lang, string>>> = {
    main_trade: {
      electrician: { es: 'Electricista', en: 'Electrician' },
      plumber: { es: 'Plomero', en: 'Plumber' },
      carpenter: { es: 'Carpintero', en: 'Carpenter' },
      concrete: { es: 'Concreto', en: 'Concrete' },
      painting: { es: 'Pintura', en: 'Painting' },
      other: { es: 'Otro', en: 'Other' },
    },
    years_experience: {
      '0-1': { es: '0-1 anos', en: '0-1 years' },
      '2-4': { es: '2-4 anos', en: '2-4 years' },
      '5-9': { es: '5-9 anos', en: '5-9 years' },
      '10+': { es: '10+ anos', en: '10+ years' },
    },
    availability: {
      full_time: { es: 'Tiempo completo', en: 'Full-time' },
      part_time: { es: 'Medio tiempo', en: 'Part-time' },
      weekends: { es: 'Fines de semana', en: 'Weekends' },
      flexible: { es: 'Flexible', en: 'Flexible' },
    },
  };

  return value ? labels[field][value]?.[lang] ?? value : (lang === 'es' ? 'Sin completar' : 'Not set');
}

async function askProfileQuestion(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  field: ProfileField,
  lang: Lang,
): Promise<void> {
  const prompt = buildProfileInteractivePrompt(field, lang);
  if (prompt) {
    await queueInteractivePrompt(client, inboundMessageSid, to, prompt);
    return;
  }
  await queueText(client, inboundMessageSid, to, profileQuestionBody(field, lang));
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

  const answer = parseProfilePayloadAnswer(pending, msg.interactivePayload)
    ?? parseProfileAnswer(pending, msg.body);
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

  await upsertWorkerProfileFromUsers(client, conv.user_id);

  await enterTrustSignalOrIdle(
    client,
    conv,
    from,
    messageSid,
    (data.main_trade as string | undefined) ?? undefined,
  );
}

async function enterOptionalPhotoUpload(
  client: PoolClient,
  conv: ConversationRow,
  from: string,
  messageSid: string,
): Promise<void> {
  await updateConversation(client, conv.id, {
    conversation_state: 'awaiting_media_photo',
    state_context: { ...conv.state_context, profile_completed: true },
    last_processed_message_sid: messageSid,
  });
  await queueReply(client, messageSid, from, 'profile_complete', conv.language);
  await queueMediaPrompt(client, messageSid, from, conv.language, 'photo_skip');
}

async function enterTrustSignalOrIdle(
  client: PoolClient,
  conv: ConversationRow,
  from: string,
  messageSid: string,
  tradeHint?: string,
): Promise<void> {
  if (!conv.user_id) throw new Error('user_id missing before trust signal');

  const trade = tradeHint ?? await loadTradeFromDb(client, conv.user_id);

  if (trade === 'other') {
    const tradeOtherRow = await client.query<{ main_trade_other: string | null }>(
      'SELECT main_trade_other FROM users WHERE id = $1',
      [conv.user_id],
    );
    const professionRaw = tradeOtherRow.rows[0]?.main_trade_other;
    if (professionRaw) {
      const { loadOrGenerateQuestions, normalizeProfession } = await import('./handlers/custom-trust');
      const professionKey = normalizeProfession(professionRaw);
      const existingWta = await client.query(
        `SELECT id FROM worker_trust_assessments
         WHERE user_id = $1 AND profession_key = $2
           AND status IN ('pending','scoring','scored','failed')`,
        [conv.user_id, professionKey],
      );

      if (existingWta.rows.length === 0) {
        const assessmentId = randomUUID();
        const questions = await loadOrGenerateQuestions(client, professionKey, professionRaw);
        await updateConversation(client, conv.id, {
          conversation_state: 'building_custom_trust',
          state_context: {
            custom_trust_step: 0,
            custom_trust_answers: [],
            custom_trust_profession: professionRaw,
            custom_trust_questions: questions,
            custom_trust_assessment_id: assessmentId,
          },
          last_processed_message_sid: messageSid,
        });
        await queueText(
          client,
          messageSid,
          from,
          conv.language === 'es' ? questions[0].q_es : questions[0].q_en,
        );
        return;
      }
    }

    await enterOptionalPhotoUpload(client, conv, from, messageSid);
    return;
  }

  if (!await trustSignalColumnsAvailable(client)) {
    console.warn('[processor] trust signal columns missing; skipping trust flow', {
      userId: conv.user_id,
    });
    await enterOptionalPhotoUpload(client, conv, from, messageSid);
    return;
  }

  const trust = await client.query<{ trust_signals_completed_at: string | null }>(
    `SELECT trust_signals_completed_at FROM users WHERE id = $1`,
    [conv.user_id],
  );
  const trustDone = !!trust.rows[0]?.trust_signals_completed_at;

  if (!trustDone) {
    await updateConversation(client, conv.id, {
      conversation_state: 'building_trust_signal',
      state_context: { trust_step: 0, trust_answers: [] },
      last_processed_message_sid: messageSid,
    });
    await queueTrustPrompt(client, messageSid, from, 0, trade, conv.language);
    return;
  }

  await enterOptionalPhotoUpload(client, conv, from, messageSid);
}

async function handleBuildingTrustSignal(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  if (!conv.user_id) throw new Error('user_id missing in building_trust_signal');

  if (!await trustSignalColumnsAvailable(client)) {
    console.warn('[processor] trust signal columns missing during trust flow; completing profile without trust signals', {
      userId: conv.user_id,
    });
    await enterOptionalPhotoUpload(client, conv, msg.from, msg.messageSid);
    return;
  }

  const step = conv.state_context?.trust_step ?? 0;
  const answers = conv.state_context?.trust_answers ?? [];
  const trade = await loadTradeFromDb(client, conv.user_id);
  const answer = parseTrustPayloadAnswer(step, trade, msg.interactivePayload)
    ?? parseTrustAnswer(step, trade, msg.body);

  if (!answer) {
    await queueTrustPrompt(client, msg.messageSid, msg.from, step, trade, conv.language);
    return;
  }

  const updatedAnswers: TrustAnswer[] = [...answers, answer];

  if (step < TRUST_STEPS.length - 1) {
    await updateConversation(client, conv.id, {
      state_context: {
        trust_step: step + 1,
        trust_answers: updatedAnswers,
      },
      last_processed_message_sid: msg.messageSid,
    });
    await queueTrustPrompt(client, msg.messageSid, msg.from, step + 1, trade, conv.language);
    return;
  }

  const signalMap = Object.fromEntries(
    updatedAnswers.map((item) => [item.questionKey, item]),
  );
  await client.query(
    `UPDATE users
        SET trust_signals = $1::jsonb,
            trust_signals_completed_at = now()
      WHERE id = $2`,
    [JSON.stringify(signalMap), conv.user_id],
  );

  type SeededTrustQuestion = { q_en: string; q_es: string };
  const knownTradeQuestions = await client.query<{ questions: SeededTrustQuestion[] }>(
    'SELECT questions FROM trade_questions WHERE profession_key = $1 AND is_seeded = true',
    [trade],
  );
  if (knownTradeQuestions.rows.length > 0) {
    const seededQuestions = knownTradeQuestions.rows[0].questions;
    const existingWta = await client.query(
      `SELECT id FROM worker_trust_assessments
       WHERE user_id = $1 AND profession_key = $2
         AND status IN ('pending','scoring','scored','failed')`,
      [conv.user_id, trade],
    );
    if (existingWta.rows.length === 0) {
      const questionIndexByField: Record<TrustAnswer['questionKey'], number> = {
        specialization: 0,
        seniority: 1,
        tasks: 2,
      };
      const answersArray = updatedAnswers.map((item) => ({
        q_en: seededQuestions[questionIndexByField[item.questionKey]]?.q_en ?? item.questionKey,
        answer_text: item.label,
        answer_source: 'text' as const,
        answered_at: new Date().toISOString(),
      }));
      const assessmentId = randomUUID();
      await client.query(
        `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status)
         VALUES ($1, $2, $3, $4::jsonb, 'pending')
         ON CONFLICT DO NOTHING`,
        [assessmentId, conv.user_id, trade, JSON.stringify(answersArray)],
      );
      const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
      const sqsClientLocal = new SQSClient({});
      await sqsClientLocal.send(
        new SendMessageCommand({
          QueueUrl: process.env.TRUST_ASSESSMENT_QUEUE_URL!,
          MessageBody: JSON.stringify({ assessmentId, userId: conv.user_id, professionKey: trade }),
        }),
      );
    }
  } else {
    console.warn('[processor] known-trade seeded questions missing for trade', {
      trade,
      userId: conv.user_id,
    });
    console.log(JSON.stringify({ metric: 'AIKnownTradeQuestionsMissing', trade }));
  }

  await enterOptionalPhotoUpload(client, conv, msg.from, msg.messageSid);
}

// ── idle — handle Jobs keyword + button callbacks ───────────────
async function handleIdle(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<string | null> {
  const typedAction = parseTypedJobAction(msg.body);
  if (typedAction) {
    const recentJobs = conv.state_context?.recent_jobs ?? [];
    const jobId = recentJobs[typedAction.index];
    if (!jobId) {
      await reply(client, msg, 'job_not_found', conv.language);
      return null;
    }
    await handleJobAction(
      client,
      conv,
      jobId,
      typedAction.action,
      msg.from,
      msg.messageSid,
    );
    return null;
  }

  if (isJobsKeyword(msg.body)) {
    if (!conv.user_id) {
      await reply(client, msg, 'jobs_none', conv.language);
      return null;
    }
    await client.query(
      `SELECT set_config('app.current_internal_user_id', $1, true)`,
      [conv.user_id],
    );
    const jobs = await listMatchedJobsForWorker(client, conv.user_id, {
      limit: 5,
      channel: 'whatsapp',
    });
    if (jobs.length === 0) {
      await reply(client, msg,'jobs_none', conv.language);
      return null;
    }
    const recentJobs = jobs.map((j) => j.id);
    await updateConversation(client, conv.id, {
      state_context: {
        ...conv.state_context,
        recent_jobs: recentJobs,
      },
      last_processed_message_sid: msg.messageSid,
    });
    for (const job of jobs) {
      await queueJobTemplate(client, msg.messageSid, msg.from, conv.language, job);
    }
    return null;
  }

  if (conv.user_id && msg.body.trim()) {
    await setInternalUserRlsContext(client, conv.user_id);
    const result = await recordWorkerConversationReply(
      client,
      conv.user_id,
      msg.body,
      msg.from,
      msg.messageSid,
      conv.state_context?.active_job_conversation_id,
    );
    if (result.status === 'routed') return conv.user_id;
  }

  await reply(client, msg,'idle_help', conv.language);
  return null;
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
  await handleJobAction(client, conv, bareJobId, payload.action, from, inboundMessageSid);
}

async function handleJobAction(
  client: PoolClient,
  conv: ConversationRow,
  jobId: string,
  action: 'accept' | 'decline' | 'info',
  from: string,
  inboundMessageSid: string,
): Promise<void> {
  const job = await client.query<{
    id: string; title: string; company: string;
    location: string; pay: string;
  }>(
    `SELECT id,
            title,
            COALESCE(company, 'Jale') AS company,
            location,
            COALESCE(pay, 'Pay not specified') AS pay
       FROM jobs
      WHERE id = $1
        AND status = 'active'`,
    [jobId],
  );
  if (job.rowCount === 0) {
    await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    return;
  }
  if (!conv.user_id) {
    await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    return;
  }

  if (action === 'accept') {
    const applyResult = await applyWorkerToJob(client, {
      workerId: conv.user_id,
      jobId,
      surface: 'whatsapp',
    });

    if (applyResult.status === 'applied') {
      await queueReply(client, inboundMessageSid, from, 'job_accepted', conv.language);
    } else if (applyResult.status === 'already_applied') {
      await queueReply(client, inboundMessageSid, from, 'job_already_applied', conv.language);
    } else if (applyResult.status === 'missing_documents') {
      await queueReply(client, inboundMessageSid, from, 'job_documents_required', conv.language, {
        missing_docs: localizeDocList(applyResult.missing_docs, conv.language),
      });
    } else {
      await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    }
  } else if (action === 'decline') {
    await queueReply(client, inboundMessageSid, from, 'job_declined', conv.language);
  } else {
    const r = job.rows[0];
    const recentIndex = conv.state_context?.recent_jobs?.indexOf(jobId) ?? -1;
    const commandIndex = recentIndex >= 0 ? recentIndex + 1 : 1;
    await queueText(
      client,
      inboundMessageSid,
      from,
      conv.language === 'es'
        ? `Detalles del trabajo\n\n${r.title}\n${r.company}\n${r.location}\n${r.pay}\n\nResponde "${commandIndex} aceptar" para aplicar.`
        : `Job details\n\n${r.title}\n${r.company}\n${r.location}\n${r.pay}\n\nReply "${commandIndex} accept" to apply.`,
    );
  }
}

function localizeDocList(docTypes: string[], lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    resume: { en: 'Resume', es: 'Resume' },
    driver_license: { en: "Driver's license", es: 'Licencia de conducir' },
    ssn: { en: 'SSN card / ITIN', es: 'Tarjeta SSN / ITIN' },
  };
  return docTypes.map((docType) => labels[docType]?.[lang] ?? docType).join(', ');
}
