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
  closeWorkerConversation,
  declineLatestWorkerConversationFromButtonText,
  declineWorkerConversationFromButton,
  openLatestWorkerConversationFromButtonText,
  openWorkerConversationFromButton,
  recordWorkerConversationReply,
  type ThreadOption,
} from '../../lib/job-messaging';
import { queueOutboxText } from './outbox';
import { detectLanguage, t, type Lang } from './templates';
import {
  isJobsKeyword, parseTypedJobAction, normalizeCommandText, matchCommandFuzzy,
} from './flows';
import type { ConversationState, ProfileStateContext } from './flows';
// Type-only: erased at compile time, so this creates no runtime dependency
// on application-fill.ts (which itself imports real functions from this
// module) -- see FillStateContext's own jsdoc for why that stays a
// one-directional runtime edge.
import type { FillStateContext } from './application-fill';

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
  recordLegalAcceptance: (
    client: PoolClient,
    input: { workerId: string; documentVersion: string },
  ) => Promise<{ verified: boolean }>;
  requiredLegalVersion: string;
}

export function isLikelyOtpCode(body: string): boolean {
  return /^\s*\d{6}\s*$/.test(body);
}

export function isChatsKeyword(body: string): boolean {
  const n = normalizeCommandText(body);
  if (n === 'chats' || n === 'mensajes') return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'chats' || fuzzy === 'mensajes';
}

export function isCloseKeyword(body: string): boolean {
  const n = normalizeCommandText(body);
  if (n === 'cerrar' || n === 'close') return true;
  const fuzzy = matchCommandFuzzy(n);
  return fuzzy === 'cerrar' || fuzzy === 'close';
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

const TOS_ACCEPT_KEYWORDS = new Set(['acepto', 'aceptar', 'accept']);

/**
 * Legal wall with a working exit (spec 2026-08-13 §5). The prompt sent to
 * READY workers had no acceptance handler: payloads and typed "Acepto" fell
 * back to the gate and re-prompted forever. Stateless keyword contract:
 * while the gate FAILS, acepto/aceptar/accept mean legal acceptance; once
 * accepted, this helper is never reached and 'accept' keeps its open-thread
 * meaning in parseEmployerConversationTextAction.
 */
export async function ensureWorkerTosAccepted(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  workerId: string,
  deps: RouterDeps,
  holdMetric: string,
): Promise<'accepted' | 'handled'> {
  if (await workerHasAcceptedTos(client, workerId)) return 'accepted';

  // Case/accent-insensitive (spec §5): normalizeCommandText only lowercases
  // and trims — it must stay exact for the other parsers that depend on it
  // (flows.ts), so diacritics are stripped locally here instead. Catches
  // autocorrect variants like "Aceptó".
  const normalized = normalizeCommandText(msg.body).normalize('NFD').replace(/\p{M}/gu, '');
  if (TOS_ACCEPT_KEYWORDS.has(normalized)) {
    return await recordRelayLegalAcceptance(client, conv, msg, workerId, deps);
  }

  await deps.queueLegalPrompt(client, msg.messageSid, msg.from, conv.language);
  console.log(JSON.stringify({ metric: holdMetric, workerId }));
  return 'handled';
}

/** Records consent for a ready worker replying to the relay legal prompt. */
export async function recordRelayLegalAcceptance(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  workerId: string,
  deps: RouterDeps,
): Promise<'handled'> {
  const consent = await deps.recordLegalAcceptance(client, {
    workerId,
    documentVersion: deps.requiredLegalVersion,
  });
  if (!consent.verified) {
    console.log(JSON.stringify({ metric: 'WhatsAppConsentWriteFailed', workerId }));
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? 'Something went wrong saving your acceptance. Please try again later.'
        : 'Algo salió mal al guardar tu aceptación. Inténtalo de nuevo más tarde.');
    return 'handled';
  }
  // D5: no buffering — the worker resends their message through the now-open gate.
  await queueOutboxText(client, msg.messageSid, msg.from,
    conv.language === 'en'
      ? 'Thanks — terms accepted. Send your message again to continue.'
      : 'Listo — términos aceptados. Envía tu mensaje de nuevo para continuar.');
  return 'handled';
}

/** Decline from the relay legal prompt: acknowledged, nothing recorded. */
export async function handleLegalDeclineFromRelay(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
): Promise<'handled'> {
  await queueOutboxText(client, msg.messageSid, msg.from,
    conv.language === 'en'
      ? 'Understood. You can accept the terms later by replying "Accept".'
      : 'Entendido. Puedes aceptar los términos después respondiendo "Acepto".');
  return 'handled';
}

