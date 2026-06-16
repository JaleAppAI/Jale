import { buildAdminAuditEvent } from '../audit-contract';
import { validateAdminAction, type AdminActionRequest } from '../action-requests';
import type { AdminCaseStatus, AdminCaseType, VerificationRecord } from '../types';
import type { AdminSession } from './session-claims';
import { revealCaseContact, type RevealedContact } from './admin-cases';
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

// Runs AFTER the pii_reveal audit row, in the same transaction. Returns the
// raw contact for an audited reveal_pii action; undefined for all other actions.
type RevealFn = (client: DbClient) => Promise<RevealedContact>;

type MutationInput = {
  note?: string;
  justification?: string;
};

export function buildAdminReplyOutboxInsert(input: {
  targetId: string;
  requestId: string;
  message: string;
  whatsappNumber: string;
}): MutationSpec {
  return {
    // C3: idx_whatsapp_outbox_idempotency is a PARTIAL unique index
    // (WHERE idempotency_key IS NOT NULL). Postgres only uses a partial index
    // as an ON CONFLICT arbiter when the statement repeats the index predicate,
    // so the WHERE clause below is required — without it this INSERT throws
    // "no unique or exclusion constraint matching the ON CONFLICT specification".
    sql: `INSERT INTO whatsapp_outbox
      (inbound_message_sid, sequence, whatsapp_number, body, status, source_type, source_id, idempotency_key)
     VALUES (NULL, 0, $1, $2, 'pending', 'admin_case', $3, $4)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`.replace(/\s+/g, ' ').trim(),
    params: [
      input.whatsappNumber,
      input.message,
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

export function buildVerificationMutation(actionId: AdminActionRequest['actionId'], input: MutationInput): MutationSpec | undefined {
  if (actionId === 'approve_verification') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
      params: ['verification-id', 'resolved', JSON.stringify({ verificationStatus: 'approved' })],
    };
  }

  if (actionId === 'reject_verification') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
      params: ['verification-id', 'dismissed', JSON.stringify({
        verificationStatus: 'rejected',
        rejectionReason: input.justification ?? input.note ?? '',
      })],
    };
  }

  if (actionId === 'request_more_info') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
      params: ['verification-id', 'pending_worker', JSON.stringify({
        verificationStatus: 'needs_more_info',
        lastAdminNote: input.note ?? input.justification ?? '',
      })],
    };
  }

  if (actionId === 'reset_verification_step') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker' AND status NOT IN ('resolved', 'dismissed')`,
      params: ['verification-id', 'pending_worker', JSON.stringify({
        verificationStatus: 'reset',
        resetReason: input.note ?? input.justification ?? '',
      })],
    };
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

