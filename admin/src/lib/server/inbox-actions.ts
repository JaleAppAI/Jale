/**
 * Contract K2.7 (sprint 28): the Inbox actions behind POST /api/inbox-actions.
 * BE-2b owns this module; FE-2 renders against it.
 *
 * Each action runs in one transaction on the console login and records its
 * event on the same client before COMMIT:
 *   reply / request_info / resolve   audit context -> admin_queue_support_message -> action event -> COMMIT
 *   reveal_phone                     admin_support_reveal_phone -> access event (with the reason) -> COMMIT -> number
 *   open_media                       admin_support_media_link   -> access event (link expiry)     -> COMMIT -> presigned GET
 *   reset_lockout                    audit context -> admin_reset_identity_lockout    -> action event -> COMMIT
 *   open_support_from_lockout        audit context -> admin_open_support_from_lockout -> action event -> COMMIT
 * The definers (migration 122) hold every rule that matters: the number is
 * read in SQL from the case's conversation and never reaches this process
 * except through reveal_phone; the template cap is checked against the
 * window on the database clock. A request the same admin already ran (same
 * requestId, same payload, last 24 hours) returns its first outcome and is
 * not recorded again; the same id with another payload is invalid_input.
 *
 * A refusal rolls the transaction back and is recorded as an attempt after
 * the transaction has ended. Never logged: the number, the text, keys, links
 * or any database message (it can carry values).
 */
import { canActOnInbox } from '../action-policy';
import { isInboxActionName, parseInboxAction } from '../action-requests';
import { TEMPLATE_REPLY_MAX_CHARS } from '../support-reply';
import type { LockoutResetReason } from './admin-lockouts';
import { setAdminAuditContext } from './audit/context';
import {
  recordAdminAccess,
  recordAdminAction,
  recordAdminAttempt,
  withAdminReadTransaction,
  type AdminAuditEvent,
  type AdminSurface,
  type AttemptOutcome,
  type AuditCategory,
  type AuditQueryClient,
  type AuditRecordType,
} from './audit/record';
import { payloadHashMatches, readActionBody } from './payload-hash';
import type { AdminSession } from './session-claims';
import { SUPPORT_MEDIA_LINK_SECONDS, presignSupportMedia, supportMediaBucket } from './support-media';

export type CaseActionId = 'reply' | 'request_info' | 'resolve' | 'reveal_phone' | 'reset_lockout' | 'open_support_from_lockout';

// server-computed; FE shows disabled + reason (never hides)
export type CaseAction = { id: CaseActionId; enabled: boolean; reason?: string };

export type InboxAction =
  | { action: 'reply'; requestId: string; caseId: string; text: string }
  | { action: 'request_info'; requestId: string; caseId: string; text: string }
  | { action: 'resolve'; requestId: string; caseId: string }
  | { action: 'reveal_phone'; requestId: string; caseId: string; justification: string }   // 20–500 chars
  | { action: 'open_media'; requestId: string; caseId: string; mediaId: string }
  | { action: 'reset_lockout'; requestId: string; challengeId: string; reasonCode: LockoutResetReason; note?: string } // note required for 'other', ≤ 300
  | { action: 'open_support_from_lockout'; requestId: string; challengeId: string };

export type InboxActionResult =
  | { ok: true; kind: 'done' }
  | { ok: true; kind: 'media'; url: string; expiresAt: string }      // FE: window.open(url, '_blank', 'noopener,noreferrer')
  | { ok: true; kind: 'phone'; phone: string }                         // shown in client state only, gone on refresh
  | { ok: true; kind: 'case'; caseId: string }                         // FE navigates to /inbox/support/<caseId>
  | { ok: false; error: InboxActionError; maxChars?: number };

export type InboxActionError =
  | 'invalid_input' | 'unauthorized' | 'session_expired' | 'forbidden' | 'not_found'
  | 'case_closed' | 'reply_too_long_for_template' | 'no_reply_target' | 'media_expired' | 'not_locked';

// ---- Definers (migration 122) ----------------------------------------------