export function parseEmployerConversationTextAction(body: string): 'open' | 'decline' | null {
  const normalized = normalizeCommandText(body);
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

const RELAY_FIRST_STATES = new Set(['idle', 'new', 'otp_timeout', 'legal_declined']);

/**
 * Try conversation relay before built-in state handling. Returns workerId
 * when handled (routed / ambiguous-prompt / legal-hold), null to fall through
 * to the onboarding state machine or handleIdle's command handling.
 *
 * NEVER binds user_id or mutates conversation_state (V2 plan §4.2a): relay is
 * conversation-scoped; account access still requires a completed OTP. Replaces
 * the old awaiting_otp-only override which bound identity on relay.
 */
export async function tryConversationRelay(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  deps: RouterDeps,
): Promise<string | null> {
  if (!msg.body.trim()) return null;

  // Identity-binding rule (design §4.2a): only a verified OTP binds a session.
  // An unbound conversation must never relay into an employer thread — a phone
  // match is not an identity (the Manuel incident).
  if (!conv.user_id) return null;

  if (conv.conversation_state === 'awaiting_otp') {
    // OTP codes always go to the OTP handler.
    if (isLikelyOtpCode(msg.body)) return null;
  } else if (!RELAY_FIRST_STATES.has(conv.conversation_state)) {
    return null; // structured-input states keep precedence (§4.2 rule 2)
  }

  // Reserved keywords and typed job actions keep precedence over relay
  // (§4.1.7 / §4.2 rule 4) — let them fall through to handleIdle.
  // (help/profile/bare-word actions are already handled earlier in routeMessage.)
  if (isJobsKeyword(msg.body) || parseTypedJobAction(msg.body)) return null;

  const workerId = conv.user_id;

  // CHATS/MENSAJES keyword: show the worker their open employer threads.
  // Must be intercepted here so it never reaches relayWorkerFreeText which
  // would attempt to route "CHATS" as a job message.
  if (isChatsKeyword(msg.body)) {
    if ((await ensureWorkerTosAccepted(client, conv, msg, workerId, deps, 'ChatsKeywordLegalHold')) !== 'accepted') {
      return workerId;
    }
    await setInternalUserRlsContext(client, workerId);
    // Explicit CHATS/MENSAJES: always show the list so the worker picks,
    // even with a single open thread.
    await sendChatsPickerOrAutoFocus(client, conv, workerId, msg, deps, false);
    return workerId;
  }

  return await relayWorkerFreeText(client, conv, msg, workerId, deps);
}

/**
 * Set (or clear) the focused employer thread on the conversation row.
 *
 * R10 fix: conversation open/decline actions must NOT reset onboarding —
 * they only touch the `focused_job_conversation_id` COLUMN (which relay reads),
 * never `conversation_state`, `state_context`, or `user_id`. A worker mid-
 * onboarding who taps "open" keeps their collected answers; once they finish
 * onboarding and reach idle, relay routes free text to the focused thread.
 *
 * Task 10a: this is the SINGLE set-site for focusing an employer thread,
 * shared by the CHATS picker resolution and the `conversation:focus` button
 * path. When the worker is mid application-fill (`fill_application_id` is a
 * string), the very next free-text message must relay to the newly-focused
 * employer instead of feeding the fill — so we arm a one-turn
 * `fill_relay_override` flag here. The fill dispatcher clears it after
 * relaying exactly one message (spec §4.2).
 *
 * FINAL-REVIEW Finding 1b: the override is armed ONLY when `conversationId`
 * is a real thread id, never on a `conversationId === null` call (decline,
 * the close-reason picker, `focus_closed`'s post-close clear). Those call
 * sites focus NOTHING — arming the override there would flag the worker's
 * next free-text message for relay with no focused thread to relay it TO,
 * so `handleFillMessage`'s consume step returns `handled:false` and the
 * message (e.g. the worker's actual field answer) is silently swallowed
 * instead of either relaying or feeding the fill.
 */
async function setFocusedConversation(
  client: PoolClient,
  conv: ConversationRow,
  conversationId: string | null,
  messageSid: string,
  deps: RouterDeps,
): Promise<void> {
  const { pending_picker: _drop, ...restContext } =
    (conv.state_context ?? {}) as FillStateContext;
  const fillArmed = conversationId !== null && typeof restContext.fill_application_id === 'string';
  const nextContext: FillStateContext = fillArmed
    ? { ...restContext, fill_relay_override: true }
    : restContext;
  await deps.updateConversation(client, conv.id, {
    focused_job_conversation_id: conversationId,
    state_context: nextContext,
    last_processed_message_sid: messageSid,
  });
  conv.focused_job_conversation_id = conversationId;
  conv.state_context = nextContext as typeof conv.state_context;
}

// R6: an open/decline targeting a closed/missing conversation must not silently
// no-op — reply with an actionable message instead of leaving the tap dead.
function conversationUnavailableText(lang: Lang): string {
  return lang === 'en'
    ? 'That conversation is no longer available. Send AYUDA to see your options.'
    : 'Esa conversación ya no está disponible. Envía AYUDA para ver tus opciones.';
}

export async function handleEmployerConversationButton(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  payload: { action: 'open' | 'decline' | 'focus'; conversationId: string },
  deps: RouterDeps,
): Promise<string | null> {
  const workerId = conv.user_id;
  if (!workerId) {
    await queueOutboxText(client, msg.messageSid, msg.from, t('start_prompt', detectLanguage(msg.body)));
    return null;
  }

  await setInternalUserRlsContext(client, workerId);

  if (payload.action === 'focus') {
    // Verify the thread is still open before switching focus.
    // No ToS check: focus is a structural navigation action — the worker already
    // accepted ToS to receive the button that generated this payload.
    const threadCheck = await client.query<{ id: string }>(
      `SELECT id FROM job_conversations WHERE id = $1 AND worker_id = $2 AND status = 'open'`,
      [payload.conversationId, workerId],
    );
    if ((threadCheck.rowCount ?? 0) === 0) {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conversationUnavailableText(conv.language));
      return null;
    }
    await setFocusedConversation(client, conv, payload.conversationId, msg.messageSid, deps);
    await queueOutboxText(
      client,
      msg.messageSid,
      msg.from,
      conv.language === 'en'
        ? 'Now replying to that conversation. Send your message.'
        : 'Ahora respondes a esa conversación. Escribe tu mensaje.',
    );
    return workerId;
  }

  if (payload.action === 'decline') {
    const declined = await declineWorkerConversationFromButton(
      client,
      workerId,
      payload.conversationId,
    );
    if (declined) {
      await setFocusedConversation(client, conv, null, msg.messageSid, deps);
      await queueOutboxText(
        client,
        msg.messageSid,
        msg.from,
        conv.language === 'en'
          ? 'Conversation closed. You can keep using Jale here.'
          : 'Conversacion cerrada. Puedes seguir usando Jale aqui.',
      );
    } else {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conversationUnavailableText(conv.language));
    }
    return null;
  }

  // Legal wall (V2 plan §4.5): opening a conversation relays the worker into
  // an employer thread, so it is compliance-gated. (Decline is NOT gated — a
  // worker can always decline without consent.)
  if ((await ensureWorkerTosAccepted(client, conv, msg, workerId, deps, 'ConversationOpenLegalHold')) !== 'accepted') {
    return workerId;
  }

  const opened = await openWorkerConversationFromButton(
    client,
    workerId,
    payload.conversationId,
    msg.from,
  );
  if (!opened.found) {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conversationUnavailableText(conv.language));
    return null;
  }

  await setFocusedConversation(
    client, conv, opened.conversationId ?? payload.conversationId, msg.messageSid, deps);
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
  const workerId = conv.user_id;
  if (!workerId) return null;

  await setInternalUserRlsContext(client, workerId);

  if (action === 'decline') {
    const declined = await declineLatestWorkerConversationFromButtonText(client, workerId);
    if (!declined) {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conversationUnavailableText(conv.language));
      return null;
    }
    await setFocusedConversation(client, conv, null, msg.messageSid, deps);
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
  if ((await ensureWorkerTosAccepted(client, conv, msg, workerId, deps, 'ConversationOpenLegalHold')) !== 'accepted') {
    return workerId;
  }

  const opened = await openLatestWorkerConversationFromButtonText(client, workerId, msg.from);
  if (!opened.found) {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conversationUnavailableText(conv.language));
    return null;
  }

  await setFocusedConversation(client, conv, opened.conversationId ?? null, msg.messageSid, deps);
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

