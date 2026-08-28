import type { SQSEvent, SQSHandler, SQSRecord } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
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
import { cityAnchorsFrom, listMatchedJobsForWorker, loadWorkerPreferredCities } from '../lib/job-matching';
import { formatPayRangeLocalized, payNotSpecifiedLabel } from '../lib/job-fields';
import {
  declineLatestWorkerConversationFromButtonText,
  declineWorkerConversationFromButton,
  openLatestWorkerConversationFromButtonText,
  openWorkerConversationFromButton,
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
  tryConversationRelay,
  parseDisambiguationPick,
  handlePickerResponse,
  recordRelayLegalAcceptance,
  handleLegalDeclineFromRelay,
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
  buildHelpMenuInteractivePrompt,
  buildLegalInteractivePrompt,
  type InteractivePrompt,
} from './lib/interactive-templates';
import {
  isGreetingKeyword,
  detectCommandLanguage,
  isJobsKeyword,
  isHelpCommand,
  isSupportCommand,
  isProfileCommand,
  parseButtonPayload,
  parseCommandPayload,
  parseEmployerConversationButtonPayload,
  parseLegalReplyPayload,
  parseTypedJobAction,
  type ConversationState,
  type ProfileStateContext,
} from './lib/flows';
import {
  detectMediaCategory,
  buildS3Key,
  downloadTwilioMedia,
  downloadTwilioMediaBounded,
  uploadMediaToS3,
  MAX_VOICE_BYTES,
  MAX_DOCUMENT_BYTES,
} from './lib/media';
import {
  computeNextStep,
  countRemainingRequirements,
  seedAnswersFromDefaults,
  promptNextStep,
  handleFillMessage,
  localizeDocList,
  type FillContext,
  type FillDeps,
  type FillStateContext,
} from './lib/application-fill';
import {
  handlePostLaneMessage,
  discardActiveDraft,
  MAX_POST_PHOTO_BYTES,
  type PostDeps,
  type PostCtx,
} from './lib/post-creation';
import { moderateImage } from '../lib/moderation';
import { REPROMPT_COOLDOWN_MS } from './lib/onboarding-language';
import { fillMessage } from './lib/application-fill-prompts';
import { makeBedrockExtractionClient } from './lib/application-fill-extraction';
import {
  parseVoiceTranscriptEvent,
  type VoiceEventV2,
  type VoicePipelineExecutionInputV2,
} from './lib/voice-events';
import {
  loadRuntimeControls,
  isVoiceIntakeEnabled,
  hashNormalizedPhone,
} from './lib/runtime-controls';
import {
  loadPreAuthStateForUpdate,
  savePreAuthState,
  bindVerifiedIdentityAndStartWorkflow,
  loadWorkerGate,
  advanceWorkflow,
  setRunPreferredLanguage,
  reactivateDeclinedLegalRun,
  appendTransition,
  completeOnboarding,
  clearProfileAnswers,
  resetPendingTrustAssessmentAndSkills,
  findPreviousStepKey,
} from './lib/onboarding-repository';
import { recordCanonicalWhatsAppConsent } from './lib/legal-consent';
import { enqueueWorkerMessage } from './lib/worker-delivery-gateway';
import { registerOnboardingRenderers } from './lib/onboarding-renderers';
import { publishOutboxWakes, type PostCommitWakeSignals } from './lib/outbox-wake';
import { createOnboardingV2Adapters } from './lib/onboarding-adapters';
import {
  routeOnboardingV2,
  type OnboardingV2Deps,
  type OnboardingV2RepoDeps,
  type OnboardingV2Session,
  type OnboardingV2InboundMessage,
} from './onboarding-v2';

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

/** Worker-facing pay fields shared by every WhatsApp render site that shows
 * a job's pay: the structured `pay_min`/`pay_max`/`pay_interval` (source of
 * truth when present, rendered via `formatPayRangeLocalized`), the raw
 * legacy `jobs.pay` free-text string (pre-023 jobs predating pay_min/max --
 * preserved verbatim, never translated, since it is employer free text), and
 * a localized "not specified" fallback when neither exists. */
interface LocalizablePay {
  pay_min?: string | number | null;
  pay_max?: string | number | null;
  pay_interval?: string | null;
  /** Raw (undecorated) legacy pay string. Prefer this over a
   * pre-`COALESCE`'d `pay` field so the "not specified" placeholder a shared
   * query already baked in doesn't get mistaken for a real legacy value. */
  pay_raw?: string | null;
}

function toPayNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function localizedJobPay(job: LocalizablePay, lang: Lang): string {
  const structured = formatPayRangeLocalized(
    toPayNumber(job.pay_min),
    toPayNumber(job.pay_max),
    job.pay_interval ?? null,
    lang,
  );
  if (structured !== null) return structured;
  if (job.pay_raw) return job.pay_raw;
  return payNotSpecifiedLabel(lang);
}

