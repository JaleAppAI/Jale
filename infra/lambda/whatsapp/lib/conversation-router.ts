// infra/lambda/whatsapp/lib/conversation-router.ts
//
// Conversation relay routing for employer<->worker job messaging.
// Extracted from processor.ts (Phase 1 of docs/job-messaging-v2-plan.md).
// Processor-owned mutations (updateConversation, queueLegalPrompt) are
// injected via RouterDeps so this module stays unit-testable without the
// processor's mocks.

import type { PoolClient } from 'pg';
import { setInternalUserRlsContext } from '../../lib/db';
import {
  declineLatestWorkerConversationFromButtonText,
  declineWorkerConversationFromButton,
  openLatestWorkerConversationFromButtonText,
  openWorkerConversationFromButton,
  recordWorkerConversationReply,
  type ThreadOption,
} from '../../lib/job-messaging';
import { queueOutboxText } from './outbox';
import { detectLanguage, t, type Lang } from './templates';
import type { ConversationState, ProfileStateContext } from './flows';

// ── Conversation row shape (subset of the DB columns) ───────────
//
// Single source of truth for the conversation row shape. The processor
// imports this type rather than redefining it. Mirrors the real DB columns
// the processor selects, plus `focused_job_conversation_id` (migration 026,
// written but not yet applied — runtime reads tolerate undefined/null).
export interface ConversationRow {
  id: string;
  user_id: string | null;
  whatsapp_number: string;
  language: Lang;
  conversation_state: ConversationState;
  state_context: ProfileStateContext;
  otp_attempts: number;
  otp_expires_at: Date | null;
  last_processed_message_sid: string | null;
  focused_job_conversation_id: string | null;
}

// ── Inbound message shape ───────────────────────────────────────
export interface IncomingMessage {
  body: string;
  buttonPayload: string | undefined;
  interactivePayload: string | undefined;
  messageSid: string;
  from: string;
  numMedia: number;
  mediaUrl: string | undefined;
  mediaSid: string | undefined;
  mediaContentType: string | undefined;
}