// ── Chats picker / auto-focus helper ──────────────────────────────

/**
 * Offer the worker their open employer threads: send a "no open conversations"
 * notice if 0, otherwise list them as a numbered picker. When `autoFocusSingle`
 * is true and exactly 1 thread is open, skip the list and focus it directly —
 * used by the post-close continuation (the worker did not ask for a list). The
 * explicit CHATS/MENSAJES command passes false so the worker always sees the
 * list and explicitly picks, even with a single open thread.
 *
 * Lists ALL open threads regardless of `accepted_at`. A new invite delivered as
 * a freeform message (cross-session path) has no Open/Decline buttons and stays
 * accepted_at=NULL, so gating on accepted_at would make it invisible here and
 * lock the worker out of the conversation. Picking an un-accepted thread sets
 * focus; the worker's next reply routes via focus (no accepted_at gate) and
 * sets accepted_at. Auto-route (no-focus reply) keeps the accepted_at gate so
 * an in-progress chat is not interrupted by a brand-new invite.
 */
async function sendChatsPickerOrAutoFocus(
  client: PoolClient,
  conv: ConversationRow,
  workerId: string,
  msg: IncomingMessage,
  deps: RouterDeps,
  autoFocusSingle: boolean,
): Promise<void> {
  const open = await client.query<{
    id: string;
    job_title: string;
    company: string;
    worker_thread_number: number | null;
  }>(
    `SELECT jc.id,
            COALESCE(NULLIF(j.title, ''), 'Trabajo') AS job_title,
            employer_display_name(jc.employer_id) AS company,
            jc.worker_thread_number
       FROM job_conversations jc
       JOIN jobs j ON j.id = jc.job_id
      WHERE jc.worker_id = $1
        AND jc.status = 'open'
      ORDER BY jc.worker_thread_number NULLS LAST, jc.created_at`,
    [workerId],
  );

  if ((open.rowCount ?? 0) === 0) {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? 'You have no open conversations.'
        : 'No tienes conversaciones abiertas.');
    return;
  }

  if ((open.rowCount ?? 0) === 1 && autoFocusSingle) {
    const row = open.rows[0];
    await setFocusedConversation(client, conv, row.id, msg.messageSid, deps);
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? `Now replying to ${row.company}. Send your message.`
        : `Ahora respondes a ${row.company}. Escribe tu mensaje.`);
    return;
  }

  // ≥1 open thread (or ≥2 when auto-focus is enabled): send picker
  const threads = open.rows.map(r => ({
    conversationId: r.id,
    jobTitle: r.job_title,
    companyName: r.company,
    threadNumber: r.worker_thread_number,
  }));
  const { pending_picker: _drop, ...restCtx } = (conv.state_context ?? {}) as ProfileStateContext;
  await deps.updateConversation(client, conv.id, {
    state_context: { ...restCtx, pending_picker: { kind: 'chats' as const, threads } },
    last_processed_message_sid: msg.messageSid,
  });
  conv.state_context = { ...restCtx, pending_picker: { kind: 'chats', threads } } as ProfileStateContext;
  const header = conv.language === 'en'
    ? 'Your open conversations:'
    : 'Tus conversaciones abiertas:';
  const lines = threads.map((t, i) =>
    `${i + 1}. ${t.companyName} — ${t.jobTitle}`);
  const footer = conv.language === 'en' ? 'Reply with the number.' : 'Responde con el número.';
  await queueOutboxText(client, msg.messageSid, msg.from,
    [header, ...lines, footer].join('\n'));
}