async function queueJobTemplate(
  client: PoolClient,
  inboundMessageSid: string,
  to: string,
  lang: Lang,
  job: {
    id: string; title: string; company: string; location: string; pay: string;
  } & LocalizablePay,
): Promise<void> {
  const whatsappNumber = to.replace(/^whatsapp:/, '');
  const templateName = lang === 'en' ? 'job_alert_en' : 'job_alert_es';
  const variables = {
    '1': job.title,
    '2': job.company,
    '3': job.location,
    '4': localizedJobPay(job, lang),
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

// Canonical legal URLs — the v2 branch's OnboardingV2Deps.tosUrl/privacyUrl
// reuse these same constants so both lanes point at the same documents.
const LEGAL_TOS_URL = 'https://jaleapp.ai/legal/terms';
const LEGAL_PRIVACY_URL = 'https://jaleapp.ai/legal/privacy';

// v2 onboarding workflow version passed to bindVerifiedIdentityAndStartWorkflow
// / advanceWorkflow (matches the workflowVersion used across Tasks 4/5's
// onboarding-v2 tests and the 042 migration's CHECK).
const WHATSAPP_V2_WORKFLOW_VERSION = 1;

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
    buildLegalInteractivePrompt(lang, LEGAL_TOS_URL),
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

// ── Error fallback (2026-07-26 incident) ─────────────────────────────
//
// When a handler throws inside the claim transaction, ROLLBACK discards
// everything — including whatever reply was queued — so the user heard
// nothing while the message retried into the DLQ. This safety net sends ONE
// generic apology per failed inbound message, at most one per phone per 30
// minutes, on a FRESH transaction after the rollback.
//
// The synthetic claim row `<sid>#err` is three things at once: the FK
// parent for the apology's outbox row (whatsapp_outbox.inbound_message_sid
// references whatsapp_processed_messages), the idempotency key across SQS
// retries (same INSERT ... ON CONFLICT DO NOTHING pattern as the real
// claim), and operator forensics (status='failed' + last_error). `#` never
// appears in a Twilio sid, so it cannot collide with a real inbound
// message, and 38 chars fits the VARCHAR(50) column.
//
// Sent on the FIRST failure rather than the last retry: attempt 5 lands
// ~24 minutes later (360s visibility timeout), ApproximateReceiveCount is
// documented as approximate, and failures inside the claim tx are dominated
// by deterministic bugs where retries change nothing. A recovered transient
// therefore produces apology-then-real-reply — the copy ("try again in a
// few minutes") reads correctly in that order.
async function sendErrorFallback(
  client: PoolClient,
  inboundMessageSid: string,
  from: string,
  defaultLang: Lang,
  originalErr: unknown,
): Promise<void> {
  const whatsappNumber = from.replace(/^whatsapp:/, '');
  const errorSid = `${inboundMessageSid}#err`;
  const errText = ((originalErr as Error)?.message ?? String(originalErr)).slice(0, 500);
  await client.query('BEGIN');
  try {
    // Per-phone cooldown: one apology per 30 minutes no matter how many
    // distinct messages keep failing (a FIFO lane wedged on a deterministic
    // bug fails every subsequent message too). Uses the existing
    // idx_wa_processed_number (whatsapp_number, first_seen_at DESC) index.
    const recent = await client.query(
      `SELECT 1 FROM whatsapp_processed_messages
        WHERE whatsapp_number = $1
          AND message_sid LIKE '%#err'
          AND message_sid <> $2
          AND first_seen_at > now() - interval '30 minutes'
        LIMIT 1`,
      [whatsappNumber, errorSid],
    );
    const claim = await client.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, last_error)
       VALUES ($1, $2, 'failed', $3)
       ON CONFLICT (message_sid) DO NOTHING
       RETURNING message_sid`,
      [errorSid, whatsappNumber, errText],
    );
    if (claim.rowCount === 1 && recent.rowCount === 0) {
      // The conversation row may not exist (a brand-new user's row was
      // created inside the rolled-back tx), so prefer its language but fall
      // back to the inbound body's detected language.
      const conv = await client.query<{ language: Lang }>(
        `SELECT language FROM whatsapp_conversations WHERE whatsapp_number = $1`,
        [whatsappNumber],
      );
      const lang = conv.rows[0]?.language ?? defaultLang;
      await queueText(client, errorSid, from, t('processing_error', lang));
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  }
  // Outside the tx, like the main path's phase 2. Also re-drains a pending
  // apology left by a prior attempt that crashed between COMMIT and the
  // Twilio send — the ON CONFLICT branch above queues nothing new, but this
  // drain still delivers the earlier pending row exactly once.
  await sendPendingOutbox(client, errorSid);
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
    ?? findKnownPayload(params.ListId)
    ?? extractInteractivePayload(params.InteractiveData)
    ?? extractInteractivePayload(params.ChannelMetadata)
    ?? (body.length <= 256 ? findKnownPayload(body) : undefined);
  const interactivePayloadSource: 'button' | 'list_id' | 'interactive_data' | 'channel_metadata' | 'body' | 'none' =
    buttonPayload ? 'button'
    : findKnownPayload(params.ListId) ? 'list_id'
    : extractInteractivePayload(params.InteractiveData) ? 'interactive_data'
    : extractInteractivePayload(params.ChannelMetadata) ? 'channel_metadata'
    : (body.length <= 256 && findKnownPayload(body)) ? 'body'
    : 'none';
  const numMedia = parseInt(params.NumMedia ?? '0', 10);
  const mediaUrl = params.MediaUrl0;
  const mediaSid = params.MediaSid0;
  const mediaContentType = params.MediaContentType0;
  // A synthetic voice-pipeline completion re-entry (see lib/voice-events.ts)
  // — null for every real Twilio webhook delivery.
  const voiceEvent = parseVoiceTranscriptEvent(params);
  const wakeSignals: PostCommitWakeSignals = { workerIntent: false, domain: false };

  if (!from || !messageSid) {
    console.warn('[processor] skipping malformed inbound record', { hasMessageSid: Boolean(messageSid), hasFrom: Boolean(from) });
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
      }, wakeSignals, voiceEvent);
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
      if (claimed) {
        // Safety net, best-effort: the user must not be left in total
        // silence while this message retries into the DLQ. A fallback
        // failure must never mask the original error or block the rethrow
        // (retry/DLQ semantics stay exactly as before). Gated on `claimed`:
        // if the claim itself threw, the DB is unhealthy (the fallback
        // would fail too) and nothing user-visible was attempted; the
        // lost-race path returns without throwing and never reaches here.
        try {
          await sendErrorFallback(client, messageSid, from, defaultLang, err);
          console.warn(JSON.stringify({
            metric: 'WhatsAppProcessorFallbackReply',
            messageSid,
            receiveCount: record.attributes?.ApproximateReceiveCount ?? null,
          }));
        } catch (fallbackErr) {
          console.warn('[processor] error fallback failed', {
            messageSid,
            err: (fallbackErr as Error).message,
          });
        }
      } else {
        console.warn('[processor] claim failed before first mutation', {
          messageSid,
          err: (err as Error).message,
        });
      }
      throw err;
    }

    // Phase 2 — outside the tx, do the Twilio sends. If any throw, SQS
    // retry resumes from 'db_committed'. No DB rollback: the state is
    await publishOutboxWakes(wakeSignals);
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
    return /^(legal|profile|trust|media|conversation|command|otp):/.test(value) ? value : undefined;
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

// ── v2 trust-question voice-note transcription kickoff ──────────
//
// Mirrors handleAwaitingMediaVoice's Twilio-download -> S3 -> StartExecution
// pattern above, but for the v2 lane's trust.question.* steps: it never
// advances the step or takes the run lock — recordTrustAnswer only runs when
// the transcript comes back (onboarding/steps/trust.ts), so a typed answer
// that arrives first still wins the race. Runs on the SAME client/
// transaction as the rest of the turn (closed over by the v2Deps.voiceIntake
// wiring above), so a StartExecution failure rolls back the S3 upload's
// worker_profile_media row along with everything else in this turn.
async function startTrustTranscription(
  client: PoolClient,
  input: {
    workerId: string;
    phone: string;
    runId: string;
    stepKey: string;
    questionIndex: number;
    language: Lang;
    mediaUrl: string;
    mediaContentType: string;
    inboundMessageSid: string;
  },
): Promise<{ started: boolean; reason?: string; executionArn?: string }> {
  const category = detectMediaCategory(input.mediaContentType);
  if (category !== 'voice') return { started: false, reason: 'invalid_media_type' };

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const stateMachineArn = process.env.TRUST_PIPELINE_STATE_MACHINE_ARN;
  if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');
  if (!stateMachineArn) throw new Error('TRUST_PIPELINE_STATE_MACHINE_ARN not set');

  let mediaBuffer: Buffer;
  try {
    const twilioSecret = await getTwilioSecret();
    mediaBuffer = await downloadTwilioMedia(input.mediaUrl, twilioSecret.accountSid, twilioSecret.authToken);
  } catch (err) {
    // Task 7/B5 fix: an expired/unreachable Twilio media URL must never
    // throw bare here — this runs inside the claim transaction, so an
    // uncaught throw aborts it, poisons the phone's FIFO message group, and
    // burns all five retries. Degrade to the same graceful
    // `{started: false}` path a rejected file already takes; the existing
    // `v2_voice_failed` reprompt (handleTrustVoiceNote, onboarding/steps/
    // trust.ts) handles it from here.
    console.error(JSON.stringify({
      metric: 'OnboardingTrustVoiceDownloadFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    return { started: false, reason: 'download_failed' };
  }
  // Twilio does not reject oversized uploads at the source; enforce the cap
  // post-download rather than stranding the worker on a silent failure.
  if (mediaBuffer.byteLength > MAX_VOICE_BYTES) return { started: false, reason: 'file_too_large' };

  const mediaId = randomUUID();
  const s3Key = buildS3Key(input.workerId, mediaId, 'voice');
  await uploadMediaToS3(bucketName, s3Key, mediaBuffer, input.mediaContentType);

  await setWorkerRlsContextByUserId(client, input.workerId);
  await client.query(
    `INSERT INTO worker_profile_media
       (id, user_id, media_type, s3_key, content_type)
     VALUES ($1, $2, 'voice_message', $3, $4)`,
    [mediaId, input.workerId, s3Key, input.mediaContentType],
  );

  const transcriptionJobName = `jale-vt-${input.workerId.replace(/-/g, '')}-${Date.now()}`;
  const mediaS3Uri = `s3://${bucketName}/${s3Key}`;
  const transcriptOutputKey = `${input.workerId}/transcripts/${transcriptionJobName}.json`;

  const sfnInput: VoicePipelineExecutionInputV2 = {
    transcriptionJobName,
    mediaS3Uri,
    mediaBucketName: bucketName,
    transcriptOutputKey,
    v2: {
      version: 'v2',
      kind: 'trust_answer',
      phone: input.phone,
      runId: input.runId,
      stepKey: input.stepKey,
      language: input.language,
      origMessageSid: input.inboundMessageSid,
      startedAt: new Date().toISOString(),
      questionIndex: input.questionIndex,
    },
  };

  // Deterministic execution name (same shape as sendErrorFallback's `<sid>#err`
  // idempotency key): an SQS redelivery of the same inbound voice note
  // resolves to the SAME execution rather than starting a second
  // transcription job. Deriving the ARN here (Task 5/B3), same pattern as
  // `ingestProfileVoiceNote` below, gives the router a staleness anchor
  // (`state_context.v2TrustVoiceExecutionArn`) synchronously, before the
  // pipeline itself has run — it never has to wait for the async completion
  // to learn what its own execution's ARN will be.
  const executionName = `vt-${input.inboundMessageSid}`;
  const executionArn = deriveExecutionArn(stateMachineArn, executionName);

  try {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      name: executionName,
      input: JSON.stringify(sfnInput),
    }));
  } catch (err: any) {
    if (err?.name !== 'ExecutionAlreadyExists') throw err;
  }

  return { started: true, executionArn };
}

