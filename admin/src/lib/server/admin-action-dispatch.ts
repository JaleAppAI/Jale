import { validateAdminAction, type AdminActionRequest } from '../action-requests';
import type { AdminCaseStatus, AdminCaseType } from '../types';
import type { AdminSession } from './session-claims';
import { revealCaseContact, type CaseContactReveal, type RevealedContact } from './admin-cases';
import { MAX_REASON_LENGTH, isUuid, type AttemptOutcome } from './audit/codes';
import { setAdminAuditContext } from './audit/context';
import {
  recordAdminAccess,
  recordAdminAction,
  recordAdminAttempt,
  type AdminAuditEvent,
} from './audit/record';
import { getAdminDbPool } from './db';

export type AdminActionDispatchResult =
  | { ok: true; message: string; revealed?: RevealedContact }
  | { ok: false; status: 400 | 403 | 404 | 409 | 501; message: string };

type MutationSpec = {
  sql: string;
  params: unknown[];
};

type DbClient = {
  query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount?: number | null }>;
};

// Reads the raw contact for a reveal_pii action, inside the reveal's
// transaction; the read is recorded before COMMIT.
type RevealFn = (client: DbClient) => Promise<CaseContactReveal>;

// The locked case an action applies to.
type CaseTarget = {
  status: string;
  caseType: string;
  userId: string | null;
  employerId: string | null;
};

// Column names each case action changes. Recorded with the action: names
// only, never the note or the message.
const CHANGED_FIELDS = {
  request_more_info: ['status', 'details'],
  resolve_case: ['status', 'resolved_at'],
  reply_whatsapp: ['status', 'details'],
} as const;

const REVEALED_FIELDS = ['full_name', 'phone', 'email'];

/**
 * The record for a case action, from the request and the locked case. A
 * reveal is a read of the subject's contact details, with the admin's
 * reason; the other actions record the case and its people, with no free
 * text. Ids that are not UUIDs are never put into a record.
 */
function caseActionEvent(request: AdminActionRequest, target: CaseTarget | undefined): AdminAuditEvent {
  const caseIds = isUuid(request.targetId) ? [request.targetId] : [];

  if (request.actionId === 'reveal_pii') {
    const subject = target ? target.userId ?? target.employerId : null;
    return {
      surface: 'admin.case_detail.reveal',
      categories: ['contact_details'],
      subjectUserIds: subject ? [subject] : [],
      recordType: 'admin_case',
      recordIds: caseIds,
      fieldNames: REVEALED_FIELDS,
      purpose: { kind: 'reveal', reason: request.justification ?? '' },
    };
  }

  const actionId = request.actionId === 'request_more_info' || request.actionId === 'reply_whatsapp'
    ? request.actionId
    : 'resolve_case';
  const people = request.actionId === 'reply_whatsapp'
    ? [target?.userId]
    : [target?.userId, target?.employerId];

  return {
    surface: `admin.case_detail.${actionId}`,
    categories: actionId === 'reply_whatsapp' ? ['cases', 'conversations'] : ['cases'],
    subjectUserIds: people.filter((id): id is string => Boolean(id)),
    recordType: 'admin_case',
    recordIds: caseIds,
    fieldNames: CHANGED_FIELDS[actionId],
    ...(caseIds.length > 0 ? { purpose: { kind: 'case' as const, id: caseIds[0] } } : {}),
  };
}

type MutationInput = {
  note?: string;
  justification?: string;
};

const ADMIN_SUPPORT_TEMPLATE_EN = 'admin_support_reply_en';
const ADMIN_SUPPORT_TEMPLATE_ES = 'admin_support_reply_es';
const ADMIN_TEMPLATE_VARIABLE_MAX_CHARS = 250;