async function insertAudit(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, session: AdminSession, request: AdminActionRequest) {
  const audit = buildAdminAuditEvent({
    actor: session.email ?? session.sub,
    actionId: request.actionId,
    targetType: request.targetType,
    targetId: request.targetId,
    justification: request.justification,
    note: request.note,
  });

  await client.query(
    `INSERT INTO admin_audit_log
      (actor_email, actor_role, action, target_type, target_id, pii_reveal, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      session.email,
      session.role,
      request.actionId,
      request.targetType,
      request.targetId,
      audit.piiReveal,
      JSON.stringify({
        summary: audit.summary,
        justification: audit.justification,
        note: audit.note,
      }),
    ],
  );
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
    if (request.actionId === 'reply_whatsapp') {
      return sendCaseWhatsAppReply(session, request);
    }

    const reveal: RevealFn | undefined = request.actionId === 'reveal_pii'
      ? (client) => revealCaseContact(client, request.targetId)
      : undefined;

    return executeMutation(
      session,
      request,
      'case',
      forTargetId(buildCaseMutation(request.actionId, request), request.targetId),
      reveal,
    );
  }

  if (request.targetType === 'verification') {
    return executeMutation(
      session,
      request,
      'verification',
      forTargetId(buildVerificationMutation(request.actionId, request), request.targetId),
    );
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
  try {
    await client.query('BEGIN');
    const recipient = await client.query<{
      whatsapp_number: string | null;
      status: AdminCaseStatus;
      case_type: AdminCaseType;
    }>(
      `SELECT c.status, c.case_type,
              COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, '')) AS whatsapp_number
         FROM admin_cases c
         JOIN users u ON u.id = c.user_id
        WHERE c.id = $1
          AND c.conversation_id IS NOT NULL
        FOR UPDATE OF c`,
      [request.targetId],
    );
    const target = recipient.rows[0];
    const phone = target?.whatsapp_number;
    if (!phone) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, message: 'This case is not linked to a WhatsApp worker conversation.' };
    }
    const validation = validateAdminAction({
      actor: session.email ?? session.sub,
      role: session.role,
      request,
      targetKind: 'case',
      targetStatus: target.status,
      targetCaseType: target.case_type,
    });
    if (!validation.ok) {
      await client.query('ROLLBACK');
      return { ok: false, status: validation.status, message: validation.message };
    }

    const outbox = buildAdminReplyOutboxInsert({
      targetId: request.targetId,
      requestId: request.requestId,
      message,
      whatsappNumber: phone,
    });
    const inserted = await client.query<{ id: string }>(outbox.sql, outbox.params);
    if (inserted.rows.length === 0) {
      await client.query('COMMIT');
      return { ok: true, message: 'WhatsApp reply is already queued.' };
    }

    await insertAudit(client, session, request);
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
      return staleResult();
    }
    await client.query('COMMIT');
    return { ok: true, message: 'WhatsApp reply queued for delivery.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeMutation(
  session: AdminSession,
  request: AdminActionRequest,
  targetKind: 'case' | 'verification',
  mutation: MutationSpec | undefined,
  reveal?: RevealFn,
): Promise<AdminActionDispatchResult> {
  const pool = await getAdminDbPool();
  const client = await pool.connect();

  let released = false;
  try {
    await client.query('BEGIN');
    const target = await lockAdminTarget(client as unknown as DbClient, request.targetId, targetKind);
    if (!target) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        status: 404,
        message: targetKind === 'case' ? 'Admin case not found.' : 'Verification record not found.',
      };
    }
    const validation = targetKind === 'case'
      ? validateAdminAction({
          actor: session.email ?? session.sub,
          role: session.role,
          request,
          targetKind: 'case',
          targetStatus: target.status as AdminCaseStatus,
          targetCaseType: target.caseType as AdminCaseType,
        })
      : validateAdminAction({
          actor: session.email ?? session.sub,
          role: session.role,
          request,
          targetKind: 'verification',
          targetStatus: target.status as VerificationRecord['status'],
          targetStep: target.step as VerificationRecord['step'],
        });
    if (!validation.ok) {
      await client.query('ROLLBACK');
      return { ok: false, status: validation.status, message: validation.message };
    }
    // Audit insert and reveal read run in ONE transaction: PII is only returned
    // if the audit row commits, so there is never a reveal without an audit
    // trail. A failure during the reveal rolls back both (no record of the
    // attempt) — acceptable because no PII left the DB in that case.
    await insertAudit(client, session, request);

    if (mutation) {
      const result = await client.query(mutation.sql, mutation.params);
      if (result.rowCount === 0) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The finally block still releases the connection.
        }
        return staleResult();
      }
    }

    const revealed = reveal ? await reveal(client as unknown as DbClient) : undefined;

    await client.query('COMMIT');

    return {
      ok: true,
      message: revealed ? 'Contact revealed.' : mutation ? 'Admin action applied.' : 'Admin action audited.',
      ...(revealed ? { revealed } : {}),
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      client.release(rollbackError as Error);
      released = true;
    }
    throw error;
  } finally {
    if (!released) {
      client.release();
    }
  }
}

async function lockAdminTarget(
  client: DbClient,
  targetId: string,
  targetKind: 'case' | 'verification',
): Promise<{ status: string; caseType?: string; step?: string } | undefined> {
  const result = await client.query<{
    status: string;
    case_type: string;
    details: Record<string, unknown> | null;
  }>(
    `SELECT status, case_type, details
       FROM admin_cases
      WHERE id = $1
        AND ($2 = 'case' OR case_type = 'verification_blocker')
      FOR UPDATE`,
    [targetId, targetKind],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (targetKind === 'case') {
    return { status: row.status, caseType: row.case_type };
  }
  const explicitStatus = typeof row.details?.verificationStatus === 'string'
    ? row.details.verificationStatus
    : undefined;
  const status = explicitStatus
    ?? (row.status === 'resolved' ? 'approved'
      : row.status === 'dismissed' ? 'rejected'
        : row.status === 'pending_worker' ? 'needs_more_info'
          : 'pending');
  const step = typeof row.details?.verificationStep === 'string'
    ? row.details.verificationStep
    : 'account';
  return { status, step };
}

function staleResult(): AdminActionDispatchResult {
  return {
    ok: false,
    status: 409,
    message: 'This item was already updated by another operator. Refresh and try again.',
  };
}
