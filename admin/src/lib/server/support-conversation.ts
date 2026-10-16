/**
 * Contract K2.4 (sprint 28): the support conversation view, used for every
 * case kind. BE-2b owns this module; FE-2 renders against it.
 *
 * One recorded read: the case row, its events (oldest first), the view
 * definer (window, language, the worker's progress and a masked number;
 * migration 122) and the number's earlier cases. The number itself never
 * leaves SQL here; it is shown only through the reveal_phone action.
 */
import { getSupportActions } from '../action-policy';
import { stepLabel, stepOrder } from '../funnel';
import { FREEFORM_REPLY_MAX_CHARS, TEMPLATE_REPLY_MAX_CHARS } from '../support-reply';
import type { AdminCaseStatus } from '../types';
import { caseRef, caseSubjectIds, maskName } from './admin-cases';
import { CASE_KINDS, CASE_STATUS_LABELS, caseWaitingOn, isAdminCaseStatus, isAdminCaseType, type InboxItem } from './admin-inbox';
import { isUuid } from './audit/codes';
import {
  recordAdminAccess,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AttemptOutcome,
} from './audit/record';
import type { CaseAction } from './inbox-actions';
import type { AdminSession } from './session-claims';

export type ConversationMessage =
  | { id: string; at: string; from: 'worker'; kind: 'text'; text: string }
  | { id: string; at: string; from: 'worker'; kind: 'media'; mediaId: string; mediaType: 'image' | 'audio' | 'document'; caption: string | null; expired: boolean }
  | { id: string; at: string; from: 'admin'; kind: 'text'; text: string; byRole: 'Read-only' | 'Ops' | 'Superadmin';
      delivery: 'queued' | 'sent' | 'delivered' | 'failed' | 'waiting_for_window'; via: 'freeform' | 'template' | null }
  | { id: string; at: string; from: 'system'; kind: 'note'; text: string };   // mode entered/exited, status changes, admins emailed

export type SupportConversation = {
  caseId: string; ref: string; kind: InboxItem['kind']; typeLabel: string;
  status: 'open' | 'pending_worker' | 'pending_admin' | 'resolved' | 'dismissed'; statusLabel: string;
  subject: string;
  language: 'es' | 'en'; languageLabel: 'Spanish' | 'English';
  messages: ConversationMessage[];                 // oldest first
  window: { open: boolean; closesAt: string | null; closedAt: string | null };
  reply: {
    mode: 'freeform' | 'template';                 // freeform while the window is open
    maxChars: number;                              // 1000 freeform, 250 template (one paragraph, newlines become spaces)
    templatePreview: { before: string; after: string } | null;  // the fixed text around the reply, in the worker's language
  };
  worker: {
    label: string;                                 // name if registered, else "Unregistered number"
    registered: boolean;
    userId: string | null;                         // users.id when registered, else null (FE-2 links superadmins to the access history)
    onboardingStepLabel: string | null; onboardingStepIndex: number | null; onboardingStepCount: number | null;
    failedCodesToday: number | null;
    joinedAt: string | null;
  };
  facts: { openedAt: string; waitingSince: string | null; messageCount: number; mediaCount: number; adminsEmailed: number };
  earlierCases: { caseId: string; ref: string; statusLabel: string; closedAt: string | null }[];
  actions: CaseAction[];                           // K2.7
};

// ---- Reads -------------------------------------------------------------------------

export const CONVERSATION_CASE_SQL = `
  SELECT c.id, c.case_type, c.status, c.summary, c.case_number, c.user_id, c.employer_id, c.conversation_id,
         c.created_at, c.status_changed_at, u.full_name AS user_name
    FROM admin_cases c
    LEFT JOIN users u ON u.id = c.user_id
   WHERE c.id = $1::uuid
`;
export const CONVERSATION_EVENTS_SQL = `
  SELECT id, event_type, actor_type, payload, created_at
    FROM admin_case_events
   WHERE case_id = $1::uuid
   ORDER BY created_at, (event_type = 'status_changed'), id
`;
export const CONVERSATION_VIEW_SQL = `
  SELECT has_conversation, language, window_open, window_closes_at, window_closed_at, registered,
         onboarding_step_key, failed_codes_today, joined_at
    FROM public.admin_support_case_view($1::uuid)
`;
/** The same conversation's or worker's other cases, newest first. */
export const EARLIER_CASES_SQL = `
  SELECT c.id, c.case_number, c.status, c.resolved_at, c.status_changed_at
    FROM admin_cases c
   WHERE c.id <> $1::uuid
     AND (($2::uuid IS NOT NULL AND c.conversation_id = $2::uuid) OR ($3::uuid IS NOT NULL AND c.user_id = $3::uuid))
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 10
`;

