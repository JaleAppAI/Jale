/**
 * WhatsApp support mode (sprint 28).
 *
 * SOPORTE / SUPPORT puts a conversation in support mode: every message and
 * attachment the worker sends goes to one help_request case, the bot stays
 * quiet, and buttons keep working. MENU, a closed case or 24 quiet hours end
 * the mode. It works for any number, registered or not, because the
 * processor asks this module first, before the onboarding engine
 * (`routeOnboardingV2`) can consume the message.
 *
 * State lives on the conversation row (`support_case_id`,
 * `support_last_activity_at`, migration 121), which only the bot writes. The
 * case side (cases, events, attachments, the admin email) is reached only
 * through migration 121's definers: the WhatsApp login holds no right on the
 * case tables.
 *
 * The decision order, for a real (not synthetic voice) inbound message:
 *   1. in the mode: MENU leaves it and the turn continues as the help
 *      command; a button or list tap, or a 6-digit code from an unregistered
 *      number at the code step (decision D-W1), goes to the bot and also
 *      leaves the mode -- the worker chose the bot, and a text answer to the
 *      bot's next question must not vanish into the case; anything else
 *      (SOPORTE again included) is added to the case with no reply;
 *   2. a mode whose case closed, or that has been quiet for 24 hours, ends
 *      (one timeline event) and the message routes on;
 *   3. a button or list tap routes as before;
 *   4. SOPORTE / SUPPORT opens or reuses the case and enters the mode;
 *   5. a free-text answer within 72 hours of an admin reply, on a case that
 *      is still open, re-enters the mode silently (decision D-W2);
 *   6. anything else routes exactly as before.
 *
 * Every way of choosing the bot -- MENU, a tap, a verifying code -- records
 * a MENU exit on the case, in the mode or not, and that exit is what stops
 * the 72-hour re-entry of rule 5 (`support_reentry_case`).
 *
 * The mode never changes the conversation's language: the keyword's language
 * is used for the entry reply and for the case, and the bot keeps its own.
 *
 * While the mode holds, the application fill and prompt lanes stay armed
 * but silent: this module answers before them, and they resume on the first
 * turn after the mode ends.
 */
import type { PoolClient } from 'pg';
import { isLikelyOtpCode, type ConversationRow, type IncomingMessage } from './conversation-router';
import { isMenuCommand, isSupportCommand, supportCommandLanguage } from './flows';
import { MAX_SUPPORT_MEDIA_BYTES, sniffSupportMedia, type SupportMediaKind } from './media';
import type { Lang } from './templates';

/** What the processor does with the turn after this module has looked at it. */
export type SupportRoute =
  /** Route the message as before; support mode did nothing with it. */
  | { kind: 'pass' }
  /** Support mode took the message; any reply is already queued. */
  | { kind: 'handled' }
  /** MENU ended the mode: route the turn as the help command. */
  | { kind: 'continue_as_help' };

export type SupportReplyKey = 'support_mode_entered' | 'support_media_unsupported' | 'v2_otp_enter_code';

export interface SupportModeDeps {
  /** Queues a plain reply to this inbound message (inside the window by construction). */
  queueReply(key: SupportReplyKey, lang: Lang): Promise<void>;
  /** An unregistered number's pre-verification step and language, or null. */
  loadPreAuth(): Promise<{ stepKey: string; language: Lang } | null>;
  /** Downloads the message's attachment, refusing more than `maxBytes`. */
  downloadMedia(mediaUrl: string, maxBytes: number): Promise<Buffer>;
  /** Stores an attachment in the support-media bucket. */
  uploadMedia(key: string, body: Buffer, contentType: SupportMediaKind['contentType']): Promise<void>;
  /** The admin console origin the new-case email links to (no trailing slash), or null. */
  adminBaseUrl: string | null;
  newId(): string;
}

/** The pre-verification step whose 6-digit codes always go to verification. */
const OTP_STEP_KEY = 'identity.verify_otp';

/** What the worker's case shows for an attachment the bot could not keep. */
export const ATTACHMENT_NOT_RECEIVED = '[attachment could not be received]';

/**
 * One round trip per inbound message: whether the conversation's support
 * case is still open, whether the mode has been quiet for 24 hours (on the
 * database clock), and the case a free-text answer would re-enter.
 */
export const SUPPORT_STATE_SQL = `SELECT s.open AS case_open,
       (wc.support_last_activity_at IS NULL
          OR wc.support_last_activity_at + interval '24 hours' <= now()) AS idle,
       public.support_reentry_case(wc.id) AS reentry_case_id
  FROM public.whatsapp_conversations wc
 CROSS JOIN LATERAL public.support_mode_state(wc.support_case_id, wc.id) AS s
 WHERE wc.id = $1`;

interface SupportState {
  caseOpen: boolean;
  idle: boolean;
  reentryCaseId: string | null;
}