// ── v2 full voice profile intake (Stream B) — ingestion kickoff ──
//
// Mirrors startTrustTranscription's Twilio-download -> S3 -> StartExecution
// pattern, but targets the SAME v1 profile pipeline (AI_PIPELINE_STATE_
// MACHINE_ARN / ai-profile-writer.ts) that a v1 worker's media-onboarding
// voice note already runs through — tagged with a `v2` marker so
// ai-profile-writer's completion branch re-enters this lane via a synthetic
// `#vp` event instead of writing `users`/outbox directly (Task 8d). Runs on
// the SAME client/transaction as the rest of the turn, closed over by the
// v2Deps.voiceIntake wiring below.

/**
 * Step Functions execution ARNs are deterministic:
 * `arn:...:stateMachine:<name>` -> `arn:...:execution:<name>:<executionName>`.
 * Deriving it here (rather than trusting `StartExecutionCommand`'s response)
 * means the SAME value is available synchronously on `ExecutionAlreadyExists`
 * (a redelivered inbound voice note) as on a fresh start — both resolve to
 * the one execution the deterministic name identifies.
 */
function deriveExecutionArn(stateMachineArn: string, executionName: string): string {
  const parts = stateMachineArn.split(':');
  const [, , , region, account, , stateMachineName] = parts;
  return `arn:aws:states:${region}:${account}:execution:${stateMachineName}:${executionName}`;
}

async function ingestProfileVoiceNote(
  client: PoolClient,
  input: {
    workerId: string;
    phone: string;
    runId: string;
    stepKey: string;
    language: Lang;
    mediaUrl: string;
    mediaContentType: string;
    inboundMessageSid: string;
  },
): Promise<{ started: boolean; reason?: string; executionArn?: string }> {
  const category = detectMediaCategory(input.mediaContentType);
  if (category !== 'voice') return { started: false, reason: 'invalid_media_type' };

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const stateMachineArn = process.env.AI_PIPELINE_STATE_MACHINE_ARN;
  if (!bucketName) throw new Error('MEDIA_BUCKET_NAME not set');
  if (!stateMachineArn) throw new Error('AI_PIPELINE_STATE_MACHINE_ARN not set');

  let mediaBuffer: Buffer;
  try {
    const twilioSecret = await getTwilioSecret();
    mediaBuffer = await downloadTwilioMedia(input.mediaUrl, twilioSecret.accountSid, twilioSecret.authToken);
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'OnboardingVoiceIngestDownloadFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    return { started: false, reason: 'download_failed' };
  }

  // Twilio does not reject oversized uploads at the source; enforce the cap
  // post-download rather than stranding the worker on a silent failure.
  if (mediaBuffer.byteLength > MAX_VOICE_BYTES) return { started: false, reason: 'file_too_large' };

  const mediaId = randomUUID();
  const s3Key = buildS3Key(input.workerId, mediaId, 'voice');
  await uploadMediaToS3(bucketName, s3Key, mediaBuffer, input.mediaContentType);

  await setWorkerRlsContextByUserId(client, input.workerId);
  await client.query(
    `INSERT INTO worker_profile_media
       (id, user_id, media_type, s3_key, content_type)
     VALUES ($1, $2, 'voice_message', $3, $4)`,
    [mediaId, input.workerId, s3Key, input.mediaContentType],
  );

  const transcriptionJobName = `jale-vp-${input.workerId.replace(/-/g, '')}-${Date.now()}`;
  const mediaS3Uri = `s3://${bucketName}/${s3Key}`;
  const transcriptOutputKey = `${input.workerId}/transcripts/${transcriptionJobName}.json`;

  // "v1-shaped" top-level context fields (userId/whatsappNumber/language/
  // inboundMessageSid — exactly what AiProfileWriterContext already
  // destructures) plus a `v2` marker carrying the two identifiers v1 never
  // needed (workflowRunId/expectedStepKey). ai-profile-writer's normalizeEvent
  // reads this SAME shape for both v1 and v2 — presence of `v2` alone
  // decides the branch.
  const sfnInput = {
    userId: input.workerId,
    // conversationId is part of AiProfileWriterContext's v1 shape but is
    // NEVER read on the v2 branch (no queueOutboxText/autoAdvanceProfileAfterAi
    // call there) — runId is a harmless, always-present stand-in.
    conversationId: input.runId,
    inboundMessageSid: input.inboundMessageSid,
    whatsappNumber: input.phone,
    language: input.language,
    mediaBucketName: bucketName,
    transcriptionJobName,
    mediaS3Uri,
    transcriptOutputKey,
    voiceMessageMediaId: mediaId,
    v2: {
      workflowRunId: input.runId,
      expectedStepKey: input.stepKey,
      startedAt: new Date().toISOString(),
    },
  };

  const executionName = `vp-${input.inboundMessageSid}`;
  const executionArn = deriveExecutionArn(stateMachineArn, executionName);

  try {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      name: executionName,
      input: JSON.stringify(sfnInput),
    }));
  } catch (err: any) {
    if (err?.name !== 'ExecutionAlreadyExists') throw err;
  }

  return { started: true, executionArn };
}