export type ConversationCaseRow = {
  id: string;
  case_type: string;
  status: string;
  summary: string;
  case_number: number | string | null;
  user_id: string | null;
  employer_id: string | null;
  conversation_id: string | null;
  created_at: Date | string;
  status_changed_at: Date | string;
  user_name: string | null;
};

export type ConversationEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
};

export type ConversationViewRow = {
  has_conversation: boolean;
  language: string | null;
  window_open: boolean;
  window_closes_at: Date | string | null;
  window_closed_at: Date | string | null;
  registered: boolean;
  onboarding_step_key: string | null;
  failed_codes_today: number | string | null;
  joined_at: Date | string | null;
};

export type EarlierCaseRow = {
  id: string;
  case_number: number | string | null;
  status: string;
  resolved_at: Date | string | null;
  status_changed_at: Date | string;
};

// ---- Mapping ---------------------------------------------------------------------

/** The support template around the reply (K2.8, admin_support_reply_v2_<lang>), split at {{1}}. */
export const TEMPLATE_PREVIEWS: Readonly<Record<'es' | 'en', { before: string; after: string }>> = {
  es: { before: 'Jale Soporte: «', after: '». Responde a este mensaje si necesitas más ayuda.' },
  en: { before: 'Jale Support replied to your help request: “', after: '”. Reply to this message if you need more help.' },
};

/** Support media is kept 90 days (migration 121). */
export const SUPPORT_MEDIA_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// The onboarding steps in order (lib/funnel.ts); an unknown key has no place.
const ONBOARDING_STEP_COUNT = stepOrder('');

const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'document']);
const ROLES: ReadonlySet<string> = new Set(['Read-only', 'Ops', 'Superadmin']);
const DISPATCH_EVENTS: ReadonlySet<string> = new Set([
  'admin_reply_sent',
  'admin_reply_failed',
  'admin_reply_send_unknown',
  'admin_reply_waiting_for_window',
]);

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Unexpected time');
  return date.toISOString();
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : asIso(value);
}

function text(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? 0));
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

type Delivery = { delivery: 'queued' | 'sent' | 'failed' | 'waiting_for_window'; via: 'freeform' | 'template' | null };

/** Each queued reply's latest dispatcher outcome, by outbox id. A send of unknown state stays queued. */
export function deliveryByOutbox(events: readonly ConversationEventRow[]): Map<string, Delivery> {
  const byOutbox = new Map<string, Delivery>();
  for (const event of events) {
    if (!DISPATCH_EVENTS.has(event.event_type)) continue;
    const outboxId = text(event.payload, 'outboxId');
    if (!outboxId) continue;
    const via = text(event.payload, 'via');
    const viaValue = via === 'freeform' || via === 'template' ? via : null;
    const current = byOutbox.get(outboxId);
    // A final outcome (sent, failed) is never undone by a later waiting note.
    if (current && (current.delivery === 'sent' || current.delivery === 'failed')) continue;
    switch (event.event_type) {
      case 'admin_reply_sent':
        byOutbox.set(outboxId, { delivery: 'sent', via: viaValue });
        break;
      case 'admin_reply_failed':
        byOutbox.set(outboxId, { delivery: 'failed', via: null });
        break;
      case 'admin_reply_waiting_for_window':
        byOutbox.set(outboxId, { delivery: 'waiting_for_window', via: null });
        break;
      default:
        if (!current) byOutbox.set(outboxId, { delivery: 'queued', via: null });
    }
  }
  return byOutbox;
}