async function readSupportState(client: PoolClient, conversationId: string): Promise<SupportState> {
  const result = await client.query<{ case_open: boolean; idle: boolean; reentry_case_id: string | null }>(
    SUPPORT_STATE_SQL,
    [conversationId],
  );
  const row = result.rows[0];
  return {
    caseOpen: row?.case_open === true,
    idle: row?.idle !== false,
    reentryCaseId: row?.reentry_case_id ?? null,
  };
}

async function enterMode(client: PoolClient, conv: ConversationRow, caseId: string): Promise<void> {
  await client.query(
    `UPDATE whatsapp_conversations
        SET support_case_id = $2, support_last_activity_at = now(), updated_at = now()
      WHERE id = $1`,
    [conv.id, caseId],
  );
  conv.support_case_id = caseId;
}

async function leaveMode(
  client: PoolClient,
  conv: ConversationRow,
  caseId: string,
  reason: 'menu' | 'resolved' | 'idle',
): Promise<void> {
  await client.query(
    `UPDATE whatsapp_conversations
        SET support_case_id = NULL, support_last_activity_at = NULL, updated_at = now()
      WHERE id = $1`,
    [conv.id],
  );
  conv.support_case_id = null;
  conv.support_last_activity_at = null;
  await recordModeChange(client, caseId, conv.id, false, reason);
}

async function recordModeChange(
  client: PoolClient,
  caseId: string,
  conversationId: string,
  entered: boolean,
  reason: string,
): Promise<void> {
  await client.query('SELECT public.support_record_mode_change($1, $2, $3, $4)', [caseId, conversationId, entered, reason]);
}

async function stampActivity(client: PoolClient, conv: ConversationRow): Promise<void> {
  await client.query(
    'UPDATE whatsapp_conversations SET support_last_activity_at = now(), updated_at = now() WHERE id = $1',
    [conv.id],
  );
}

interface AppendInput {
  kind: 'text' | 'media';
  text: string | null;
  media?: { s3Key: string; mediaType: string; contentType: string; byteSize: number };
}

/** False when the case closed in the meantime: nothing was written. */
async function appendMessage(
  client: PoolClient,
  conv: ConversationRow,
  caseId: string,
  input: AppendInput,
  lang: Lang,
): Promise<boolean> {
  const result = await client.query<{ appended: boolean }>(
    'SELECT appended, status_changed, media_id FROM public.support_append_message($1, $2, $3, $4, $5::jsonb, $6)',
    [caseId, conv.id, input.kind, input.text, input.media ? JSON.stringify(input.media) : null, lang],
  );
  return result.rows[0]?.appended === true;
}

/**
 * Adds the worker's message to the case: its text, or its attachment when
 * the bytes are a photo, a voice note or a PDF. Anything else, or an
 * attachment that cannot be downloaded, leaves a placeholder on the case and
 * gets the one notice the bot sends while it is quiet. `lang` is the
 * language the case records and the notice uses. Returns false when the
 * case closed in the meantime.
 */
async function addToCase(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  caseId: string,
  deps: SupportModeDeps,
  lang: Lang,
): Promise<boolean> {
  const text = msg.body.trim() === '' ? null : msg.body;
  const hasMedia = (msg.numMedia ?? 0) > 0 && Boolean(msg.mediaUrl);

  if (!hasMedia && text !== null) {
    const appended = await appendMessage(client, conv, caseId, { kind: 'text', text }, lang);
    if (appended) await stampActivity(client, conv);
    return appended;
  }

  let bytes: Buffer | null = null;
  let kind: SupportMediaKind | null = null;
  if (hasMedia) {
    try {
      bytes = await deps.downloadMedia(msg.mediaUrl as string, MAX_SUPPORT_MEDIA_BYTES);
      kind = sniffSupportMedia(bytes);
      if (!kind) console.warn(JSON.stringify({ metric: 'SupportMediaNotReceived', reason: 'unsupported_type' }));
    } catch (err) {
      console.warn(JSON.stringify({
        metric: 'SupportMediaNotReceived',
        reason: (err as { name?: string })?.name === 'MediaTooLargeError' ? 'too_large' : 'download_failed',
      }));
    }
  }

  if (bytes && kind) {
    const s3Key = `support/${caseId}/${deps.newId()}.${kind.ext}`;
    // An upload error is not the worker's file being refused: it throws, and
    // the inbound is retried while Twilio's media link is still valid.
    await deps.uploadMedia(s3Key, bytes, kind.contentType);
    const appended = await appendMessage(client, conv, caseId, {
      kind: 'media',
      text,
      media: { s3Key, mediaType: kind.mediaType, contentType: kind.contentType, byteSize: bytes.length },
    }, lang);
    if (appended) await stampActivity(client, conv);
    return appended;
  }

  // Not a photo, voice note or PDF; too large; not downloadable; or a message
  // with neither text nor an attachment (a location, a contact card).
  if (text !== null && !(await appendMessage(client, conv, caseId, { kind: 'text', text }, lang))) return false;
  if (!(await appendMessage(client, conv, caseId, { kind: 'text', text: ATTACHMENT_NOT_RECEIVED }, lang))) return false;
  await stampActivity(client, conv);
  await deps.queueReply('support_media_unsupported', lang);
  return true;
}