export const QUEUE_SUPPORT_MESSAGE_SQL =
  'SELECT result_id, replayed FROM public.admin_queue_support_message($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)';
export const REVEAL_PHONE_SQL = 'SELECT public.admin_support_reveal_phone($1::uuid) AS phone';
export const MEDIA_LINK_SQL = 'SELECT outcome, s3_key, content_type FROM public.admin_support_media_link($1::uuid, $2::uuid)';
export const RESET_LOCKOUT_SQL =
  'SELECT result_id, replayed FROM public.admin_reset_identity_lockout($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid)';
export const OPEN_SUPPORT_SQL =
  'SELECT result_id, replayed FROM public.admin_open_support_from_lockout($1::uuid, $2::uuid, $3::uuid)';
/** The people a case is about, for the event's subjects. */
export const CASE_SUBJECTS_SQL = 'SELECT user_id, employer_id FROM admin_cases WHERE id = $1::uuid';

/** HTTP status per refusal (K2.7). */
export const INBOX_ACTION_HTTP_STATUS: Readonly<Record<InboxActionError, number>> = {
  invalid_input: 400,
  reply_too_long_for_template: 400,
  unauthorized: 401,
  session_expired: 401,
  forbidden: 403,
  not_found: 404,
  no_reply_target: 404,
  case_closed: 409,
  not_locked: 409,
  media_expired: 410,
};

// The refusals a definer raises, as SQLSTATE and message. Only these exact
// pairs are refusals; any other database error is a failure.
const DATABASE_REFUSALS: ReadonlyArray<readonly [string, InboxActionError]> = [
  ['22023', 'invalid_input'],
  ['42501', 'forbidden'],
  ['P0002', 'not_found'],
  ['P0001', 'case_closed'],
  ['P0001', 'reply_too_long_for_template'],
  ['P0001', 'no_reply_target'],
  ['P0001', 'not_locked'],
];

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionName = InboxAction['action'];

type ActionEvent = {
  surface: AdminSurface;
  categories: readonly AuditCategory[];
  recordType: AuditRecordType;
  fieldNames: readonly string[];
};

/** The record each action leaves: its surface, categories, record type and the columns it changes or shows. */
export const INBOX_ACTION_EVENTS: Readonly<Record<ActionName, ActionEvent>> = {
  reply: { surface: 'admin.inbox.reply', categories: ['cases', 'conversations'], recordType: 'admin_case', fieldNames: ['status'] },
  request_info: { surface: 'admin.inbox.request_info', categories: ['cases', 'conversations'], recordType: 'admin_case', fieldNames: ['status'] },
  resolve: { surface: 'admin.inbox.resolve', categories: ['cases', 'conversations'], recordType: 'admin_case', fieldNames: ['status', 'resolved_at'] },
  reveal_phone: { surface: 'admin.inbox.reveal_phone', categories: ['contact_details'], recordType: 'admin_case', fieldNames: ['phone'] },
  open_media: { surface: 'admin.inbox.open_media', categories: ['cases', 'conversations'], recordType: 'admin_case', fieldNames: [] },
  reset_lockout: {
    surface: 'admin.inbox.reset_lockout',
    categories: ['verifications'],
    recordType: 'identity_challenge',
    fieldNames: ['status', 'attempts', 'locked_until', 'expires_at', 'context'],
  },
  open_support_from_lockout: { surface: 'admin.inbox.open_support', categories: ['verifications', 'cases'], recordType: 'identity_challenge', fieldNames: [] },
};

/** What an attempt may name about a request, valid or not. */
type AttemptTarget = { action: ActionName; targetId?: string; caseId?: string; justification?: string };

class InboxRefusal extends Error {
  constructor(readonly error: InboxActionError) {
    super('refused');
  }
}

type FailureBody = { ok: false; error: 'failed' };

function reply(status: number, body: InboxActionResult | FailureBody): Response {
  // Never cached: a number and a link are shown once and gone.
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : 'unknown';
}