// ── Processor-owned mutations injected into this module ─────────
export interface RouterDeps {
  updateConversation(
    client: PoolClient,
    conversationId: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  queueLegalPrompt(
    client: PoolClient,
    inboundMessageSid: string,
    to: string,
    lang: Lang,
  ): Promise<void>;
}

export function isLikelyOtpCode(body: string): boolean {
  return /^\s*\d{6}\s*$/.test(body);
}

/**
 * Legal wall (V2 plan §4.5): messaging is compliance-gated.
 *
 * Gates on `tos_version`, NOT `tos_accepted_at`: the WhatsApp Lambdas connect
 * as the `jale_whatsapp` DB role, which migration 004_whatsapp.sql grants
 * column-scoped SELECT on `users` for `tos_version` but NOT for
 * `tos_accepted_at` (that column is in the UPDATE grant only). A
 * `SELECT tos_accepted_at` as jale_whatsapp throws permission-denied at
 * runtime. `tos_version` is set together with `tos_accepted_at` when a worker
 * accepts, so it is a safe, SELECT-granted proxy for "has accepted". Per the
 * plan this is any accepted ToS, not version-currency.
 */
async function workerHasAcceptedTos(client: PoolClient, workerId: string): Promise<boolean> {
  const r = await client.query<{ tos_version: string | null }>(
    `SELECT tos_version FROM users WHERE id = $1`, [workerId]);
  return !!r.rows[0]?.tos_version;
}

export function parseEmployerConversationTextAction(body: string): 'open' | 'decline' | null {
  const normalized = body.trim().toLowerCase();
  if (['abrir', 'abrir conversacion', 'open', 'open conversation', 'accept'].includes(normalized)) {
    return 'open';
  }
  if (['rechazar', 'no me interesa', 'decline', 'not interested'].includes(normalized)) {
    return 'decline';
  }
  return null;
}

export async function resolveWorkerIdForWhatsappNumber(
  client: PoolClient,
  whatsappNumber: string,
): Promise<string | null> {
  const normalized = whatsappNumber.replace(/^whatsapp:/, '');
  // Identity binding surface: ONLY Cognito-verified phone fields.
  // worker_profiles.phone is worker-editable and unverified (V2 plan §4.2a).
  const result = await client.query<{ id: string }>(
    `SELECT u.id
       FROM users u
      WHERE u.user_type = 'worker'
        AND (u.whatsapp_number = $1 OR u.phone = $1)
      ORDER BY CASE WHEN u.whatsapp_number = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [normalized],
  );
  return result.rows[0]?.id ?? null;
}

export async function routeEmployerConversationReplyOverride(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  deps: RouterDeps,
): Promise<string | null> {
  if (conv.conversation_state !== 'awaiting_otp') return null;
  if (!msg.body.trim() || isLikelyOtpCode(msg.body)) return null;

  const workerId = conv.user_id ?? await resolveWorkerIdForWhatsappNumber(client, msg.from);
  if (!workerId) return null;

  await setInternalUserRlsContext(client, workerId);
  const result = await recordWorkerConversationReply(
    client,
    workerId,
    msg.body,
    msg.from,
    msg.messageSid,
    conv.state_context?.active_job_conversation_id,
  );
  if (result.status !== 'routed') return null;

  await deps.updateConversation(client, conv.id, {
    user_id: workerId,
    conversation_state: 'idle',
    state_context: {},
    otp_attempts: 0,
    otp_expires_at: null,
    last_processed_message_sid: msg.messageSid,
  });
  conv.user_id = workerId;
  conv.conversation_state = 'idle';
  conv.state_context = {};
  conv.otp_attempts = 0;
  conv.otp_expires_at = null;

  return workerId;
}

export async function resetWhatsappConversationToIdle(
  client: PoolClient,
  conv: ConversationRow,
  workerId: string,
  messageSid: string,
  stateContext: ProfileStateContext,
  deps: RouterDeps,
): Promise<void> {
  await deps.updateConversation(client, conv.id, {
    user_id: workerId,
    conversation_state: 'idle',
    state_context: stateContext,
    otp_attempts: 0,
    otp_expires_at: null,
    last_processed_message_sid: messageSid,
  });
  conv.user_id = workerId;
  conv.conversation_state = 'idle';
  conv.state_context = stateContext;
  conv.otp_attempts = 0;
  conv.otp_expires_at = null;
}

export async function handleEmployerConversationButton(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  payload: { action: 'open' | 'decline'; conversationId: string },
  deps: RouterDeps,
): Promise<string | null> {
  const workerId = conv.user_id ?? await resolveWorkerIdForWhatsappNumber(client, msg.from);
  if (!workerId) {
    await queueOutboxText(client, msg.messageSid, msg.from, t('start_prompt', detectLanguage(msg.body)));
    return null;
  }

  await setInternalUserRlsContext(client, workerId);

  if (payload.action === 'decline') {
    const declined = await declineWorkerConversationFromButton(
      client,
      workerId,
      payload.conversationId,
    );
    if (declined) {
      await resetWhatsappConversationToIdle(client, conv, workerId, msg.messageSid, {}, deps);
      await queueOutboxText(
        client,
        msg.messageSid,
        msg.from,
        conv.language === 'en'
          ? 'Conversation closed. You can keep using Jale here.'
          : 'Conversacion cerrada. Puedes seguir usando Jale aqui.',
      );
    }
    return null;
  }

  // Legal wall (V2 plan §4.5): opening a conversation relays the worker into
  // an employer thread, so it is compliance-gated. (Decline is NOT gated — a
  // worker can always decline without consent.)
  if (!(await workerHasAcceptedTos(client, workerId))) {
    await deps.queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
    console.log(JSON.stringify({ metric: 'ConversationOpenLegalHold', workerId }));
    return workerId;
  }

  const opened = await openWorkerConversationFromButton(
    client,
    workerId,
    payload.conversationId,
    msg.from,
  );
  if (!opened.found) return null;

  await resetWhatsappConversationToIdle(client, conv, workerId, msg.messageSid, {
    active_job_conversation_id: opened.conversationId ?? payload.conversationId,
  }, deps);
  if (opened.queuedMessages === 0) {
    await queueOutboxText(
      client,
      msg.messageSid,
      msg.from,
      conv.language === 'en'
        ? 'Conversation opened. Reply here to message the employer.'
        : 'Conversacion abierta. Responde aqui para escribirle al empleador.',
    );
  }

  return workerId;
}

export async function handleEmployerConversationTextAction(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  action: 'open' | 'decline',
  deps: RouterDeps,
): Promise<string | null> {
  const workerId = conv.user_id ?? await resolveWorkerIdForWhatsappNumber(client, msg.from);
  if (!workerId) return null;

  await setInternalUserRlsContext(client, workerId);

  if (action === 'decline') {
    const declined = await declineLatestWorkerConversationFromButtonText(client, workerId);
    if (!declined) return null;
    await resetWhatsappConversationToIdle(client, conv, workerId, msg.messageSid, {}, deps);
    await queueOutboxText(
      client,
      msg.messageSid,
      msg.from,
      conv.language === 'en'
        ? 'Conversation closed. You can keep using Jale here.'
        : 'Conversacion cerrada. Puedes seguir usando Jale aqui.',
    );
    return null;
  }

  // Legal wall (V2 plan §4.5): opening a conversation is compliance-gated;
  // decline (above) is not.
  if (!(await workerHasAcceptedTos(client, workerId))) {
    await deps.queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
    console.log(JSON.stringify({ metric: 'ConversationOpenLegalHold', workerId }));
    return workerId;
  }

  const opened = await openLatestWorkerConversationFromButtonText(client, workerId, msg.from);
  if (!opened.found) return null;

  await resetWhatsappConversationToIdle(client, conv, workerId, msg.messageSid, {
    active_job_conversation_id: opened.conversationId,
  }, deps);
  if (opened.queuedMessages === 0) {
    await queueOutboxText(
      client,
      msg.messageSid,
      msg.from,
      conv.language === 'en'
        ? 'Conversation opened. Reply here to message the employer.'
        : 'Conversacion abierta. Responde aqui para escribirle al empleador.',
    );
  }

  return workerId;
}

// ── Disambiguation flow ─────────────────────────────────────────

const PENDING_RELAY_TTL_MS = 60 * 60 * 1000; // 1h — stale buffered text is dropped

function sanitizeLabel(value: string | null | undefined, max = 40): string {
  return (value ?? '').replace(/[\r\n\t -]/g, ' ').trim().slice(0, max) || 'Empleador';
}

export function parseDisambiguationPick(body: string): number | null {
  const m = body.trim().match(/^\d{1,2}$/);
  return m ? Number(m[0]) : null;
}

function disambiguationPromptBody(threads: ThreadOption[], lang: Lang): string {
  const header = lang === 'en'
    ? 'You have several open conversations. Who do you want to reply to? Send the number:'
    : 'Tienes varias conversaciones abiertas. ¿A quién quieres responder? Envía el número:';
  const lines = threads.map((t, i) =>
    `${i + 1}. ${sanitizeLabel(t.companyName)} — ${sanitizeLabel(t.jobTitle)}`);
  return [header, ...lines].join('\n');
}

/**
 * Free-text relay for a resolved worker. Returns workerId when the message
 * was handled (routed OR disambiguation prompt sent), null to fall through.
 */
export async function relayWorkerFreeText(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  workerId: string,
  deps: RouterDeps,
): Promise<string | null> {
  // Legal wall (V2 plan §4.5): messaging is compliance-gated. Workers who
  // never accepted (or declined) the ToS get the legal prompt, not a relay.
  if (!(await workerHasAcceptedTos(client, workerId))) {
    await deps.queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
    console.log(JSON.stringify({ metric: 'ConversationRelayLegalHold', workerId }));
    return workerId; // handled — do not fall through to onboarding replies
  }

  await setInternalUserRlsContext(client, workerId);
  const result = await recordWorkerConversationReply(
    client, workerId, msg.body, msg.from, msg.messageSid,
    conv.focused_job_conversation_id,
  );
  if (result.status === 'routed') {
    if (conv.focused_job_conversation_id !== result.conversationId) {
      await deps.updateConversation(client, conv.id, {
        focused_job_conversation_id: result.conversationId,
        last_processed_message_sid: msg.messageSid,
      });
      conv.focused_job_conversation_id = result.conversationId;
    }
    return workerId;
  }
  if (result.status === 'ambiguous') {
    await deps.updateConversation(client, conv.id, {
      state_context: {
        ...(conv.state_context ?? {}),
        conversation_disambiguation: {
          threads: result.threads,
          pending: { body: msg.body, messageSid: msg.messageSid, ts: Date.now() },
        },
      },
      last_processed_message_sid: msg.messageSid,
    });
    await queueOutboxText(client, msg.messageSid, msg.from,
      disambiguationPromptBody(result.threads, conv.language));
    return workerId;
  }
  return null; // no_conversation -> caller falls through to built-in replies
}

export async function handleDisambiguationPick(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  workerId: string,
  deps: RouterDeps,
): Promise<string | null> {
  const ctx = conv.state_context?.conversation_disambiguation;
  const pick = parseDisambiguationPick(msg.body);
  if (!ctx || pick === null) return null;
  const chosen = ctx.threads[pick - 1];
  if (!chosen) {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? `Please send a number between 1 and ${ctx.threads.length}.`
        : `Envía un número entre 1 y ${ctx.threads.length}.`);
    return workerId;
  }

  await setInternalUserRlsContext(client, workerId);
  const { conversation_disambiguation: _drop, ...restContext } = conv.state_context ?? {};
  const pendingFresh = ctx.pending && Date.now() - ctx.pending.ts < PENDING_RELAY_TTL_MS;

  if (pendingFresh && ctx.pending) {
    await recordWorkerConversationReply(
      client, workerId, ctx.pending.body, msg.from, ctx.pending.messageSid,
      chosen.conversationId,
    );
  }
  await deps.updateConversation(client, conv.id, {
    focused_job_conversation_id: chosen.conversationId,
    state_context: restContext,
    last_processed_message_sid: msg.messageSid,
  });
  conv.focused_job_conversation_id = chosen.conversationId;
  conv.state_context = restContext as ProfileStateContext;

  await queueOutboxText(client, msg.messageSid, msg.from,
    conv.language === 'en'
      ? (pendingFresh
          ? `Done — your message was sent to ${sanitizeLabel(chosen.companyName)}.`
          : `Done — you are now replying to ${sanitizeLabel(chosen.companyName)}. Write your message.`)
      : (pendingFresh
          ? `Listo — tu mensaje se envió a ${sanitizeLabel(chosen.companyName)}.`
          : `Listo — ahora respondes a ${sanitizeLabel(chosen.companyName)}. Escribe tu mensaje.`));
  return workerId;
}
