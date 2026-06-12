import { buildAdminAuditEvent } from '../audit-contract';
import { validateAdminAction, type AdminActionRequest } from '../action-requests';
import type { AdminCaseStatus, AdminCaseType, VerificationRecord } from '../types';
import type { AdminSession } from './session-claims';
import { getAdminCase, revealCaseContact, type RevealedContact } from './admin-cases';
import { getVerificationRecord } from './admin-verifications';
import { getAdminDbPool } from './db';
import { sendAdminWhatsAppMessage } from './twilio';

export type AdminActionDispatchResult =
  | { ok: true; message: string; revealed?: RevealedContact }
  | { ok: false; status: 400 | 403 | 404 | 409 | 501; message: string };

type MutationSpec = {
  sql: string;
  params: unknown[];
};

type DbClient = {
  query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

// Runs AFTER the pii_reveal audit row, in the same transaction. Returns the
// raw contact for an audited reveal_pii action; undefined for all other actions.
type RevealFn = (client: DbClient) => Promise<RevealedContact>;

type MutationInput = {
  note?: string;
  justification?: string;
};

export function buildCaseMutation(actionId: AdminActionRequest['actionId'], input: MutationInput): MutationSpec | undefined {
  if (actionId === 'request_more_info') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1`,
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
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker'`,
      params: ['verification-id', 'pending_worker', JSON.stringify({
        verificationStatus: 'needs_more_info',
        lastAdminNote: input.note ?? input.justification ?? '',
      })],
    };
  }

  if (actionId === 'reset_verification_step') {
    return {
      sql: `UPDATE admin_cases SET status = $2, details = details || $3::jsonb, updated_at = NOW() WHERE id = $1 AND case_type = 'verification_blocker'`,
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
    const target = await getAdminCase(request.targetId);

    if (!target) {
      return { ok: false, status: 404, message: 'Admin case not found.' };
    }

    const validation = validateAdminAction({
      actor: session.email ?? session.sub,
      role: session.role,
      request,
      targetKind: 'case',
      targetStatus: target.status as AdminCaseStatus,
      targetCaseType: target.type as AdminCaseType,
    });

    if (!validation.ok) {
      return { ok: false, status: validation.status, message: validation.message };
    }

    if (request.actionId === 'reply_whatsapp') {
      return sendCaseWhatsAppReply(session, request);
    }

    const reveal: RevealFn | undefined = request.actionId === 'reveal_pii'
      ? (client) => revealCaseContact(client, request.targetId)
      : undefined;

    return executeMutation(session, request, forTargetId(buildCaseMutation(request.actionId, request), request.targetId), reveal);
  }

  if (request.targetType === 'verification') {
    const target = await getVerificationRecord(request.targetId);

    if (!target) {
      return { ok: false, status: 404, message: 'Verification record not found.' };
    }

    const validation = validateAdminAction({
      actor: session.email ?? session.sub,
      role: session.role,
      request,
      targetKind: 'verification',
      targetStatus: target.status as VerificationRecord['status'],
      targetStep: target.step as VerificationRecord['step'],
    });

    if (!validation.ok) {
      return { ok: false, status: validation.status, message: validation.message };
    }

    // reveal_pii is a case-only action (not in the verification action set), so
    // verification mutations never carry a reveal step.
    return executeMutation(session, request, forTargetId(buildVerificationMutation(request.actionId, request), request.targetId));
  }

  return { ok: false, status: 400, message: 'Unsupported admin action target.' };
}

async function sendCaseWhatsAppReply(
  session: AdminSession,
  request: AdminActionRequest,
): Promise<AdminActionDispatchResult> {
  const message = request.note?.trim();
  if (!message || message.length > 1000) {
    return { ok: false, status: 400, message: 'Enter a WhatsApp reply of 1 to 1000 characters.' };
  }

  const pool = await getAdminDbPool();
  const recipient = await pool.query<{ whatsapp_number: string | null }>(
    `SELECT COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, '')) AS whatsapp_number
       FROM admin_cases c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = $1
        AND c.conversation_id IS NOT NULL
      LIMIT 1`,
    [request.targetId],
  );
  const phone = recipient.rows[0]?.whatsapp_number;
  if (!phone) {
    return { ok: false, status: 409, message: 'This case is not linked to a WhatsApp worker conversation.' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertAudit(client, session, request);
    await client.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
       VALUES ($1, 'admin_reply_requested', 'admin', $2, $3::jsonb)`,
      [
        request.targetId,
        session.email ?? session.sub,
        JSON.stringify({ title: 'Admin reply requested', detail: message }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  try {
    const twilioMessageSid = await sendAdminWhatsAppMessage(phone, message);
    await pool.query(
      `WITH event_insert AS (
         INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
         VALUES ($1, 'admin_reply_sent', 'admin', $2, $3::jsonb)
       )
       UPDATE admin_cases
          SET status = 'pending_worker',
              details = details || $4::jsonb,
              updated_at = NOW()
        WHERE id = $1`,
      [
        request.targetId,
        session.email ?? session.sub,
        JSON.stringify({ title: 'WhatsApp reply sent', detail: message, twilioMessageSid }),
        JSON.stringify({ lastAdminNote: message, lastOutboundTwilioSid: twilioMessageSid }),
      ],
    );
    return { ok: true, message: 'WhatsApp reply sent to the worker.' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown Twilio error';
    await pool.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
       VALUES ($1, 'admin_reply_failed', 'system', 'twilio', $2::jsonb)`,
      [request.targetId, JSON.stringify({ title: 'WhatsApp reply failed', detail })],
    );
    return {
      ok: false,
      status: 409,
      message: `${detail} Send HELP from the worker first, then retry within 24 hours.`,
    };
  }
}

async function executeMutation(
  session: AdminSession,
  request: AdminActionRequest,
  mutation: MutationSpec | undefined,
  reveal?: RevealFn,
): Promise<AdminActionDispatchResult> {
  const pool = await getAdminDbPool();
  const client = await pool.connect();

  let released = false;
  try {
    await client.query('BEGIN');
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
        return {
          ok: false,
          status: 409,
          message: 'This item was already updated by another operator. Refresh and try again.',
        };
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