/** A definer's refusal, or undefined for any other error. */
export function databaseRefusal(error: unknown): InboxActionError | undefined {
  const code = sqlStateOf(error);
  const message = (error as { message?: unknown } | null)?.message;
  const match = DATABASE_REFUSALS.find(([state, refusal]) => state === code && message === refusal);
  return match?.[1];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function uuidOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function attemptTargetOf(value: unknown): AttemptTarget | null {
  const body = asRecord(value);
  if (!body || !isInboxActionName(body.action)) return null;
  const caseId = uuidOrUndefined(body.caseId);
  const challengeId = uuidOrUndefined(body.challengeId);
  const lockout = body.action === 'reset_lockout' || body.action === 'open_support_from_lockout';
  return {
    action: body.action,
    ...(lockout ? (challengeId ? { targetId: challengeId } : {}) : (caseId ? { targetId: caseId, caseId } : {})),
    ...(typeof body.justification === 'string' ? { justification: body.justification.trim() } : {}),
  };
}

function targetOf(action: InboxAction): AttemptTarget {
  switch (action.action) {
    case 'reset_lockout':
    case 'open_support_from_lockout':
      return { action: action.action, targetId: action.challengeId };
    case 'reveal_phone':
      return { action: action.action, targetId: action.caseId, caseId: action.caseId, justification: action.justification };
    default:
      return { action: action.action, targetId: action.caseId, caseId: action.caseId };
  }
}

function purposeOf(target: AttemptTarget, session: AdminSession | null): AdminAuditEvent['purpose'] {
  if (target.action === 'reveal_phone') {
    // Only a signed-in admin's reason is kept, and only when the record can hold it.
    const reason = session && target.justification && target.justification.length >= 20
      && target.justification.length <= 500 && !target.justification.includes('\u0000')
      ? target.justification
      : undefined;
    return reason ? { kind: 'reveal', reason } : undefined;
  }
  if (target.action === 'reset_lockout' || target.action === 'open_support_from_lockout') {
    return { kind: 'verification' };
  }
  return target.caseId ? { kind: 'case', id: target.caseId } : undefined;
}

function eventFor(target: AttemptTarget, session: AdminSession | null, subjects: readonly string[] = []): AdminAuditEvent {
  const event = INBOX_ACTION_EVENTS[target.action];
  const purpose = purposeOf(target, session);
  return {
    surface: event.surface,
    categories: event.categories,
    subjectUserIds: subjects,
    ...(target.targetId ? { recordType: event.recordType, recordIds: [target.targetId] } : {}),
    fieldNames: event.fieldNames,
    ...(purpose ? { purpose } : {}),
  };
}

function attemptOutcomeOf(error: InboxActionError): AttemptOutcome {
  if (error === 'not_found') return 'not_found';
  if (error === 'forbidden') return 'denied';
  return 'failed';
}

async function refuse(session: AdminSession, target: AttemptTarget, error: InboxActionError): Promise<Response> {
  await recordAdminAttempt(session, { ...eventFor(target, session), resultCount: 0, outcome: attemptOutcomeOf(error) });
  return reply(INBOX_ACTION_HTTP_STATUS[error], {
    ok: false,
    error,
    ...(error === 'reply_too_long_for_template' ? { maxChars: TEMPLATE_REPLY_MAX_CHARS } : {}),
  });
}

async function fail(session: AdminSession, target: AttemptTarget, error: unknown, code?: string): Promise<Response> {
  console.error(JSON.stringify({
    event: 'inbox_action_failed',
    action: target.action,
    code: code ?? sqlStateOf(error),
    request_id: session.requestId,
  }));
  await recordAdminAttempt(session, { ...eventFor(target, session), resultCount: 0, outcome: 'failed' });
  return reply(500, { ok: false, error: 'failed' });
}

async function settle(session: AdminSession, target: AttemptTarget, error: unknown): Promise<Response> {
  const refusal = error instanceof InboxRefusal ? error.error : databaseRefusal(error);
  return refusal ? refuse(session, target, refusal) : fail(session, target, error);
}

/** The case's worker and employer ids; null when there is no such case. */
async function caseSubjectsOrNull(client: AuditQueryClient, caseId: string): Promise<string[] | null> {
  const { rows } = await client.query<{ user_id: string | null; employer_id: string | null }>(CASE_SUBJECTS_SQL, [caseId]);
  if (rows.length === 0) return null;
  return [rows[0].user_id, rows[0].employer_id].filter((id): id is string => typeof id === 'string');
}

async function caseSubjects(client: AuditQueryClient, caseId: string): Promise<string[]> {
  return (await caseSubjectsOrNull(client, caseId)) ?? [];
}

type MutationRow = { result_id: string | null; replayed: boolean };

function oneRow<Row>(rows: Row[]): Row {
  if (rows.length !== 1) {
    throw new Error('expected one row');
  }
  return rows[0];
}

/** The acting admin, as the definers take it: admin_users.id, or NULL (refused there as forbidden). */
function actorOf(session: AdminSession): string | null {
  return session.adminUserId ?? null;
}

// ---- The actions ------------------------------------------------------------------

type CaseMessageAction = Extract<InboxAction, { action: 'reply' | 'request_info' | 'resolve' }>;

async function queueCaseMessage(session: AdminSession, action: CaseMessageAction): Promise<Response> {
  const target = targetOf(action);
  const kind = action.action === 'resolve' ? 'closing' : action.action;
  const text = action.action === 'resolve' ? null : action.text;
  try {
    await withAdminReadTransaction(session, async (client) => {
      // The change records this transaction's writes leave name the admin,
      // the action and the request.
      await setAdminAuditContext(client, session, INBOX_ACTION_EVENTS[action.action].surface);
      const row = oneRow((await client.query<MutationRow>(QUEUE_SUPPORT_MESSAGE_SQL, [
        actorOf(session), action.caseId, action.requestId, kind, text,
      ])).rows);
      if (row.replayed !== true) {
        await recordAdminAction(session, { ...eventFor(target, session, await caseSubjects(client, action.caseId)), resultCount: 1 }, client);
      }
    });
    return reply(200, { ok: true, kind: 'done' });
  } catch (error) {
    return settle(session, target, error);
  }
}

async function revealPhone(session: AdminSession, action: Extract<InboxAction, { action: 'reveal_phone' }>): Promise<Response> {
  const target = targetOf(action);
  try {
    const phone = await withAdminReadTransaction(session, async (client) => {
      const subjects = await caseSubjectsOrNull(client, action.caseId);
      if (subjects === null) {
        throw new InboxRefusal('not_found');
      }
      const row = oneRow((await client.query<{ phone: string | null }>(REVEAL_PHONE_SQL, [action.caseId])).rows);
      if (typeof row.phone !== 'string' || !row.phone) {
        throw new InboxRefusal('no_reply_target');
      }
      // The number leaves only after this record commits with the read.
      await recordAdminAccess(session, { ...eventFor(target, session, subjects), resultCount: 1 }, client);
      return row.phone;
    });
    return reply(200, { ok: true, kind: 'phone', phone });
  } catch (error) {
    return settle(session, target, error);
  }
}

type MediaRow = { outcome: string; s3_key: string | null; content_type: string | null };
type MediaLink = { key: string; contentType: string | null; issuedAt: Date; expiresAt: Date };

async function openMedia(session: AdminSession, action: Extract<InboxAction, { action: 'open_media' }>): Promise<Response> {
  const target = targetOf(action);
  // Checked before the transaction, so no access event is kept for a link
  // that could not be minted.
  const bucket = supportMediaBucket();
  if (!bucket) {
    return fail(session, target, undefined, 'support_media_bucket_unset');
  }

  let link: MediaLink;
  try {
    link = await withAdminReadTransaction(session, async (client) => {
      const row = oneRow((await client.query<MediaRow>(MEDIA_LINK_SQL, [action.caseId, action.mediaId])).rows);
      if (row.outcome === 'not_found' || row.outcome === 'media_expired') {
        throw new InboxRefusal(row.outcome);
      }
      if (row.outcome !== 'ok' || typeof row.s3_key !== 'string' || !row.s3_key) {
        throw new Error('media: the outcome row has no usable key');
      }
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + SUPPORT_MEDIA_LINK_SECONDS * 1000);
      await recordAdminAccess(session, {
        ...eventFor(target, session, await caseSubjects(client, action.caseId)),
        resultCount: 1,
        linkExpiresAt: expiresAt,
      }, client);
      return { key: row.s3_key, contentType: row.content_type, issuedAt, expiresAt };
    });
  } catch (error) {
    return settle(session, target, error);
  }

  try {
    const url = await presignSupportMedia({ bucket, key: link.key, contentType: link.contentType, issuedAt: link.issuedAt });
    return reply(200, { ok: true, kind: 'media', url, expiresAt: link.expiresAt.toISOString() });
  } catch (error) {
    return fail(session, target, error);
  }
}