async function handleSupportCommand(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  // Prefer the OTP-linked identity, then allow the existing verified-phone
  // resolver. The database function independently checks the exact
  // worker/conversation relationship and never binds conversation identity.
  const workerId = conv.user_id ?? await resolveWorkerIdForWhatsappNumber(client, msg.from);
  if (!workerId) {
    await queueReply(client, msg.messageSid, msg.from, 'support_needs_signup', conv.language);
    return;
  }

  await setWorkerRlsContextByUserId(client, workerId);

  const result = await client.query<{ case_id: string; created: boolean }>(
    `SELECT case_id, created
       FROM create_admin_support_case($1, $2, $3, $4)`,
    [workerId, conv.id, 'Worker requested WhatsApp support', msg.body],
  );
  const supportCase = result.rows[0];
  if (!supportCase) {
    throw new Error('create_admin_support_case returned no row');
  }

  await queueReply(
    client,
    msg.messageSid,
    msg.from,
    supportCase.created ? 'support_ack' : 'support_ack_existing',
    conv.language,
  );
}

async function routeMessage(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  wakeSignals: PostCommitWakeSignals,
  voiceEvent: VoiceEventV2 | null,
): Promise<string | null> {
  // v2 is now the only onboarding lane — the legacy state machine has been
  // deleted. `runtimeControls`/`phoneHash` are still needed for the
  // voice_intake runtime control below (a live, independently-gated
  // control, unrelated to the removed v2/v1 split).
  const runtimeControls = await loadRuntimeControls(client);
  const phoneHash = hashNormalizedPhone(conv.whatsapp_number);

  registerOnboardingRenderers();

  const v2Deps: OnboardingV2Deps = {
    adapters: createOnboardingV2Adapters({ reconcileUserRow, cognitoClient: cognito }),
    repo: {
      setInternalUserRlsContext,
      loadPreAuthStateForUpdate,
      savePreAuthState,
      bindVerifiedIdentityAndStartWorkflow,
      loadWorkerGate,
      // Cast: onboarding-repository.ts's `status` param is the narrower
      // WorkflowRunStatus union; OnboardingV2RepoDeps's assumed contract
      // types it as `string`. A cross-lane interface detail, not a
      // logic mismatch — the real function only ever receives values
      // from the closed union anyway.
      advanceWorkflow: advanceWorkflow as OnboardingV2RepoDeps['advanceWorkflow'],
      reactivateDeclinedLegalRun,
      setRunPreferredLanguage,
      appendTransition,
      completeOnboarding: async (repoClient, input) => {
        const result = await completeOnboarding(repoClient, input);
        wakeSignals.domain = true;
        return result;
      },
      clearProfileAnswers,
      resetPendingTrustAssessmentAndSkills,
      findPreviousStepKey,
    },
    enqueueWorkerMessage: async (gatewayClient, input, now) => {
      const result = await enqueueWorkerMessage(gatewayClient, input, now);
      if (result.outboxMaterialized) {
        wakeSignals.workerIntent = true;
      }
      return result;
    },
    // Design A: pre-auth steps have no bound user_id, so their prompts
    // travel the same phone/inbound-message-keyed outbox writers the
    // legacy relay/legal paths already use — never a new outbox writer.
    enqueuePreAuthPrompt: queueInteractivePrompt,
    enqueuePreAuthText: queueText,
    hashNormalizedPhone,
    tosUrl: LEGAL_TOS_URL,
    privacyUrl: LEGAL_PRIVACY_URL,
    workflowVersion: WHATSAPP_V2_WORKFLOW_VERSION,
    requiredLegalVersion: process.env.REQUIRED_TOS_VERSION ?? '1.0',
    recordLegalAcceptance: recordCanonicalWhatsAppConsent,
    voiceIntake: {
      enabled: isVoiceIntakeEnabled(runtimeControls, phoneHash),
      startTrustTranscription: (input) => startTrustTranscription(client, input),
      ingestProfileVoiceNote: (input) => ingestProfileVoiceNote(client, input),
    },
  };

  const v2Session: OnboardingV2Session = {
    id: conv.id,
    user_id: conv.user_id,
    whatsapp_number: conv.whatsapp_number,
    language: conv.language,
    conversation_state: conv.conversation_state,
    state_context: conv.state_context as unknown as Record<string, unknown>,
  };

  const v2Message: OnboardingV2InboundMessage = {
    from: conv.whatsapp_number,
    body: msg.body,
    messageSid: msg.messageSid,
    interactivePayload: msg.interactivePayload,
    numMedia: msg.numMedia,
    mediaUrl: msg.mediaUrl,
    mediaSid: msg.mediaSid,
    mediaContentType: msg.mediaContentType,
    voiceEvent: voiceEvent ?? undefined,
  };

  const result = await routeOnboardingV2(client, v2Session, v2Message, v2Deps);

  if (result.handled) {
    // The router mutates state_context in place (trust questions, prompt
    // cooldowns, ...). Persist it in the same transaction for the next turn.
    await updateConversation(client, conv.id, {
      state_context: v2Session.state_context as unknown as ProfileStateContext,
    });
    return result.workerId;
  }

  // Ready workers continue through the established idle command/callback
  // router below. Persist that compatibility state atomically with the v2
  // context so the conversation row itself — not just this in-memory
  // `conv` — stays consistent with what the idle command router below (and
  // the next inbound message) expects to read.
  await updateConversation(client, conv.id, {
    state_context: v2Session.state_context as unknown as ProfileStateContext,
    user_id: result.workerId,
    language: v2Session.language,
    conversation_state: 'idle',
  });

  conv.user_id = result.workerId;
  conv.conversation_state = 'idle';
  conv.language = v2Session.language;
  conv.state_context = v2Session.state_context as unknown as ProfileStateContext;

  const from = msg.from;

  // Answer typed commands/messages in the language the worker used, regardless
  // of the language they onboarded in. Only for TYPED text — button and
  // interactive taps carry language-agnostic payloads, so they keep the stored
  // language. Scoped to `idle` (post-onboarding) so the onboarding language
  // flow is untouched. Persisted so later taps (accept/decline) stay in the
  // same language the worker just switched to.
  if (
    !msg.buttonPayload &&
    !msg.interactivePayload &&
    conv.conversation_state === 'idle'
  ) {
    const msgLang = detectCommandLanguage(msg.body);
    if (msgLang && msgLang !== conv.language) {
      conv.language = msgLang;
      await updateConversation(client, conv.id, { language: msgLang });
    }
  }

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

  // Legal-prompt replies from READY workers (the v2 legal.review step handles
  // mid-onboarding workers above; ready workers fall through to here). The
  // relay legal prompt's buttons emit legal:accept / legal:decline, which no
  // post-onboarding parser consumed before — the loop this fixes.
  const legalReply = parseLegalReplyPayload(msg.interactivePayload ?? msg.buttonPayload);
  if (legalReply && conv.user_id) {
    if (legalReply === 'accept') {
      await recordRelayLegalAcceptance(client, conv, msg, conv.user_id, routerDeps);
    } else {
      await handleLegalDeclineFromRelay(client, conv, msg);
    }
    return conv.user_id;
  }

  const commandPayload = parseCommandPayload(msg.interactivePayload);
  if (commandPayload) {
    msg = {
      ...msg,
      body: commandPayload,
      buttonPayload: undefined,
      interactivePayload: undefined,
    };
  }

  // Task 10 (spec §6): once a worker is mid application-fill
  // (`fill_application_id` set), the fill lane gets first refusal on every
  // command that would otherwise land in the picker/help/support/profile/
  // relay/jobs router below. `handleFillMessage` implements the full escape
  // order itself (button/interactive payload, a picker digit while
  // `pending_picker` is set, CHATS/CERRAR/help/support/profile, the exact
  // jobs keyword, typed job actions, the one-turn relay-override) and
  // returns `{handled:false}` for every one of them, so a worker with no
  // fill armed never even enters this branch -- its routing below stays
  // byte-identical to before this task.
  //
  // Task 11 widens the gate to ALSO fire when only `fill_offer_application_id`
  // is set (no `fill_application_id`) -- the continue-other offer a
  // completion arm can leave behind (`sendCompletionPrompt`,
  // application-fill.ts). `handleFillMessage` resolves that case entirely
  // itself (`resolveOfferOnlyTurn`): '1'/'si'/'yes' arms the offered
  // application and prompts its first gap; anything else clears the offer
  // and returns `{handled:false}` (one-shot, no nagging) -- same fall-through
  // contract as every other `handled:false` escape below.
  const fillStateContext = conv.state_context as unknown as FillStateContext | undefined;
  const fillLaneArmed =
    typeof fillStateContext?.fill_application_id === 'string'
    || typeof fillStateContext?.fill_offer_application_id === 'string';
  if (fillLaneArmed && conv.user_id) {
    const fillResult = await handleFillMessage(client, buildFillCtx(conv), msg, buildFillDeps(conv));
    if (fillResult.handled) return conv.user_id;
    // handled:false => an escape/command/relay-override turn, or a
    // declined/one-shot continue-other offer -- fall through to the normal
    // routing below exactly as if no fill were armed.
  }

  const readyResult = await routeReadyWorkerCommands(client, conv, msg);

  // Dispatch tail (Task 10): an escape above (picker resolution, help,
  // support, profile, a CHATS/CERRAR relay, the jobs listing, a typed job
  // action, or the relay-override's one free-text pass-through) already
  // queued its OWN, unrelated reply by the time control reaches here. If the
  // fill is STILL armed, the worker's pending question would otherwise go
  // unanswered for the rest of the turn -- re-send it, cooldown-guarded by
  // the same `fill_last_prompt_at`/`REPROMPT_COOLDOWN_MS` pair
  // `promptNextStep` itself stamps, so two escapes inside the cooldown
  // window produce exactly one re-prompt. Never reached for a
  // `handled:true` seam result above (CANCELAR clears `fill_application_id`;
  // every other `handled:true` path already queued its own next-step prompt
  // this turn) -- that branch returns immediately, before `routeReadyWorkerCommands`
  // (and therefore this check) ever runs.
  if (typeof (conv.state_context as unknown as FillStateContext | undefined)?.fill_application_id === 'string') {
    await maybeRepromptFill(client, conv, msg);
  }

  return readyResult;
}