// ── Disambiguation flow ─────────────────────────────────────────

function sanitizeLabel(value: string | null | undefined, max = 40): string {
  return (value ?? '').replace(/[\r\n\t -]/g, ' ').trim().slice(0, max) || 'Empleador';
}

export function parseDisambiguationPick(body: string): number | null {
  const m = body.trim().match(/^\d{1,2}$/);
  return m ? Number(m[0]) : null;
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
  if ((await ensureWorkerTosAccepted(client, conv, msg, workerId, deps, 'ConversationRelayLegalHold')) !== 'accepted') {
    return workerId; // handled — do not fall through to onboarding replies
  }

  await setInternalUserRlsContext(client, workerId);

  // CERRAR/CLOSE is contextual — only meaningful with an active focus.
  // Without focus, these words relay as ordinary text (not intercepted).
  // With focus: send a 3-option reason picker and wait for the worker to pick.
  if (isCloseKeyword(msg.body) && conv.focused_job_conversation_id) {
    const { pending_picker: _drop, ...restCtx } = (conv.state_context ?? {}) as ProfileStateContext;
    const closePicker: ProfileStateContext['pending_picker'] = {
      kind: 'close_reason',
      conversationId: conv.focused_job_conversation_id,
    };
    await deps.updateConversation(client, conv.id, {
      state_context: { ...restCtx, pending_picker: closePicker },
      last_processed_message_sid: msg.messageSid,
    });
    conv.state_context = { ...restCtx, pending_picker: closePicker } as ProfileStateContext;
    const lines = conv.language === 'en'
      ? [
          'Why are you closing this conversation?',
          '1. Found work',
          '2. Not interested',
          '3. Other',
          'Reply with the number.',
        ]
      : [
          '¿Por qué cierras esta conversación?',
          '1. Encontré trabajo',
          '2. No me interesa',
          '3. Otro',
          'Responde con el número.',
        ];
    await queueOutboxText(client, msg.messageSid, msg.from, lines.join('\n'));
    return workerId;
  }

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
        pending_picker: {
          kind: 'disambiguation' as const,
          threads: result.threads,
        },
      },
      last_processed_message_sid: msg.messageSid,
    });
    const header = conv.language === 'en'
      ? 'You have several open conversations. Who do you want to message? Reply with the number, then send your message.'
      : 'Tienes varias conversaciones abiertas. ¿A quién le quieres escribir? Responde con el número, luego envía tu mensaje.';
    const lines = result.threads.map((t, i) =>
      `${i + 1}. ${sanitizeLabel(t.companyName)} — ${sanitizeLabel(t.jobTitle)}`);
    await queueOutboxText(client, msg.messageSid, msg.from,
      [header, ...lines].join('\n'));
    return workerId;
  }
  if (result.status === 'focus_closed') {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? 'That conversation has ended.'
        : 'Esa conversación ya terminó.');
    await setFocusedConversation(client, conv, null, msg.messageSid, deps);
    // Post-close continuation: auto-focus a single remaining thread (the worker
    // did not ask for a list — keep them in the flow).
    await sendChatsPickerOrAutoFocus(client, conv, workerId, msg, deps, true);
    return workerId;
  }
  return null; // no_conversation -> caller falls through to built-in replies
}

