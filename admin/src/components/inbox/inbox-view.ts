// Pure view helpers for the FE-2 Inbox, conversation and lockout views. No
// React and no I/O: server pages, client islands and check-ui-inbox-view.mjs
// all import them.
import type { InboxItem, InboxQuery, InboxStatusFilter, InboxTab } from '@/lib/server/admin-inbox';
import type { ConversationMessage, SupportConversation } from '@/lib/server/support-conversation';
import type { LockoutResetReason } from '@/lib/lockout-reasons';
import type { LockoutDetail } from '@/lib/server/admin-lockouts';
import { TEMPLATE_REPLY_MAX_CHARS, templateReplyLength, templateReplyText } from '@/lib/support-reply';
import type { CaseAction, CaseActionId, InboxAction, InboxActionError, InboxActionResult } from '@/lib/server/inbox-actions';

// --- The Inbox list -----------------------------------------------------------

/** Badge tones; the same members as FE-1's BadgeTone. */
export type InboxTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export const INBOX_TABS: ReadonlyArray<{ id: InboxTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'support', label: 'Support' },
  { id: 'reports', label: 'Problem reports' },
  { id: 'lockouts', label: 'Lockouts' },
];

export const INBOX_STATUS_OPTIONS: ReadonlyArray<{ id: InboxStatusFilter; label: string }> = [
  { id: 'waiting', label: 'Open + waiting' },
  { id: 'waiting_on_worker', label: 'Waiting on worker' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

export type InboxListQuery = { tab: InboxTab; status: InboxStatusFilter; q?: string; before?: string; report?: InboxQuery['report'] };

/** Whether any K2.3 report filter is set. */
export function reportFiltersSet(report: InboxQuery['report']): boolean {
  return Boolean(report && (report.reportStatus || report.role || report.category || report.verified !== null || report.number !== null || report.numberInput.trim() !== ''));
}

/** The Inbox URL for a query. The defaults (tab all, status waiting) and empty values stay out of it. */
export function inboxListHref(query: InboxListQuery): string {
  const params = new URLSearchParams();
  if (query.tab !== 'all') params.set('tab', query.tab);
  if (query.status !== 'waiting') params.set('status', query.status);
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.tab === 'reports' && query.report) {
    // The report status has its own key: `status` is the Inbox status (K2.3).
    const r = query.report;
    if (r.reportStatus) params.set('reportStatus', r.reportStatus);
    if (r.role) params.set('role', r.role);
    if (r.category) params.set('category', r.category);
    if (r.verified !== null) params.set('verified', r.verified ? 'yes' : 'no');
    const number = r.numberInput.trim() || (r.number !== null ? String(r.number) : '');
    if (number) params.set('number', number);
  }
  if (query.before) params.set('before', query.before);
  const text = params.toString();
  return text ? `/inbox?${text}` : '/inbox';
}

/**
 * The view for one kind of item (K2.3). Inbox rows link to the server's own
 * `href`; client navigations (an opened support case, earlier cases) use this.
 */
export function inboxDetailHref(kind: InboxItem['kind'], id: string): string {
  const segment = encodeURIComponent(id);
  if (kind === 'report') return `/inbox/reports/${segment}`;
  if (kind === 'lockout') return `/inbox/lockouts/${segment}`;
  return `/inbox/support/${segment}`;
}

export function supportCaseHref(caseId: string): string {
  return inboxDetailHref('support', caseId);
}

/** Who an item waits on, as a badge tone. The badge always carries the status words too. */
export function waitingTone(waitingOn: InboxItem['waitingOn']): InboxTone {
  if (waitingOn === 'us') return 'warning';
  if (waitingOn === 'worker') return 'info';
  return 'neutral';
}

export function inboxFooterText(shown: number, total: number): string {
  return `Showing ${shown} of ${total} · unread items are marked with a blue dot`;
}

export type EmptyCopy = { title: string; body: string; filtered: boolean };

const EMPTY_BY_TAB: Record<InboxTab, { title: string; body: string }> = {
  all: { title: 'Nothing is waiting on an admin', body: 'New support messages, problem reports and lockouts show up here.' },
  support: {
    title: 'No support conversations are waiting',
    body: 'When a worker writes SOPORTE or SUPPORT on WhatsApp, the conversation shows up here.',
  },
  reports: { title: 'No problem reports are waiting', body: 'Reports sent from the web app show up here.' },
  lockouts: {
    title: 'No one is locked out of verification',
    body: 'Workers locked out of identity verification on WhatsApp show up here.',
  },
};

/** The empty state: per tab when nothing waits; a filtered one when a status or a search narrowed the list. */
export function inboxEmptyCopy(query: Pick<InboxQuery, 'tab' | 'status' | 'q' | 'report'>): EmptyCopy {
  if (query.status !== 'waiting' || (query.q ?? '').trim() !== '' || (query.tab === 'reports' && reportFiltersSet(query.report))) {
    return { title: 'Nothing matches these filters', body: 'Try another status, or clear the search.', filtered: true };
  }
  return { ...EMPTY_BY_TAB[query.tab], filtered: false };
}


// --- The conversation and the reply box ---------------------------------------

export type ReplyMode = SupportConversation['reply']['mode'];
type Worker = SupportConversation['worker'];
type AdminMessage = Extract<ConversationMessage, { from: 'admin' }>;
type MediaItem = Extract<ConversationMessage, { kind: 'media' }>;

/** How long a private media link lasts, from its expiry: whole minutes from now, rounded up, at least 1. */
export function mediaLinkLifetimeText(expiresAtIso: string, nowMs: number): string {
  const ms = Date.parse(expiresAtIso) - nowMs;
  const minutes = Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 60000)) : 1;
  return `The link stops working in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

export const TEMPLATE_NEWLINE_NOTE = 'Line breaks become spaces.';

/** The reply as the template carries it: every whitespace run one space, then trimmed (K2.4, BE-2b's shared rule). */
export function templateLine(text: string): string {
  return templateReplyText(text);
}

/** Characters counted against reply.maxChars. Template mode uses BE-2b's shared rule (src/lib/support-reply.ts). */
export function replyLength(text: string, mode: ReplyMode): number {
  return mode === 'template' ? templateReplyLength(text) : text.length;
}

export type ReplyCount = { used: number; max: number; over: boolean; label: string };

export function replyCount(text: string, mode: ReplyMode, max: number): ReplyCount {
  const used = replyLength(text, mode);
  return { used, max, over: used > max, label: `${used} / ${max}` };
}

/** Why the reply cannot be sent yet, or null when it can. The server checks again. */
export function replyProblem(text: string, mode: ReplyMode, max: number): string | null {
  if (text.trim() === '') return 'Write a reply first.';
  if (replyLength(text, mode) > max) return `Shorten to ${max} characters.`;
  return null;
}

export type TemplateParts = { before: string; reply: string | null; after: string };

/** The template preview. The template's own quote marks are part of before and after; never add more. */
export function templatePreviewParts(preview: { before: string; after: string }, text: string): TemplateParts {
  const line = templateLine(text);
  return { before: preview.before, reply: line === '' ? null : line, after: preview.after };
}

export function sendLabel(mode: ReplyMode): string {
  return mode === 'template' ? 'Send in template' : 'Send reply';
}

export function replyPlaceholder(language: SupportConversation['language']): string {
  return language === 'es' ? 'Escribe tu respuesta…' : 'Write your reply…';
}

export const DELIVERY_LABELS: Readonly<Record<AdminMessage['delivery'], string>> = {
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Not delivered',
  waiting_for_window: 'Waiting for the worker to reply',
};

export function adminByline(byRole: AdminMessage['byRole']): string {
  return byRole === 'Superadmin' ? 'Superadmin' : `${byRole} admin`;
}

export function deliveryText(message: Pick<AdminMessage, 'delivery' | 'via'>): string {
  return `${DELIVERY_LABELS[message.delivery]}${message.via === 'template' ? ' · sent in template' : ''}`;
}

export function mediaLabel(type: MediaItem['mediaType']): string {
  if (type === 'image') return 'Photo';
  if (type === 'audio') return 'Voice note';
  return 'Document';
}

export function hasWorkerMessages(messages: readonly ConversationMessage[]): boolean {
  return messages.some((message) => message.from === 'worker');
}

export function conversationSubtitle(c: Pick<SupportConversation, 'kind' | 'typeLabel' | 'worker' | 'languageLabel'>): string {
  const what = c.kind === 'support' ? 'Support conversation' : `${c.typeLabel} case`;
  return `${what} on WhatsApp · ${c.worker.label} · ${c.languageLabel}`;
}

export function caseStatusTone(status: SupportConversation['status']): InboxTone {
  if (status === 'open' || status === 'pending_admin') return 'warning';
  if (status === 'pending_worker') return 'info';
  if (status === 'resolved') return 'success';
  return 'neutral';
}

export function onboardingText(worker: Pick<Worker, 'onboardingStepLabel' | 'onboardingStepIndex' | 'onboardingStepCount'>): string {
  const { onboardingStepLabel: label, onboardingStepIndex: index, onboardingStepCount: count } = worker;
  if (label === null) return '—';
  return index !== null && count !== null ? `${label} (step ${index} of ${count})` : label;
}

export function failedCodesText(count: number): string {
  return count === 1 ? '1 failed code today' : `${count} failed codes today`;
}

export function contentText(messageCount: number, mediaCount: number): string {
  const messages = messageCount === 1 ? '1 message' : `${messageCount} messages`;
  if (mediaCount === 0) return messages;
  return `${messages} · ${mediaCount === 1 ? '1 attachment' : `${mediaCount} attachments`}`;
}

export function adminsToldText(count: number): string {
  return count === 0 ? 'No one yet' : `${count}, by email`;
}

/**
 * How long before `window.closesAt` the server starts capping replies at
 * TEMPLATE_REPLY_MAX_CHARS. Migration 122: the window is open while the last
 * inbound is newer than 23h45m (lines 591 and 643, `closesAt` = last inbound +
 * 23h45m), but the reply cap treats it as closed once the last inbound is
 * 23h15m old (line 812), which is 30 minutes before `closesAt`.
 */
export const TEMPLATE_CAP_LEAD_MS = 30 * 60_000;

/**
 * True when the reply cap applies: `closesAt` is at most 30 minutes after
 * `nowIso` (inclusive at exactly 30:00). Zero or negative time left also
 * returns true: the countdown page refreshes to the closed state at zero, and
 * the cap holds until then. An unparseable close time or "now" returns false,
 * so the page never claims the band without a close time.
 */
export function templateCapSoon(closesAt: string, nowIso: string): boolean {
  const left = Date.parse(closesAt) - Date.parse(nowIso);
  return Number.isFinite(left) && left <= TEMPLATE_CAP_LEAD_MS;
}

/** The closed-window banner after its first sentence (FE-2 §4.2), naming the worker's language. */
export function windowClosedRest(languageLabel: string): string {
  return `WhatsApp now only accepts the approved support-reply template, so your text goes inside it, in ${languageLabel}. When the worker answers, the chat reopens in support mode.`;
}

// --- Actions (K2.7) -----------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An action as a control builds it. InboxActionsProvider adds a new requestId to every attempt. */
export type InboxActionInput = DistributiveOmit<InboxAction, 'requestId'>;
export type InboxActionName = InboxActionInput['action'];

/** The server's K2.7 answer, or what happened instead. */
export type InboxRunResult =
  | InboxActionResult
  | { ok: false; error: 'network' }      // fetch threw: offline, or the answer was lost
  | { ok: false; error: 'redirecting' }  // 401: adminFetchJson is sending the page to sign-in
  | { ok: false; error: 'busy' }         // another action on this page is still in flight
  | { ok: false; error: 'unexpected'; status: number }; // not a K2.7 body (e.g. the 501 stub, an edge 502)

/**
 * True when the answer to an attempt is not known: the request may have
 * reached the server and its answer was lost (network failure, a 5xx or a
 * status-0 reply). Every K2.7 answer, a redirect and a busy refusal are known.
 */
export function isUnknownOutcome(result: InboxRunResult): boolean {
  if (result.ok) return false;
  if (result.error === 'network') return true;
  return result.error === 'unexpected' && (result.status >= 500 || result.status === 0);
}

/** A canonical form of an action: the same fields give the same key whatever their order. */
export function actionKey(input: InboxActionInput): string {
  const fields = input as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const name of Object.keys(fields).sort()) sorted[name] = fields[name];
  return JSON.stringify(sorted);
}

/** One request id per attempt-until-known: the previous id while the action is unchanged, else a new one. */
export function chooseRequestId(previous: { key: string; requestId: string } | null, key: string, newId: () => string): string {
  return previous?.key === key ? previous.requestId : newId();
}

export function withRequestId(input: InboxActionInput, requestId: string): InboxAction {
  return { ...input, requestId } as InboxAction;
}

export const INBOX_ACTION_ERRORS: ReadonlyArray<InboxActionError> = [
  'invalid_input', 'unauthorized', 'session_expired', 'forbidden', 'not_found',
  'case_closed', 'reply_too_long_for_template', 'no_reply_target', 'media_expired', 'not_locked',
];

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isActionError = (value: unknown): value is InboxActionError =>
  typeof value === 'string' && (INBOX_ACTION_ERRORS as readonly string[]).includes(value);

/** True only for a body of exactly the K2.7 shape. Media links must be https, so window.open never runs a script URL. */
export function isInboxActionResult(value: unknown): value is InboxActionResult {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  if (body.ok === true) {
    if (body.kind === 'done') return true;
    if (body.kind === 'media') return isText(body.url) && body.url.startsWith('https://') && isText(body.expiresAt);
    if (body.kind === 'phone') return isText(body.phone);
    if (body.kind === 'case') return isText(body.caseId);
    return false;
  }
  if (body.ok !== false || !isActionError(body.error)) return false;
  return body.maxChars === undefined || (typeof body.maxChars === 'number' && Number.isInteger(body.maxChars) && body.maxChars > 0);
}

export type ActionMessage = { tone: 'success' | 'danger'; text: string };

const SUCCESS_TEXT: Partial<Record<InboxActionName, string>> = {
  reply: 'Reply queued.',
  request_info: 'Request for more info queued.',
  resolve: 'Case resolved. The closing message is queued.',
  reset_lockout: 'Verification reset. The worker is told on WhatsApp.',
};

const INVALID_INPUT_TEXT: Record<InboxActionName, string> = {
  reply: 'The reply was not accepted. Check its length and try again.',
  request_info: 'The request was not accepted. Check its length and try again.',
  resolve: 'The case could not be resolved. Reload the page and try again.',
  reveal_phone: 'Give a reason of 20 to 500 characters.',
  open_media: 'The file could not be opened. Reload the page and try again.',
  reset_lockout: 'Choose a reason, and add a note of up to 300 characters for Other.',
  open_support_from_lockout: 'The support conversation could not be opened. Reload the page and try again.',
};

/** What the admin reads after an action; null when nothing new should show. */
export function inboxActionMessage(action: InboxActionName, result: InboxRunResult): ActionMessage | null {
  if (result.ok) {
    const text = SUCCESS_TEXT[action];
    return text ? { tone: 'success', text } : null;
  }
  const danger = (text: string): ActionMessage => ({ tone: 'danger', text });
  switch (result.error) {
    case 'redirecting':
    case 'busy':
      return null;
    case 'network':
      return danger('No answer from the server. Check your connection and try again: the same request is never sent twice.');
    case 'unexpected':
      return danger('Something went wrong. Reload the page and try again.');
    case 'reply_too_long_for_template':
      return danger(`The chat window is about to close or has closed, so replies are limited to ${result.maxChars ?? TEMPLATE_REPLY_MAX_CHARS} characters. Shorten it and send again.`);
    case 'case_closed':
      return danger('This case is closed, so nothing was sent. The page now shows its latest state.');
    case 'media_expired':
      return danger('This file was removed after 90 days.');
    case 'not_locked':
      return danger('This verification is no longer locked, so there is nothing to reset. The page now shows its latest state.');
    case 'no_reply_target':
      return danger('This case has no WhatsApp number to reply to.');
    case 'forbidden':
      return danger('Requires Ops or Superadmin.');
    case 'not_found':
      return danger('This item no longer exists. Go back to the Inbox.');
    case 'invalid_input':
      return danger(INVALID_INPUT_TEXT[action]);
    case 'unauthorized':
    case 'session_expired':
      return danger('Your session ended. Sign in again to continue.');
  }
}

const REFRESHING_ERRORS: ReadonlySet<string> = new Set(['case_closed', 'not_locked', 'forbidden', 'reply_too_long_for_template']);

/** Whether the page re-reads its data after this result (router.refresh()). */
export function shouldRefresh(result: InboxRunResult): boolean {
  return result.ok ? result.kind === 'done' : REFRESHING_ERRORS.has(result.error);
}

/** The server's action, or a disabled stand-in: an action the server did not send is shown disabled, never hidden. */
export function caseAction(actions: readonly CaseAction[], id: CaseActionId): CaseAction {
  return actions.find((action) => action.id === id) ?? { id, enabled: false, reason: 'Not available for this case.' };
}

/** The reasons to show under disabled actions, once per distinct text, in order. */
export function disabledReasons(actions: readonly CaseAction[]): string[] {
  const reasons: string[] = [];
  for (const action of actions) {
    if (action.enabled) continue;
    const reason = action.reason ?? 'Not available right now.';
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return reasons;
}

// --- Lockout reset and reveal -------------------------------------------------

export const RESET_NOTE_MAX = 300;

/** Why the reset cannot be sent yet, or null when it can (K2.7: a note is required for 'other', at most 300). */
export function resetFormProblem(reason: LockoutResetReason | null, note: string): string | null {
  if (reason === null) return 'Choose a reason.';
  if (reason === 'other' && note.trim() === '') return 'Add a note for Other.';
  if (note.length > RESET_NOTE_MAX) return `Keep the note to ${RESET_NOTE_MAX} characters.`;
  return null;
}

export function resetActionInput(challengeId: string, reason: LockoutResetReason, note: string): InboxActionInput {
  const trimmed = note.trim();
  return trimmed === ''
    ? { action: 'reset_lockout', challengeId, reasonCode: reason }
    : { action: 'reset_lockout', challengeId, reasonCode: reason, note: trimmed };
}

export const REVEAL_REASON_MIN = 20;
export const REVEAL_REASON_MAX = 500;

export function revealReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REVEAL_REASON_MIN) return `At least ${REVEAL_REASON_MIN} characters (${length} so far).`;
  if (length > REVEAL_REASON_MAX) return `At most ${REVEAL_REASON_MAX} characters.`;
  return null;
}

// --- Lockout view -------------------------------------------------------------

export function attemptsText(used: number, allowed: number): string {
  return `${used} of ${allowed}`;
}

export function typicalVerifyText(minutes: number | null): string {
  return minutes === null ? 'Not enough data yet' : `${Math.round(minutes)} min`;
}

export function lockoutHeading(state: LockoutDetail['state']): string {
  return state === 'locked' ? 'Worker is locked out of verification' : 'Worker identity verification';
}

export function lockoutSubtitle(detail: Pick<LockoutDetail, 'state' | 'languageLabel' | 'attemptsAllowed'>): string {
  const base = `Identity verification on WhatsApp · ${detail.languageLabel}`;
  return detail.state === 'locked' ? `${base} · locked automatically after ${detail.attemptsAllowed} failed attempts` : base;
}

export function lockoutTone(state: LockoutDetail['state']): InboxTone {
  if (state === 'locked') return 'danger';
  if (state === 'stuck_at_code') return 'warning';
  if (state === 'in_progress') return 'info';
  if (state === 'verified') return 'success';
  return 'neutral';
}