function normalizeTemplateVariableText(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= ADMIN_TEMPLATE_VARIABLE_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, ADMIN_TEMPLATE_VARIABLE_MAX_CHARS - 1).trimEnd()}…`;
}

function adminSupportTemplateForLanguage(language: string | null | undefined): string {
  return language?.toLowerCase().startsWith('es')
    ? ADMIN_SUPPORT_TEMPLATE_ES
    : ADMIN_SUPPORT_TEMPLATE_EN;
}

export function buildAdminReplyOutboxInsert(input: {
  targetId: string;
  requestId: string;
  message: string;
  whatsappNumber: string;
  language?: string | null;
}): MutationSpec {
  return {
    // C3: idx_whatsapp_outbox_idempotency is a PARTIAL unique index
    // (WHERE idempotency_key IS NOT NULL). Postgres only uses a partial index
    // as an ON CONFLICT arbiter when the statement repeats the index predicate,
    // so the WHERE clause below is required — without it this INSERT throws
    // "no unique or exclusion constraint matching the ON CONFLICT specification".
    sql: `INSERT INTO whatsapp_outbox
      (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables, status, source_type, source_id, idempotency_key)
     VALUES (NULL, 0, $1, NULL, $2, $3::jsonb, 'pending', 'admin_case', $4, $5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`.replace(/\s+/g, ' ').trim(),
    params: [
      input.whatsappNumber,
      adminSupportTemplateForLanguage(input.language),
      JSON.stringify({
        '1': normalizeTemplateVariableText(input.message),
        __fallback_body: input.message,
      }),
      input.targetId,
      `admin-reply:${input.requestId}`,
    ],
  };
}

export function buildCaseMutation(actionId: AdminActionRequest['actionId'], input: MutationInput): MutationSpec | undefined {
  if (actionId === 'request_more_info') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND status NOT IN ('resolved', 'dismissed')`,
      params: ['case-id', 'pending_worker', JSON.stringify({ lastAdminNote: input.note ?? input.justification ?? '' })],
    };
  }

  if (actionId === 'resolve_case') {
    return {
      sql: `UPDATE admin_cases SET status = $2, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND status <> 'resolved'`,
      params: ['case-id', 'resolved'],
    };
  }

  if (actionId === 'reveal_pii') {
    return undefined;
  }

  return undefined;
}

function forTargetId(spec: MutationSpec | undefined, targetId: string): MutationSpec | undefined {
  if (!spec) {
    return undefined;
  }

  return {
    sql: spec.sql,
    params: [targetId, ...spec.params.slice(1)],
  };
}

export async function dispatchAdminAction(session: AdminSession, request: AdminActionRequest): Promise<AdminActionDispatchResult> {
  if (request.targetType === 'whatsapp_outbox' || request.actionId === 'resend_outbound') {
    return {
      ok: false,
      status: 501,
      message: 'WhatsApp admin actions must be wired through the existing outbox path before use.',
    };
  }

  if (request.targetType === 'admin_case') {
    // The reason is recorded with the reveal, and the record holds at most
    // 500 characters: refuse a longer one before anything is read.
    if (request.actionId === 'reveal_pii' && (request.justification?.trim().length ?? 0) > MAX_REASON_LENGTH) {
      return { ok: false, status: 400, message: `Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.` };
    }

    // An id that is not a UUID names no case: it is never queried.
    if (!isUuid(request.targetId)) {
      await recordAdminAttempt(session, { ...caseActionEvent(request, undefined), resultCount: 0, outcome: 'not_found' });
      return { ok: false, status: 404, message: 'Admin case not found.' };
    }

    if (request.actionId === 'reply_whatsapp') {
      return sendCaseWhatsAppReply(session, request);
    }

    const reveal: RevealFn | undefined = request.actionId === 'reveal_pii'
      ? (client) => revealCaseContact(client, request.targetId)
      : undefined;

    return executeMutation(session, request, forTargetId(buildCaseMutation(request.actionId, request), request.targetId), reveal);
  }

  return { ok: false, status: 400, message: 'Unsupported admin action target.' };
}