type LockoutAction = Extract<InboxAction, { action: 'reset_lockout' | 'open_support_from_lockout' }>;

async function lockoutAction(session: AdminSession, action: LockoutAction): Promise<Response> {
  const target = targetOf(action);
  try {
    const caseId = await withAdminReadTransaction(session, async (client) => {
      await setAdminAuditContext(client, session, INBOX_ACTION_EVENTS[action.action].surface);
      const row = oneRow((action.action === 'reset_lockout'
        ? await client.query<MutationRow>(RESET_LOCKOUT_SQL, [
          actorOf(session), action.challengeId, action.reasonCode, action.note ?? null, action.requestId,
        ])
        : await client.query<MutationRow>(OPEN_SUPPORT_SQL, [actorOf(session), action.challengeId, action.requestId])).rows);
      if (typeof row.result_id !== 'string' || !UUID_PATTERN.test(row.result_id)) {
        throw new Error('lockout: the definer returned no case');
      }
      if (row.replayed !== true) {
        await recordAdminAction(session, { ...eventFor(target, session), resultCount: 1 }, client);
      }
      return row.result_id.toLowerCase();
    });
    return action.action === 'reset_lockout'
      ? reply(200, { ok: true, kind: 'done' })
      : reply(200, { ok: true, kind: 'case', caseId });
  } catch (error) {
    return settle(session, target, error);
  }
}