export async function handlePickerResponse(
  client: PoolClient,
  conv: ConversationRow,
  msg: IncomingMessage,
  workerId: string,
  deps: RouterDeps,
): Promise<string | null> {
  const ctx = conv.state_context?.pending_picker;
  const pick = parseDisambiguationPick(msg.body);
  if (!ctx || pick === null) return null;

  if (ctx.kind === 'close_reason') {
    const SYSTEM_BODIES: Record<number, string> = {
      1: 'El trabajador encontró trabajo / Worker found work',
      2: 'El trabajador no está interesado / Worker is not interested',
      3: 'El trabajador terminó la conversación / Worker ended the conversation',
    };
    if (pick < 1 || pick > 3) {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conv.language === 'en'
          ? 'Please send a number between 1 and 3.'
          : 'Envía un número entre 1 y 3.');
      return workerId;
    }
    const closed = await closeWorkerConversation(
      client, ctx.conversationId, workerId, SYSTEM_BODIES[pick]);
    await setFocusedConversation(client, conv, null, msg.messageSid, deps);
    if (closed) {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conv.language === 'en' ? 'Conversation closed.' : 'Conversación cerrada.');
    } else {
      await queueOutboxText(client, msg.messageSid, msg.from,
        conv.language === 'en'
          ? 'That conversation has already ended.'
          : 'Esa conversación ya había terminado.');
    }
    return workerId;
  }

  const chosen = ctx.threads[pick - 1];
  if (!chosen) {
    await queueOutboxText(client, msg.messageSid, msg.from,
      conv.language === 'en'
        ? `Please send a number between 1 and ${ctx.threads.length}.`
        : `Envía un número entre 1 y ${ctx.threads.length}.`);
    return workerId;
  }

  await setFocusedConversation(client, conv, chosen.conversationId, msg.messageSid, deps);
  await queueOutboxText(client, msg.messageSid, msg.from,
    conv.language === 'en'
      ? `Now replying to ${sanitizeLabel(chosen.companyName)}. Send your message.`
      : `Ahora respondes a ${sanitizeLabel(chosen.companyName)}. Escribe tu mensaje.`);
  return workerId;
}