async function sendCaseWhatsAppReply(
  session: AdminSession,
  request: AdminActionRequest,
): Promise<AdminActionDispatchResult> {
  const message = request.note?.trim();
  if (!message || message.length > 1000 || !request.requestId) {
    return { ok: false, status: 400, message: 'Enter a WhatsApp reply of 1 to 1000 characters.' };
  }

  const pool = await getAdminDbPool();
  const client = await pool.connect();
  let target: CaseTarget | undefined;
  let attempt: AttemptOutcome | undefined;
  let failure: unknown;
  let result: AdminActionDispatchResult | undefined;
  let released = false;

  try {
    await client.query('BEGIN');
    // The change records this transaction's writes leave name the admin,
    // the action and the request.
    await setAdminAuditContext(client, session, caseActionEvent(request, undefined).surface);
    const recipient = await client.query<{
      whatsapp_number: string | null;
      status: AdminCaseStatus;
      case_type: AdminCaseType;
      user_id: string | null;
      language: string | null;
    }>(
      `SELECT c.status, c.case_type, c.user_id,
              COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, '')) AS whatsapp_number,
              COALESCE(
                NULLIF(c.details->>'language', ''),
                NULLIF(c.details->>'workerLanguage', ''),
                NULLIF(c.details->>'locale', '')
              ) AS language
         FROM admin_cases c
         JOIN users u ON u.id = c.user_id
        WHERE c.id = $1
          AND c.conversation_id IS NOT NULL
        FOR UPDATE OF c`,
      [request.targetId],
    );
    const row = recipient.rows[0];
    if (row) {
      target = { status: row.status, caseType: row.case_type, userId: row.user_id, employerId: null };
    }
    const phone = row?.whatsapp_number;
    const validation = row
      ? validateAdminAction({
          actor: session.email ?? session.sub,
          role: session.role,
          request,
          targetKind: 'case',
          targetStatus: row.status,
          targetCaseType: row.case_type,
        })
      : undefined;

    if (!row || !phone) {
      await client.query('ROLLBACK');
      attempt = 'denied';
      result = { ok: false, status: 409, message: 'This case is not linked to a WhatsApp worker conversation.' };
    } else if (validation && !validation.ok) {
      await client.query('ROLLBACK');
      attempt = 'denied';
      result = { ok: false, status: validation.status, message: validation.message };
    } else {
      const outbox = buildAdminReplyOutboxInsert({
        targetId: request.targetId,
        requestId: request.requestId,
        message,
        whatsappNumber: phone,
        language: row.language,
      });
      const inserted = await client.query<{ id: string }>(outbox.sql, outbox.params);
      if (inserted.rows.length === 0) {
        // The same request was already queued: nothing changes, nothing is recorded.
        await client.query('COMMIT');
        result = { ok: true, message: 'WhatsApp reply is already queued.' };
      } else {
        // The message body is kept only in the case timeline.
        await client.query(
          `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
           VALUES ($1, 'admin_reply_queued', 'admin', $2, $3::jsonb)`,
          [
            request.targetId,
            session.email ?? session.sub,
            JSON.stringify({
              title: 'WhatsApp reply queued',
              detail: message,
              outboxId: inserted.rows[0].id,
            }),
          ],
        );
        const updated = await client.query(
          `UPDATE admin_cases
              SET status = 'pending_worker',
                  details = details || $2::jsonb,
                  updated_at = NOW()
            WHERE id = $1
              AND status NOT IN ('resolved', 'dismissed')`,
          [request.targetId, JSON.stringify({ lastAdminNote: message })],
        );
        if (updated.rowCount === 0) {
          await client.query('ROLLBACK');
          attempt = 'denied';
          result = staleResult();
        } else {
          await recordAdminAction(session, { ...caseActionEvent(request, target), resultCount: 1 }, client);
          await client.query('COMMIT');
          result = { ok: true, message: 'WhatsApp reply queued for delivery.' };
        }
      }
    }
  } catch (error) {
    failure = error;
    attempt = 'failed';
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      client.release(rollbackError as Error);
      released = true;
    }
  } finally {
    if (!released) {
      client.release();
    }
  }

  // Refusals and failures are recorded after the transaction has ended and
  // its connection has been returned.
  if (attempt) {
    await recordAdminAttempt(session, { ...caseActionEvent(request, target), resultCount: 0, outcome: attempt });
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result as AdminActionDispatchResult;
}