/**
 * Task 10: the picker/help/support/profile/relay/jobs router a ready
 * worker's message falls into once button-payload routing, legal-prompt
 * replies, and the command-payload unwrap (all self-identifying and
 * unrelated to the fill lane) have already had their turn. Extracted from
 * `routeMessage` so the fill-lane seam and its dispatch tail (both in
 * `routeMessage`, immediately around this call) can wrap it without
 * duplicating -- or otherwise disturbing -- the routing itself.
 */
async function routeReadyWorkerCommands(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<string | null> {
  if (conv.state_context?.pending_picker && parseDisambiguationPick(msg.body) !== null) {
    // Unbound sessions cannot pick — identity binding requires verified OTP.
    if (conv.user_id) {
      return await handlePickerResponse(client, conv, msg, conv.user_id, routerDeps);
    }
  }

  if (isHelpCommand(msg.body)) {
    await discardStalePostDraft(client, conv, msg);
    await queueInteractivePrompt(
      client,
      msg.messageSid,
      msg.from,
      buildHelpMenuInteractivePrompt(conv.language),
    );
    return null;
  }

  if (isSupportCommand(msg.body)) {
    await discardStalePostDraft(client, conv, msg);
    await handleSupportCommand(client, conv, msg);
    return null;
  }

  if (isProfileCommand(msg.body)) {
    await discardStalePostDraft(client, conv, msg);
    await handleProfileCommand(client, conv, msg);
    return null;
  }

  const textConversationAction = parseEmployerConversationTextAction(msg.body);
  if (textConversationAction) {
    return await handleEmployerConversationTextAction(client, conv, msg, textConversationAction, routerDeps);
  }

  const relayedWorkerId = await tryConversationRelay(client, conv, msg, routerDeps);
  if (relayedWorkerId) {
    return relayedWorkerId;
  }

  // The v2 branch above always forces the conversation into 'idle' before
  // falling through (either via routeOnboardingV2's handled result or the
  // forced writeback when the run isn't handled), so 'idle' is the only
  // reachable state here now that the legacy state machine is gone.
  return await handleIdle(client, conv, msg);
}

/**
 * Task 10: builds the `FillContext` for a seam/dispatch-tail call site
 * where `jobId` isn't known upfront (unlike `handleJobAction`'s accept
 * path, which already has it in hand). Safe to pass a placeholder: both
 * `handleFillMessage` and `promptNextStep`/`computeNextStep` resolve
 * `jobId` fresh from the DB before it is ever read (see `FillContext`'s own
 * jsdoc in application-fill.ts) -- this initial value only matters as a
 * fallback if that lookup somehow returns null, which cannot happen for a
 * still-valid `fill_application_id`.
 */
function buildFillCtx(conv: ConversationRow): FillContext {
  return {
    conversationId: conv.id,
    workerId: conv.user_id ?? '',
    jobId: '',
    lang: conv.language,
    stateContext: conv.state_context as unknown as Record<string, unknown>,
  };
}

/**
 * Task 10 dispatch-tail helper: re-sends the CURRENT fill step's prompt,
 * cooldown-guarded by `fill_last_prompt_at`/`REPROMPT_COOLDOWN_MS` (the same
 * pair `sendNextStepPrompt`, application-fill.ts, itself stamps on every
 * prompt it sends) so two escapes inside the cooldown window produce
 * exactly one re-prompt.
 */
async function maybeRepromptFill(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<void> {
  const stateContext = conv.state_context as unknown as FillStateContext;
  const lastPromptAt = stateContext.fill_last_prompt_at;
  if (typeof lastPromptAt === 'number' && Date.now() - lastPromptAt < REPROMPT_COOLDOWN_MS) {
    return;
  }
  await promptNextStep(client, buildFillCtx(conv), msg.messageSid, msg.from, buildFillDeps(conv));
}

// Processor-owned mutations injected into the conversation router module.
const routerDeps: RouterDeps = {
  updateConversation,
  queueLegalPrompt,
  recordLegalAcceptance: recordCanonicalWhatsAppConsent,
  requiredLegalVersion: process.env.REQUIRED_TOS_VERSION ?? '1.0',
  // Task 15 (step 4.3): conversation-router.ts's single focus-arming set
  // site (setFocusedConversation) calls this to discard a dormant post
  // draft the moment a real employer thread gets focused. `conv.whatsapp_number`
  // stands in for the inbound message's `from` here (see `reconcileUserRow`'s
  // own `from: conv.whatsapp_number` precedent above) since the router only
  // has `messageSid` in hand at that call site, not the full inbound message.
  discardActivePostDraft: (client, conv, messageSid, from) =>
    discardStalePostDraft(client, conv, { from, messageSid }),
};

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
      throw new Error('reconcile_placeholder_has_dependents');
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
    const reconciled = await client.query<{ user_id: string }>(
      'SELECT reconcile_worker_signup($1, $2, $3) AS user_id',
      [realSub, whatsappNumber, ''],
    );
    const userId = reconciled.rows[0]?.user_id;
    if (!userId) {
      throw new Error('reconcileUserRow: verified worker reconciliation returned no user');
    }
    const linked = await client.query<{ id: string; tos_version: string | null }>(
      `UPDATE users
          SET whatsapp_number = $2,
              whatsapp_linked_at = now()
        WHERE id = $1
          AND cognito_sub = $3
          AND user_type = 'worker'
        RETURNING id, tos_version`,
      [userId, whatsappNumber, realSub],
    );
    if ((linked.rowCount ?? 0) === 0) {
      throw new Error('reconcileUserRow: verified worker linkage failed');
    }
    return {
      userId: linked.rows[0].id,
      tosVersion: linked.rows[0].tos_version,
    };
  }
  return {
    userId: promoted.rows[0].id,
    tosVersion: promoted.rows[0].tos_version,
  };
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
  trust_assessment_profession_key: string | null;
  trust_assessment_status: string | null;
  trust_assessment_answers: unknown;
  trust_assessment_questions: unknown;
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

// ── idle — handle Jobs keyword + button callbacks ───────────────
async function handleIdle(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<string | null> {
  // ── Media board post lane (spec 2026-08-22 v2) ─────────────────────
  // Runs before the voice-note gate below: the lane's own category check
  // (Task 14) is what actually decides photo vs. not, so an idle voice note
  // still reaches the `voice_note_not_supported` reply just below with no
  // download or Twilio-secret fetch (handlePostLaneMessage returns
  // `handled: false` for it immediately, before touching `client` or
  // `deps.downloadMedia`).
  //
  // C2 (final-review, forward draft <-> relay gap): a worker with a focused
  // employer thread (`focused_job_conversation_id`) must NEVER enter this
  // lane -- `tryConversationRelay` only relays messages with a non-empty
  // body (see its own `if (!msg.body.trim()) return null;` guard at the top
  // of conversation-router.ts), so an empty-body photo sails straight past
  // relay into `handleIdle` even while focused. Without this guard the lane
  // would start a draft here, and the bot's own solicited caption/classify
  // reply text would then be treated as the worker's NEXT message and
  // relayed straight to the employer. Same reasoning for `pending_picker`
  // (spec §4's entry predicate, finding I1(b)): a worker mid disambiguation/
  // chats-picker/close-reason pick is also mid a structured-input flow that
  // owns their next reply, so the post lane must not race it for a photo
  // sent in that window either.
  const postLaneStateContext = (conv.state_context ?? {}) as unknown as Record<string, unknown>;
  if (conv.user_id && !conv.focused_job_conversation_id && !postLaneStateContext.pending_picker) {
    const stateContext = postLaneStateContext;
    const postCtx: PostCtx = {
      conversationId: conv.id,
      workerId: conv.user_id,
      lang: conv.language,
      from: msg.from,
      inboundSid: msg.messageSid,
      stateContext,
    };
    const hasDraft = Boolean(stateContext.post_draft);
    if (hasDraft && (isJobsKeyword(msg.body) || parseTypedJobAction(msg.body) !== null)) {
      // A reserved command takes precedence over a dormant draft — discard
      // it (with notice) and fall through to the command below rather than
      // returning, so e.g. "trabajos" both clears the stale draft AND still
      // lists jobs this same turn.
      await discardActiveDraft(client, makePostDeps(conv), postCtx);
    } else {
      const r = await handlePostLaneMessage(client, makePostDeps(conv), postCtx, {
        numMedia: msg.numMedia,
        mediaUrl: msg.mediaUrl,
        mediaContentType: msg.mediaContentType,
        body: msg.body,
        buttonPayload: msg.buttonPayload,
        interactivePayload: msg.interactivePayload,
      });
      if (r.handled) return null;
    }
  }

  // Idle (post-onboarding, ready) workers have no voice handler at all —
  // give the honest "not supported here" reply rather than an unrelated
  // idle_help fallback that never mentions why the voice note went nowhere.
  // A CAPTIONED photo (or a photo tapped alongside an interactive/button
  // payload) must fall through to the ordinary command handling below —
  // only a genuinely empty-bodied, non-interactive media message (a real
  // voice note) is voice-note copy. Without this, a ready worker's photo
  // captioned with a jobs command would get the voice-note reply instead of
  // the command it typed.
  if (msg.numMedia > 0 && (msg.body ?? '').trim().length === 0 && !msg.interactivePayload && !msg.buttonPayload) {
    await reply(client, msg, 'voice_note_not_supported', conv.language);
    return null;
  }

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
    // Same city semantics as the web feed (worker-jobs-list): a worker with
    // preferred cities sees those first, topped up with out-of-city jobs when
    // the cities run short. WhatsApp has no "other jobs" section header, so
    // the fill is appended -- each job template shows its own location.
    const preferredCities = await loadWorkerPreferredCities(client, conv.user_id);
    const cityKeys = preferredCities.map((row) => row.city_key);
    const cityAnchors = cityAnchorsFrom(preferredCities);
    let jobs = await listMatchedJobsForWorker(client, conv.user_id, {
      limit: 5,
      channel: 'whatsapp',
      ...(cityKeys.length > 0 ? { cityKeys } : {}),
      ...(cityAnchors.length > 0 ? { cityAnchors } : {}),
    });
    if (cityKeys.length > 0 && jobs.length < 5) {
      const fallback = await listMatchedJobsForWorker(client, conv.user_id, {
        limit: 5,
        channel: 'whatsapp',
        excludeCityKeys: cityKeys,
        ...(cityAnchors.length > 0 ? { cityAnchors } : {}),
      });
      // The referral pin is fetched by id with no city filter, so it can come
      // back from both queries -- never send the same job twice.
      const seen = new Set(jobs.map((job) => job.id));
      jobs = [...jobs, ...fallback.filter((job) => !seen.has(job.id))].slice(0, 5);
    }
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

  // Conversation relay now runs in routeMessage (tryConversationRelay) before
  // handleIdle is reached. Reserved keywords (JOBS) and typed job actions fall
  // through to here; everything else is the idle help fallback.
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

/**
 * Task 9: real `FillDeps` wiring for `handleJobAction`'s accept path -- the
 * only call site that arms the application-fill flow today (Task 10's
 * dispatch tail is a separate, not-yet-wired seam). Built fresh per accept
 * (cheap: `makeBedrockExtractionClient`/`downloadMedia` are never actually
 * invoked during arming -- only text prompts go out here -- so there is no
 * real cost to not memoizing this at module scope).
 *
 * `updateStateContext`'s contract (application-fill.ts's `FillDeps` jsdoc,
 * binding) is BOTH a DB write AND an in-place mutation of `conv.state_context`
 * -- the closure below captures `conv` so a second read of `conv.state_context`
 * later in the SAME turn (e.g. this function's own anchor-switch check, or a
 * later call into `sendNextStepPrompt`) sees the patched value without a
 * second DB round trip. `updateConversation`'s `state_context` column write
 * is a full JSONB replace (see that function), so the merge happens here,
 * not there.
 *
 * Bug fix (Task 11 review, Critical): this MUST mutate the existing
 * `conv.state_context` object via `Object.assign`, never REASSIGN
 * `conv.state_context` to a freshly spread object. `buildFillCtx` captures
 * `stateContext: conv.state_context` (a reference) onto `FillContext` at the
 * START of the turn; a reassignment here (`conv.state_context = {...}`)
 * only repoints `conv`'s OWN property, leaving every already-built
 * `FillContext.stateContext` -- e.g. `resolveOfferOnlyTurn`'s `ctx`, still
 * in scope for its own `promptNextStep` call right after this write --
 * aliased to the STALE pre-patch object. That is exactly how the offer-
 * acceptance turn broke in production: the accept write set
 * `fill_application_id` for the first time this turn, `ctx.stateContext`
 * kept pointing at the old object that never had it, and the immediately
 * following `promptNextStep` read `ctx.stateContext.fill_application_id`
 * as `undefined` -- `computeNextStep(client, undefined)`'s `WHERE ja.id =
 * NULL` then legitimately found no row and exited the worker as
 * `application_gone`. `Object.assign(target, patch)` overwrites a key even
 * when `patch`'s value is `null` (identical to what the old spread did --
 * `null` is just another enumerable value), so patch semantics are
 * unchanged; only object IDENTITY is preserved now.
 *
 * Task 15: extracted so the media-board post lane (`makePostDeps`) shares
 * the exact same mutate-in-place contract -- both lanes read/write the same
 * `conv.state_context` object within one turn, so an update from either lane
 * must be visible to the other without a second DB round trip.
 */
function makeStateContextUpdater(conv: ConversationRow) {
  return async (client: PoolClient, conversationId: string, patch: Record<string, unknown>): Promise<void> => {
    // Defensive only (the DB column defaults to '{}', so this should
    // never actually be null/undefined in practice) -- if it somehow
    // were, this establishes the real, mutable object IN PLACE OF the
    // missing one, once, so every FillContext already built against
    // `conv.state_context` before this call still ends up sharing it.
    if (!conv.state_context) conv.state_context = {} as unknown as ProfileStateContext;
    const target = conv.state_context as unknown as Record<string, unknown>;
    Object.assign(target, patch);
    await updateConversation(client, conversationId, { state_context: target as unknown as ProfileStateContext });
  };
}

/**
 * Task 15: real `PostDeps` wiring for the media-board post lane
 * (post-creation.ts), mirroring `buildFillDeps`'s shape -- built fresh per
 * call site (I/O-free construction: `downloadMedia`'s Twilio secret fetch is
 * lazy, exactly like `buildFillDeps`' own `downloadMedia`, so building this
 * at every discard site below is cheap). No secret is threaded in as a
 * parameter -- `getTwilioSecret` is module-cached (see its definition above),
 * so the lazy fetch inside `downloadMedia` costs at most one Secrets Manager
 * call per invocation, shared with every other lane that also calls
 * `getTwilioSecret` this turn.
 */
function makePostDeps(conv: ConversationRow): PostDeps {
  return {
    queueReplyText: (client, inboundSid, to, body) => queueOutboxText(client, inboundSid, to, body),
    queueInteractivePrompt: (client, inboundSid, to, prompt) => queueInteractivePrompt(client, inboundSid, to, prompt),
    updateStateContext: makeStateContextUpdater(conv),
    setRls: setInternalUserRlsContext,
    downloadMedia: async (mediaUrl: string) => {
      const twilioSecret = await getTwilioSecret();
      return downloadTwilioMediaBounded(mediaUrl, twilioSecret.accountSid, twilioSecret.authToken, MAX_POST_PHOTO_BYTES);
    },
    uploadMedia: (key, body, contentType) => uploadMediaToS3(process.env.MEDIA_BUCKET_NAME!, key, body, contentType),
    moderate: (s3Key, versionId) => moderateImage(process.env.MEDIA_BUCKET_NAME!, s3Key, versionId),
    nowMs: () => Date.now(),
    newId: () => randomUUID(),
  };
}

/**
 * Task 15: builds the `PostCtx` a post-lane discard site needs from
 * whatever minimal (from, messageSid) pair it has in hand -- both the full
 * `IncomingMessage` (routeReadyWorkerCommands' branches, handleIdle) and
 * `handleJobAction`'s bare `{ from, inboundMessageSid }` params satisfy this
 * shape structurally, so one helper covers every call site.
 */
function postCtxFor(conv: ConversationRow, msg: { from: string; messageSid: string }): PostCtx {
  return {
    conversationId: conv.id,
    workerId: conv.user_id ?? '',
    lang: conv.language,
    from: msg.from,
    inboundSid: msg.messageSid,
    stateContext: (conv.state_context ?? {}) as unknown as Record<string, unknown>,
  };
}

/**
 * Task 15 (step 4.1/4.2 discard sites): a matched worker command or a fresh
 * fill-arm both mean the worker has moved on from the photo-drafting flow --
 * a dormant `post_draft` left behind would otherwise sit forever with no way
 * to complete or discard it (Task 14's lane only re-enters via `handleIdle`),
 * or worse, silently eat the next photo/caption the worker sends for the
 * command/fill they just invoked. Guarded so this is a true no-op (no query,
 * no notice) when there is no draft to discard -- the overwhelmingly common
 * case.
 */
async function discardStalePostDraft(
  client: PoolClient,
  conv: ConversationRow,
  msg: { from: string; messageSid: string },
): Promise<void> {
  if ((conv.state_context as unknown as Record<string, unknown> | null)?.post_draft) {
    await discardActiveDraft(client, makePostDeps(conv), postCtxFor(conv, msg));
  }
}

function buildFillDeps(conv: ConversationRow): FillDeps {
  return {
    extraction: makeBedrockExtractionClient(),
    queueReplyText: (client, inboundSid, to, body) => queueOutboxText(client, inboundSid, to, body),
    setRls: setInternalUserRlsContext,
    updateStateContext: makeStateContextUpdater(conv),
    nowMs: () => Date.now(),
    downloadMedia: async (mediaUrl: string) => {
      const twilioSecret = await getTwilioSecret();
      return downloadTwilioMediaBounded(mediaUrl, twilioSecret.accountSid, twilioSecret.authToken, MAX_DOCUMENT_BYTES);
    },
    documentsBucket: process.env.DOCUMENTS_BUCKET!,
  };
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
    location: string;
    pay_min: number | null; pay_max: number | null; pay_interval: string | null;
    pay_raw: string | null;
    required_fields: string[] | null;
    optional_fields: string[] | null;
  }>(
    `SELECT id,
            title,
            COALESCE(company, 'Jale') AS company,
            location,
            pay_min,
            pay_max,
            pay_interval,
            pay AS pay_raw,
            required_fields,
            optional_fields
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
  const workerId = conv.user_id;

  if (action === 'accept') {
    const applyResult = await applyWorkerToJob(client, {
      workerId,
      jobId,
      surface: 'whatsapp',
    });

    if (applyResult.status === 'applied' || applyResult.status === 'already_applied') {
      const applicationId = (applyResult.application as { id: string }).id;
      // Captured BEFORE the arm write below mutates conv.state_context --
      // this is what makes a mid-fill accept on a DIFFERENT application a
      // "switch" (spec §6 item 8 / task brief requirement 3). fill_* keys
      // are not part of ProfileStateContext's typed shape (they belong to
      // this feature's own loose Record<string, unknown> convention -- see
      // FillContext's jsdoc in application-fill.ts), hence the cast.
      const previousApplicationId = (conv.state_context as unknown as Record<string, unknown> | undefined)
        ?.fill_application_id as string | undefined;

      const deps = buildFillDeps(conv);
      const ctx: FillContext = {
        conversationId: conv.id,
        workerId,
        jobId,
        lang: conv.language,
        // fill_application_id is set here on the in-memory ctx (not yet
        // persisted) so seedAnswersFromDefaults' merge choke point --
        // reused from the same code path handleFillMessage uses -- can
        // resolve the target application before the real arm write below.
        stateContext: {
          ...(conv.state_context as unknown as Record<string, unknown>),
          fill_application_id: applicationId,
        },
      };

      await seedAnswersFromDefaults(
        client,
        ctx,
        job.rows[0].required_fields ?? [],
        job.rows[0].optional_fields ?? [],
        deps,
      );

      const nextStep = await computeNextStep(client, applicationId);

      if (nextStep.kind === 'field' || nextStep.kind === 'doc') {
        // Task 15 (step 4.2): arming the fill here means the worker is about
        // to answer field/doc prompts with free text and photos -- a
        // dormant post-board draft left over from before this accept would
        // otherwise sit forever (this arm point is reachable straight from
        // a job-alert BUTTON tap, which never passes through handleIdle's
        // own discard hook above).
        await discardStalePostDraft(client, conv, { from, messageSid: inboundMessageSid });

        // Arm (or re-arm/switch) the fill. Anchor-switch scrub (Task 8
        // forward note): pending_picker/fill_pending/fill_cert_more_pending
        // are cleared unconditionally at every fill entry, whether this is
        // a fresh arm, a same-application re-arm, or a switch to a
        // different application. FINAL-REVIEW Finding 1a/3:
        // fill_relay_override/fill_offer_application_id are cleared here too
        // -- this arm write is itself a fill ENTRY point, so a stale
        // override or offer id left over from a previous fill's exit (or
        // from before this fix, any exit at all) must not survive into the
        // freshly-armed fill and swallow the worker's first answer here.
        await deps.updateStateContext(client, conv.id, {
          fill_application_id: applicationId,
          pending_picker: null,
          fill_pending: null,
          fill_cert_more_pending: null,
          fill_relay_override: null,
          fill_offer_application_id: null,
        });

        const isSwitch = previousApplicationId !== undefined && previousApplicationId !== applicationId;
        if (isSwitch) {
          await queueText(client, inboundMessageSid, from, fillMessage('switched_job', conv.language));
        }

        const counts = await countRemainingRequirements(client, applicationId);
        let introBody = fillMessage('intro', conv.language, {
          n_fields: String(counts.nFields),
          n_docs: String(counts.nDocs),
        });
        if (nextStep.uncollectable.length > 0) {
          introBody += `\n\n${fillMessage('web_handoff', conv.language, {
            doc: localizeDocList(nextStep.uncollectable, conv.language),
          })}`;
        }
        await queueText(client, inboundMessageSid, from, introBody);

        await promptNextStep(client, ctx, inboundMessageSid, from, deps);
        return;
      }

      // No collectable gaps remain -- legacy behavior exactly as today, fill
      // NOT armed.
      await queueReply(
        client,
        inboundMessageSid,
        from,
        applyResult.status === 'applied' ? 'job_accepted' : 'job_already_applied',
        conv.language,
      );
    } else if (applyResult.status === 'guard_blocked') {
      // 'generic_error' does not exist in templates.ts / the TemplateKey
      // union queueReply is typed on -- this comes from the fill-prompts
      // module via the outbox text helper instead.
      await queueText(client, inboundMessageSid, from, fillMessage('guard_error', conv.language));
    } else {
      // applyWorkerToJob can still return job_closed/forbidden/
      // certification_document_limit (none reachable for whatsapp's
      // bypassed answers/cert-claims gates, but forbidden/job_closed remain
      // possible races) -- same fallback the pre-Task-9 code used for every
      // non-applied/already_applied/guard_blocked status. `missing_documents`
      // is never reachable here (applyWorkerToJob's surface==='whatsapp'
      // branch bypasses that gate entirely -- see applications.ts).
      await queueReply(client, inboundMessageSid, from, 'job_not_found', conv.language);
    }
  } else if (action === 'decline') {
    await queueReply(client, inboundMessageSid, from, 'job_declined', conv.language);
  } else {
    const r = job.rows[0];
    const recentIndex = conv.state_context?.recent_jobs?.indexOf(jobId) ?? -1;
    const commandIndex = recentIndex >= 0 ? recentIndex + 1 : 1;
    const pay = localizedJobPay(r, conv.language);
    await queueText(
      client,
      inboundMessageSid,
      from,
      conv.language === 'es'
        ? `Detalles del trabajo\n\n${r.title}\n${r.company}\n${r.location}\n${pay}\n\nResponde "${commandIndex} aceptar" para aplicar.`
        : `Job details\n\n${r.title}\n${r.company}\n${r.location}\n${pay}\n\nReply "${commandIndex} accept" to apply.`,
    );
  }
}

// localizeDocList moved to lib/application-fill.ts (Task 11) so its
// completion-arm `web_handoff` append can reuse the same labels/fallback
// this intro-arm append (above) uses -- imported at the top of this file.