/** A system note's text: the event's fixed title and detail, never a worker's or an admin's words. */
function noteText(event: ConversationEventRow): string {
  const title = text(event.payload, 'title') ?? event.event_type.replace(/_/g, ' ');
  const detail = text(event.payload, 'detail');
  return detail ? `${title}: ${detail}` : title;
}

/** The case's events as the conversation shows them, oldest first. Dispatcher outcomes fold into their reply. */
export function mapConversationMessages(events: readonly ConversationEventRow[], now: Date = new Date()): ConversationMessage[] {
  const deliveries = deliveryByOutbox(events);
  const messages: ConversationMessage[] = [];
  for (const event of events) {
    const base = { id: event.id, at: asIso(event.created_at) };
    switch (event.event_type) {
      case 'worker_message':
        messages.push({ ...base, from: 'worker', kind: 'text', text: text(event.payload, 'detail') ?? '' });
        break;
      case 'worker_media': {
        const mediaId = text(event.payload, 'mediaId');
        const mediaType = text(event.payload, 'mediaType');
        if (!mediaId || !mediaType || !MEDIA_TYPES.has(mediaType)) {
          messages.push({ ...base, from: 'system', kind: 'note', text: 'The worker sent a file that cannot be shown' });
          break;
        }
        messages.push({
          ...base,
          from: 'worker',
          kind: 'media',
          mediaId: mediaId.toLowerCase(),
          mediaType: mediaType as 'image' | 'audio' | 'document',
          caption: text(event.payload, 'caption'),
          expired: new Date(base.at).getTime() + SUPPORT_MEDIA_RETENTION_DAYS * DAY_MS <= now.getTime(),
        });
        break;
      }
      case 'admin_reply_queued': {
        const role = text(event.payload, 'byRole');
        const outboxId = text(event.payload, 'outboxId');
        const delivery = (outboxId && deliveries.get(outboxId)) || { delivery: 'queued' as const, via: null };
        messages.push({
          ...base,
          from: 'admin',
          kind: 'text',
          text: text(event.payload, 'detail') ?? '',
          // Replies queued before sprint 28 carry no role; only Ops and
          // Superadmin could send them.
          byRole: role && ROLES.has(role) ? (role as 'Read-only' | 'Ops' | 'Superadmin') : 'Ops',
          delivery: delivery.delivery,
          via: delivery.via,
        });
        break;
      }
      default:
        if (!DISPATCH_EVENTS.has(event.event_type)) {
          messages.push({ ...base, from: 'system', kind: 'note', text: noteText(event) });
        }
    }
  }
  return messages;
}

export function onboardingStep(stepKey: string | null): Pick<SupportConversation['worker'], 'onboardingStepLabel' | 'onboardingStepIndex' | 'onboardingStepCount'> {
  if (!stepKey) return { onboardingStepLabel: null, onboardingStepIndex: null, onboardingStepCount: null };
  if (stepKey === 'ready') {
    return { onboardingStepLabel: 'Finished onboarding', onboardingStepIndex: ONBOARDING_STEP_COUNT, onboardingStepCount: ONBOARDING_STEP_COUNT };
  }
  const index = stepOrder(stepKey);
  return {
    onboardingStepLabel: stepLabel(stepKey),
    onboardingStepIndex: index < ONBOARDING_STEP_COUNT ? index + 1 : null,
    onboardingStepCount: index < ONBOARDING_STEP_COUNT ? ONBOARDING_STEP_COUNT : null,
  };
}