async function executeMutation(
  session: AdminSession,
  request: AdminActionRequest,
  mutation: MutationSpec | undefined,
  reveal?: RevealFn,
): Promise<AdminActionDispatchResult> {
  const pool = await getAdminDbPool();
  const client = await pool.connect();
  let target: CaseTarget | undefined;
  let attempt: AttemptOutcome | undefined;
  let failure: unknown;
  let result: AdminActionDispatchResult | undefined;
  let released = false;

  try {
    await client.query('BEGIN');
    // The change records this transaction's writes leave name the admin,
    // the action and the request.
    await setAdminAuditContext(client, session, caseActionEvent(request, undefined).surface);
    target = await lockAdminTarget(client as unknown as DbClient, request.targetId);
    const validation = target
      ? validateAdminAction({
          actor: session.email ?? session.sub,
          role: session.role,
          request,
          targetKind: 'case',
          targetStatus: target.status as AdminCaseStatus,
          targetCaseType: target.caseType as AdminCaseType,
        })
      : undefined;

    if (!target) {
      await client.query('ROLLBACK');
      attempt = 'not_found';
      result = { ok: false, status: 404, message: 'Admin case not found.' };
    } else if (validation && !validation.ok) {
      await client.query('ROLLBACK');
      attempt = 'denied';
      result = { ok: false, status: validation.status, message: validation.message };
    } else if (mutation) {
      const updated = await client.query(mutation.sql, mutation.params);
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        attempt = 'denied';
        result = staleResult();
      } else {
        await recordAdminAction(session, { ...caseActionEvent(request, target), resultCount: updated.rowCount ?? 1 }, client);
        await client.query('COMMIT');
        result = { ok: true, message: 'Admin action applied.' };
      }
    } else if (reveal) {
      // The contact is read and its record written in one transaction: the
      // contact is returned only if the record commits.
      const { contact, subjectUserId } = await reveal(client as unknown as DbClient);
      await recordAdminAccess(session, {
        ...caseActionEvent(request, target),
        subjectUserIds: subjectUserId ? [subjectUserId] : [],
        resultCount: subjectUserId ? 1 : 0,
      }, client);
      await client.query('COMMIT');
      result = { ok: true, message: 'Contact revealed.', revealed: contact };
    } else {
      await client.query('ROLLBACK');
      result = { ok: false, status: 400, message: 'Unsupported admin action.' };
    }
  } catch (error) {
    failure = error;
    attempt = 'failed';
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      client.release(rollbackError as Error);
      released = true;
    }
  } finally {
    if (!released) {
      client.release();
    }
  }

  // Refusals and failures are recorded after the transaction has ended and
  // its connection has been returned; a failed reveal keeps its reason.
  if (attempt) {
    await recordAdminAttempt(session, { ...caseActionEvent(request, target), resultCount: 0, outcome: attempt });
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result as AdminActionDispatchResult;
}

async function lockAdminTarget(
  client: DbClient,
  targetId: string,
): Promise<CaseTarget | undefined> {
  const result = await client.query<{
    status: string;
    case_type: string;
    user_id: string | null;
    employer_id: string | null;
  }>(
    `SELECT status, case_type, user_id, employer_id
       FROM admin_cases
      WHERE id = $1
      FOR UPDATE`,
    [targetId],
  );
  const row = result.rows[0];
  return row
    ? { status: row.status, caseType: row.case_type, userId: row.user_id, employerId: row.employer_id }
    : undefined;
}

function staleResult(): AdminActionDispatchResult {
  return {
    ok: false,
    status: 409,
    message: 'This item was already updated by another operator. Refresh and try again.',
  };
}