// ---- The route ------------------------------------------------------------------

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * POST /api/inbox-actions for a signed-in admin (the route answers 401 before
 * this). A body that names no known action has no surface to record against,
 * so it is answered 400 without an attempt event.
 */
export async function handleInboxActionRequest(request: Request, session: AdminSession): Promise<Response> {
  const text = await readActionBody(request);
  const body = text === null ? undefined : parseJson(text);
  const named = attemptTargetOf(body);

  if (text === null || !payloadHashMatches(request, text)) {
    if (named) await recordAdminAttempt(session, { ...eventFor(named, session), resultCount: 0, outcome: 'failed' });
    return reply(400, { ok: false, error: 'invalid_input' });
  }

  const parsed = parseInboxAction(body);
  if (!parsed.ok) {
    if (named) await recordAdminAttempt(session, { ...eventFor(named, session), resultCount: 0, outcome: 'failed' });
    return reply(400, { ok: false, error: 'invalid_input' });
  }

  const action = parsed.value;
  // open_media is a read every role may make (K2.7, CCR-2); everything else
  // needs Ops or Superadmin, checked here whatever the page offered.
  if (action.action !== 'open_media' && !canActOnInbox(session.role)) {
    return refuse(session, targetOf(action), 'forbidden');
  }

  switch (action.action) {
    case 'reply':
    case 'request_info':
    case 'resolve':
      return queueCaseMessage(session, action);
    case 'reveal_phone':
      return revealPhone(session, action);
    case 'open_media':
      return openMedia(session, action);
    case 'reset_lockout':
    case 'open_support_from_lockout':
      return lockoutAction(session, action);
  }
}