export function mapSupportConversation(
  row: ConversationCaseRow,
  events: readonly ConversationEventRow[],
  view: ConversationViewRow,
  earlier: readonly EarlierCaseRow[],
  role: AdminSession['role'],
  now: Date = new Date(),
): SupportConversation {
  if (!isAdminCaseType(row.case_type)) throw new Error(`Unexpected case type: ${row.case_type}`);
  if (!isAdminCaseStatus(row.status)) throw new Error(`Unexpected case status: ${row.status}`);
  const status: AdminCaseStatus = row.status;
  const kind = CASE_KINDS[row.case_type];
  const language = view.language === 'en' ? 'en' : 'es';
  const messages = mapConversationMessages(events, now);
  const windowOpen = view.window_open === true;
  const mode = windowOpen ? 'freeform' : 'template';
  const caseId = row.id.toLowerCase();
  const registered = view.registered === true;

  return {
    caseId,
    ref: caseRef(row.case_number) ?? 'S-?',
    kind: kind.kind,
    typeLabel: kind.typeLabel,
    status,
    statusLabel: CASE_STATUS_LABELS[status],
    subject: row.summary,
    language,
    languageLabel: language === 'en' ? 'English' : 'Spanish',
    messages,
    window: { open: windowOpen, closesAt: isoOrNull(view.window_closes_at), closedAt: isoOrNull(view.window_closed_at) },
    reply: {
      mode,
      maxChars: mode === 'freeform' ? FREEFORM_REPLY_MAX_CHARS : TEMPLATE_REPLY_MAX_CHARS,
      templatePreview: mode === 'template' && view.has_conversation ? TEMPLATE_PREVIEWS[language] : null,
    },
    worker: {
      label: registered ? maskName(row.user_name) ?? 'Worker' : 'Unregistered number',
      registered,
      userId: registered && row.user_id ? row.user_id.toLowerCase() : null,
      ...onboardingStep(view.onboarding_step_key),
      failedCodesToday: view.failed_codes_today === null ? null : count(view.failed_codes_today),
      joinedAt: isoOrNull(view.joined_at),
    },
    facts: {
      openedAt: asIso(row.created_at),
      waitingSince: caseWaitingOn(status) === 'us' ? asIso(row.status_changed_at) : null,
      messageCount: messages.filter((m) => m.from === 'worker' || m.from === 'admin').length,
      mediaCount: messages.filter((m) => m.from === 'worker' && m.kind === 'media').length,
      adminsEmailed: events
        .filter((event) => event.event_type === 'admins_notified')
        .reduce((sum, event) => sum + count(event.payload?.count), 0),
    },
    earlierCases: earlier.map((item) => ({
      caseId: item.id.toLowerCase(),
      ref: caseRef(item.case_number) ?? 'S-?',
      statusLabel: isAdminCaseStatus(item.status) ? CASE_STATUS_LABELS[item.status] : item.status,
      closedAt: item.status === 'resolved' || item.status === 'dismissed'
        ? asIso(item.resolved_at ?? item.status_changed_at)
        : null,
    })),
    actions: getSupportActions({ status, hasConversation: view.has_conversation === true }, role),
  };
}

// null: not found, page 404s
export async function loadSupportConversation(session: AdminSession, caseId: string): Promise<SupportConversation | null> {
  const attempt = (outcome: AttemptOutcome) => recordAdminAttempt(session, {
    surface: 'admin.support_conversation',
    categories: ['cases', 'conversations'],
    ...(isUuid(caseId) ? { recordType: 'admin_case' as const, recordIds: [caseId] } : {}),
    resultCount: 0,
    outcome,
  });

  if (!isUuid(caseId)) {
    await attempt('not_found');
    return null;
  }

  let conversation: SupportConversation | null;
  try {
    conversation = await withAdminReadTransaction(session, async (client) => {
      const row = (await client.query<ConversationCaseRow>(CONVERSATION_CASE_SQL, [caseId])).rows[0];
      if (!row) {
        return null;
      }
      const events = (await client.query<ConversationEventRow>(CONVERSATION_EVENTS_SQL, [row.id])).rows;
      const view = (await client.query<ConversationViewRow>(CONVERSATION_VIEW_SQL, [row.id])).rows[0];
      if (!view) {
        return null;
      }
      const earlier = (await client.query<EarlierCaseRow>(EARLIER_CASES_SQL, [row.id, row.conversation_id, row.user_id])).rows;
      const mapped = mapSupportConversation(row, events, view, earlier, session.role);
      await recordAdminAccess(session, {
        surface: 'admin.support_conversation',
        categories: ['cases', 'conversations'],
        subjectUserIds: caseSubjectIds([row]),
        recordType: 'admin_case',
        recordIds: [mapped.caseId],
        resultCount: mapped.messages.length,
        purpose: { kind: 'case', id: mapped.caseId },
      }, client);
      return mapped;
    });
  } catch (error) {
    await attempt('failed');
    throw error;
  }

  if (!conversation) {
    await attempt('not_found');
  }
  return conversation;
}