/** Decision D-W1: a code typed at the verification step is never support text. */
async function isCodeForVerification(
  conv: ConversationRow,
  msg: IncomingMessage,
  deps: SupportModeDeps,
): Promise<boolean> {
  if (conv.user_id || !isLikelyOtpCode(msg.body)) return false;
  return (await deps.loadPreAuth())?.stepKey === OTP_STEP_KEY;
}

/**
 * MENU's answer, in the mode or not: the help command, except at the code
 * step, where the help word would be read as a wrong code and spend an
 * attempt, so the code prompt is sent again instead.
 */
async function backToBot(conv: ConversationRow, deps: SupportModeDeps): Promise<SupportRoute> {
  const preAuth = conv.user_id ? null : await deps.loadPreAuth();
  if (preAuth?.stepKey === OTP_STEP_KEY) {
    await deps.queueReply('v2_otp_enter_code', preAuth.language);
    return { kind: 'handled' };
  }
  return { kind: 'continue_as_help' };
}

/**
 * Routes one inbound message through support mode. Never called for a
 * synthetic voice-pipeline event, which must always reach the onboarding
 * engine.
 */
export async function routeSupportMode(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  deps: SupportModeDeps,
): Promise<SupportRoute> {
  const isTap = Boolean(msg.interactivePayload || msg.buttonPayload);
  const state = await readSupportState(client, conv.id);
  const modeCaseId = conv.support_case_id ?? null;
  let closedCaseId: string | null = null;

  if (modeCaseId) {
    if (state.caseOpen && !state.idle) {
      // 1. In the mode.
      if (isMenuCommand(msg.body)) {
        await leaveMode(client, conv, modeCaseId, 'menu');
        return backToBot(conv, deps);
      }
      if (isTap || await isCodeForVerification(conv, msg, deps)) {
        // The worker chose the bot: the bot answers, and its next question
        // must not be answered into the case.
        await leaveMode(client, conv, modeCaseId, 'menu');
        return { kind: 'pass' };
      }
      if (await addToCase(client, conv, msg, modeCaseId, deps, conv.language)) return { kind: 'handled' };
      // The case closed between the state read and the append.
      closedCaseId = modeCaseId;
      await leaveMode(client, conv, modeCaseId, 'resolved');
    } else {
      // 2. The case closed, or 24 quiet hours: the mode ends, the message routes on.
      closedCaseId = state.caseOpen ? null : modeCaseId;
      await leaveMode(client, conv, modeCaseId, state.caseOpen ? 'idle' : 'resolved');
    }
  }

  // The case a free-text answer would go back to (rule 5), if any.
  const reentryCaseId = state.reentryCaseId && state.reentryCaseId !== closedCaseId ? state.reentryCaseId : null;

  // 3. Taps go to the bot; with a re-entry open, they also close it.
  if (isTap) {
    if (reentryCaseId) await recordModeChange(client, reentryCaseId, conv.id, false, 'menu');
    return { kind: 'pass' };
  }

  // 4. SOPORTE / SUPPORT, from any number at any step.
  if (isSupportCommand(msg.body)) {
    const lang = supportCommandLanguage(msg.body) ?? conv.language;
    if (!deps.adminBaseUrl) console.warn(JSON.stringify({ metric: 'SupportAdminEmailSkipped' }));
    const opened = await client.query<{ case_id: string; created: boolean }>(
      'SELECT case_id, created FROM public.support_open_case($1, $2, $3, $4, $5)',
      [conv.id, conv.user_id, lang, msg.body, deps.adminBaseUrl],
    );
    const caseId = opened.rows[0]?.case_id;
    if (!caseId) throw new Error('support_open_case returned no row');
    await enterMode(client, conv, caseId);
    await recordModeChange(client, caseId, conv.id, true, 'command');
    // A photo sent with the keyword as its caption still reaches the case.
    if ((msg.numMedia ?? 0) > 0 && msg.mediaUrl) {
      await addToCase(client, conv, { ...msg, body: '' }, caseId, deps, lang);
    }
    await deps.queueReply('support_mode_entered', lang);
    return { kind: 'handled' };
  }

  // 5. A free-text answer to a recent admin reply goes back to the team.
  if (reentryCaseId) {
    if (isMenuCommand(msg.body)) {
      // MENU outside the mode: the worker chose the bot, so the next typed
      // command must reach it too.
      await recordModeChange(client, reentryCaseId, conv.id, false, 'menu');
      return backToBot(conv, deps);
    }
    if (await isCodeForVerification(conv, msg, deps)) {
      await recordModeChange(client, reentryCaseId, conv.id, false, 'menu');
      return { kind: 'pass' };
    }
    await enterMode(client, conv, reentryCaseId);
    await recordModeChange(client, reentryCaseId, conv.id, true, 'reentry');
    if (await addToCase(client, conv, msg, reentryCaseId, deps, conv.language)) return { kind: 'handled' };
    await leaveMode(client, conv, reentryCaseId, 'resolved');
  }

  // 6. Everything else routes as before.
  return { kind: 'pass' };
}
