import type { PoolClient } from 'pg';
import { sendTwilioWhatsAppMessage } from '../whatsapp/lib/outbox';
import { enqueueWorkerMessage } from '../whatsapp/lib/worker-delivery-gateway';
import { hashNormalizedPhone, isV2Enabled, loadRuntimeControls } from '../whatsapp/lib/runtime-controls';

const FALLBACK_BODY_KEY = '__fallback_body';
const WORKER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 2000;
// Outbox rows stop auto-retrying at this attempt count (R8). The R7 template
// dedupe must treat rows at the cap as dead, so the two queries share it.
const MAX_SEND_ATTEMPTS = 5;
// C6 employer_chat intent expiry (plan intent-parameters table).
const EMPLOYER_CHAT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

type ConversationAccessRow = {
  id: string;
  job_id: string;
  employer_id: string;
  worker_id: string;
  application_id: string;
  status: 'open' | 'closed';
  worker_phone: string | null;
  worker_language: string | null;
  company_name: string | null;
  job_title: string | null;
  last_worker_message_at: Date | string | null;
  worker_thread_number: number | null;
};

export type ConversationSummary = {
  id: string;
  job_id: string;
  job_title: string;
  worker_id: string;
  worker_name: string | null;
  status: 'open' | 'closed';
  last_message_at: string | null;
  last_worker_message_at: string | null;
  last_message_preview: string | null;
  updated_at: string;
};

export type ConversationDetail = ConversationSummary & {
  application_id: string;
};

export type ConversationMessage = {
  id: string;
  sender_type: 'employer' | 'worker' | 'system';
  direction: 'outbound' | 'inbound';
  body: string;
  status: 'queued' | 'waiting_worker_reply' | 'sent' | 'delivered' | 'failed' | 'received';
  created_at: string;
  sent_at: string | null;
};

type WorkerConversationActionResult = {
  found: boolean;
  queuedMessages: number;
  conversationId?: string;
};

export type ThreadOption = {
  conversationId: string;
  jobTitle: string;
  companyName: string;
  threadNumber: number | null;
};

export type WorkerReplyRouteResult =
  | { status: 'routed'; conversationId: string }
  | { status: 'focus_closed' }
  | { status: 'no_conversation' }
  | { status: 'ambiguous'; threads: ThreadOption[] };

type OpenThreadRow = {
  id: string;
  application_id: string;
  job_title: string;
  company: string;
  worker_thread_number: number | null;
};

const OPEN_THREAD_SELECT = `
  SELECT jc.id, jc.application_id, jc.worker_thread_number,
         j.title AS job_title,
         employer_display_name(jc.employer_id) AS company
    FROM job_conversations jc
    JOIN jobs j ON j.id = jc.job_id`;

export function normalizeMessageBody(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const body = value.trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) return null;
  return body;
}

function normalizeWhatsappNumber(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/^whatsapp:/i, '') ?? '';
  if (!cleaned) return null;
  return cleaned;
}

function isWorkerReplyWindowOpen(value: Date | string | null): boolean {
  if (!value) return false;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(at) && Date.now() - at < WORKER_REPLY_WINDOW_MS;
}

function templateLang(value: string | null | undefined): 'en' | 'es' {
  return value === 'en' ? 'en' : 'es';
}

function inviteTemplateName(lang: string | null | undefined): string {
  return `employer_message_invite_${templateLang(lang)}`;
}

function resumeTemplateName(lang: string | null | undefined): string {
  return `employer_message_resume_${templateLang(lang)}`;
}

function buildInviteFallback(companyName: string, jobTitle: string, lang: string | null | undefined): string {
  return templateLang(lang) === 'en'
    ? `${companyName} sent you a message about ${jobTitle}. Reply here to open the conversation.`
    : `${companyName} te envio un mensaje sobre ${jobTitle}. Responde aqui para abrir la conversacion.`;
}

function sanitizeHeaderInput(value: string | null | undefined, max = 40): string {
  return (value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max) || 'Empleador';
}

function buildContextHeader(
  companyName: string | null,
  jobTitle: string | null,
  threadNumber: number | null,
): string {
  const co = sanitizeHeaderInput(companyName);
  const jt = sanitizeHeaderInput(jobTitle, 50);
  const num = threadNumber != null ? ` (#${threadNumber})` : '';
  return `🏢 ${co} — ${jt}${num}\n`;
}

async function setSessionInternalUser(client: PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT set_config('app.current_internal_user_id', $1, false)`, [userId]);
}

async function clearSessionInternalUser(client: PoolClient): Promise<void> {
  await client.query(`SELECT set_config('app.current_internal_user_id', '', false)`);
}

async function loadConversationForEmployer(
  client: PoolClient,
  conversationId: string,
  employerId: string,
): Promise<ConversationAccessRow | null> {
  const result = await client.query<ConversationAccessRow>(
    `SELECT
       jc.id,
       jc.job_id,
       jc.employer_id,
       jc.worker_id,
       jc.application_id,
       jc.status,
       COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, ''), NULLIF(wp.phone, '')) AS worker_phone,
       wc.language AS worker_language,
       COALESCE(ep.company_name, employer.full_name, j.company, 'Jale') AS company_name,
       j.title AS job_title,
       jc.last_worker_message_at,
       jc.worker_thread_number
     FROM job_conversations jc
     JOIN jobs j ON j.id = jc.job_id
     JOIN users employer ON employer.id = jc.employer_id
     JOIN users u ON u.id = jc.worker_id
     LEFT JOIN worker_profiles wp ON wp.user_id = jc.worker_id
     LEFT JOIN employer_profiles ep ON ep.user_id = jc.employer_id
     LEFT JOIN whatsapp_conversations wc ON wc.user_id = jc.worker_id
     WHERE jc.id = $1
       AND jc.employer_id = $2`,
    [conversationId, employerId],
  );
  return result.rows[0] ?? null;
}

async function queueWorkerInviteTemplate(
  client: PoolClient,
  conversation: ConversationAccessRow,
  templateName: string,
): Promise<void> {
  const whatsappNumber = normalizeWhatsappNumber(conversation.worker_phone);
  if (!whatsappNumber) throw new Error('worker_whatsapp_unavailable');

  const companyName = conversation.company_name ?? 'Jale';
  const jobTitle = conversation.job_title ?? 'this job';
  await client.query(
    `INSERT INTO job_message_outbox
        (conversation_id, whatsapp_number, send_kind, content_template, content_variables)
     VALUES ($1, $2, 'template', $3, $4::jsonb)`,
    [
      conversation.id,
      whatsappNumber,
      templateName,
      JSON.stringify({
        '1': companyName,
        '2': jobTitle,
        '5': `conversation:open:${conversation.id}`,
        '6': `conversation:decline:${conversation.id}`,
        [FALLBACK_BODY_KEY]: buildInviteFallback(companyName, jobTitle, conversation.worker_language),
      }),
    ],
  );
}

async function queueEmployerFreeformMessage(
  client: PoolClient,
  conversation: ConversationAccessRow,
  messageId: string,
  body: string,
): Promise<void> {
  const whatsappNumber = normalizeWhatsappNumber(conversation.worker_phone);
  if (!whatsappNumber) throw new Error('worker_whatsapp_unavailable');

  const header = buildContextHeader(conversation.company_name, conversation.job_title, conversation.worker_thread_number);
  await client.query(
    `INSERT INTO job_message_outbox
        (conversation_id, message_id, whatsapp_number, send_kind, body)
     VALUES ($1, $2, $3, 'freeform', $4)`,
    [conversation.id, messageId, whatsappNumber, `${header}${body}`],
  );
}

export async function listEmployerConversations(
  client: PoolClient,
  employerId: string,
): Promise<ConversationSummary[]> {
  const result = await client.query<ConversationSummary>(
    `SELECT
       jc.id,
       jc.job_id,
       j.title AS job_title,
       jc.worker_id,
       COALESCE(wp.full_name, u.full_name) AS worker_name,
       jc.status,
       jc.last_message_at,
       jc.last_worker_message_at,
       last_msg.body AS last_message_preview,
       jc.updated_at
     FROM job_conversations jc
     JOIN jobs j ON j.id = jc.job_id
     JOIN users u ON u.id = jc.worker_id
     LEFT JOIN worker_profiles wp ON wp.user_id = jc.worker_id
     LEFT JOIN LATERAL (
       SELECT body
       FROM job_conversation_messages jcm
       WHERE jcm.conversation_id = jc.id
       ORDER BY jcm.created_at DESC
       LIMIT 1
     ) last_msg ON true
     WHERE jc.employer_id = $1
     ORDER BY COALESCE(jc.last_message_at, jc.created_at) DESC
     LIMIT 100`,
    [employerId],
  );
  return result.rows;
}

export async function getEmployerConversationDetail(
  client: PoolClient,
  conversationId: string,
  employerId: string,
): Promise<{ conversation: ConversationDetail; messages: ConversationMessage[] } | null> {
  const conversation = await client.query<ConversationDetail>(
    `SELECT
       jc.id,
       jc.job_id,
       jc.application_id,
       j.title AS job_title,
       jc.worker_id,
       COALESCE(wp.full_name, u.full_name) AS worker_name,
       jc.status,
       jc.last_message_at,
       jc.last_worker_message_at,
       last_msg.body AS last_message_preview,
       jc.updated_at
     FROM job_conversations jc
     JOIN jobs j ON j.id = jc.job_id
     JOIN users u ON u.id = jc.worker_id
     LEFT JOIN worker_profiles wp ON wp.user_id = jc.worker_id
     LEFT JOIN LATERAL (
       SELECT body
       FROM job_conversation_messages jcm
       WHERE jcm.conversation_id = jc.id
       ORDER BY jcm.created_at DESC
       LIMIT 1
     ) last_msg ON true
     WHERE jc.id = $1
       AND jc.employer_id = $2`,
    [conversationId, employerId],
  );

  if (conversation.rowCount === 0) return null;

  const messages = await client.query<ConversationMessage>(
    `SELECT id, sender_type, direction, body, status, created_at, sent_at
     FROM job_conversation_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT 200`,
    [conversationId],
  );

  return { conversation: conversation.rows[0], messages: messages.rows };
}

export async function createApplicantConversation(
  client: PoolClient,
  employerId: string,
  jobId: string,
  workerId: string,
  initialMessage: string,
): Promise<{ conversationId: string }> {
  const access = await client.query<ConversationAccessRow>(
    `SELECT
       j.id AS job_id,
       j.employer_id,
       ja.worker_id,
       ja.id AS application_id,
       COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, ''), NULLIF(wp.phone, '')) AS worker_phone,
       wc.language AS worker_language,
       COALESCE(ep.company_name, employer.full_name, j.company, 'Jale') AS company_name,
       j.title AS job_title
     FROM jobs j
     JOIN job_applications ja ON ja.job_id = j.id
     JOIN users employer ON employer.id = j.employer_id
     JOIN users u ON u.id = ja.worker_id
     LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
     LEFT JOIN employer_profiles ep ON ep.user_id = j.employer_id
     LEFT JOIN whatsapp_conversations wc ON wc.user_id = ja.worker_id
     WHERE j.id = $1
       AND j.employer_id = $2
       AND ja.worker_id = $3`,
    [jobId, employerId, workerId],
  );

  const row = access.rows[0];
  if (!row) throw new Error('applicant_not_found');
  if (!normalizeWhatsappNumber(row.worker_phone)) throw new Error('worker_whatsapp_unavailable');

  let conversation = await client.query<ConversationAccessRow>(
    `SELECT
       jc.id,
       jc.job_id,
       jc.employer_id,
       jc.worker_id,
       jc.application_id,
       jc.status,
       COALESCE(NULLIF(u.whatsapp_number, ''), NULLIF(u.phone, ''), NULLIF(wp.phone, '')) AS worker_phone,
       wc.language AS worker_language,
       COALESCE(ep.company_name, employer.full_name, j.company, 'Jale') AS company_name,
       j.title AS job_title,
       jc.last_worker_message_at
     FROM job_conversations jc
     JOIN jobs j ON j.id = jc.job_id
     JOIN users employer ON employer.id = jc.employer_id
     JOIN users u ON u.id = jc.worker_id
     LEFT JOIN worker_profiles wp ON wp.user_id = jc.worker_id
     LEFT JOIN employer_profiles ep ON ep.user_id = jc.employer_id
     LEFT JOIN whatsapp_conversations wc ON wc.user_id = jc.worker_id
     WHERE jc.job_id = $1
       AND jc.employer_id = $2
       AND jc.worker_id = $3
       AND jc.status = 'open'
     LIMIT 1`,
    [jobId, employerId, workerId],
  );

  if (conversation.rowCount === 0) {
    const threadNumber = await client.query<{ n: number }>(
      `SELECT assign_worker_thread_number($1) AS n`,
      [workerId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO job_conversations
          (job_id, employer_id, worker_id, application_id, last_message_at, worker_thread_number)
       VALUES ($1, $2, $3, $4, now(), $5)
       RETURNING id`,
      [jobId, employerId, workerId, row.application_id, threadNumber.rows[0].n],
    );

    conversation = await client.query<ConversationAccessRow>(
      `SELECT
         $1::uuid AS id,
         $2::uuid AS job_id,
         $3::uuid AS employer_id,
         $4::uuid AS worker_id,
         $5::uuid AS application_id,
         'open'::text AS status,
         $6::text AS worker_phone,
         $7::text AS worker_language,
         $8::text AS company_name,
         $9::text AS job_title,
         NULL::timestamptz AS last_worker_message_at,
         $10::int AS worker_thread_number`,
      [
        created.rows[0].id,
        row.job_id,
        employerId,
        workerId,
        row.application_id,
        row.worker_phone,
        row.worker_language,
        row.company_name,
        row.job_title,
        threadNumber.rows[0].n,
      ],
    );
  }

  // The WhatsApp session is per phone number, not per conversation. If the worker
  // has replied to any other open conversation from this employer in the last 24h,
  // that session covers this new conversation too — send freeform to avoid a
  // template rejection (Twilio 21655) when a marketing session is already active.
  const crossSessionRow = await client.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM job_conversations
        WHERE employer_id = $1
          AND worker_id = $2
          AND status = 'open'
          AND id != $3
          AND last_worker_message_at > now() - interval '24 hours'
     ) AS active`,
    [employerId, workerId, conversation.rows[0].id],
  );
  const workerSessionOpen = crossSessionRow.rows[0]?.active ?? false;

  await queueConversationMessageFromEmployer(
    client,
    conversation.rows[0].id,
    employerId,
    initialMessage,
    inviteTemplateName(conversation.rows[0].worker_language),
    { forceCanSendFreeform: workerSessionOpen },
  );

  return { conversationId: conversation.rows[0].id };
}

export async function queueConversationMessageFromEmployer(
  client: PoolClient,
  conversationId: string,
  employerId: string,
  body: string,
  closedWindowTemplateName?: string,
  options?: { forceCanSendFreeform?: boolean },
): Promise<{ messageId: string; queuedAsTemplate: boolean }> {
  const conversation = await loadConversationForEmployer(client, conversationId, employerId);
  if (!conversation || conversation.status !== 'open') throw new Error('conversation_not_found');

  const canSendFreeform = (options?.forceCanSendFreeform ?? false) || isWorkerReplyWindowOpen(conversation.last_worker_message_at);
  const message = await client.query<{ id: string }>(
    `INSERT INTO job_conversation_messages
       (conversation_id, sender_type, direction, body, status)
     VALUES ($1, 'employer', 'outbound', $2, $3)
     RETURNING id`,
    [conversation.id, body, canSendFreeform ? 'queued' : 'waiting_worker_reply'],
  );
  const messageId = message.rows[0].id;

  // v2 redirect: for a v2-enabled worker, replace only the immediate
  // whatsapp-side outbox creation below with a deferred `employer_chat`
  // intent for the grouped worker.ready release (worker-ready-release.ts).
  // The message row above, and the conversation/application updates below,
  // are unchanged for both paths. The phone hash is never logged.
  const whatsappNumber = normalizeWhatsappNumber(conversation.worker_phone);
  const controls = await loadRuntimeControls(client);
  const v2Enabled = whatsappNumber !== null && isV2Enabled(controls, hashNormalizedPhone(whatsappNumber));

  if (v2Enabled) {
    await enqueueWorkerMessage(client, {
      workerId: conversation.worker_id,
      category: 'employer_chat',
      ownerService: 'job-messaging',
      sourceType: 'job_conversation_message',
      sourceId: messageId,
      dedupeKey: `employer-chat:${messageId}`,
      priority: 40,
      expiresAt: new Date(Date.now() + EMPLOYER_CHAT_EXPIRY_MS),
      payload: { conversationId: conversation.id },
    });
  } else if (canSendFreeform) {
    await queueEmployerFreeformMessage(client, conversation, messageId, body);
  } else {
    // R7 dedupe: one un-actioned invite/resume template at a time. A new
    // template is queued only when none has been sent since the worker's
    // last action (acceptance or last reply) on this conversation.
    // Permanently-failed templates (attempt cap reached, never delivered)
    // are excluded — a dead invite must not suppress new ones forever.
    const pendingInvite = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM job_message_outbox
          WHERE conversation_id = $1
            AND send_kind = 'template'
            AND NOT (status = 'failed' AND attempt_count >= ${MAX_SEND_ATTEMPTS})
            AND created_at > COALESCE(
                  (SELECT GREATEST(jc.accepted_at, jc.last_worker_message_at)
                     FROM job_conversations jc WHERE jc.id = $1),
                  '-infinity'::timestamptz)
       ) AS exists`,
      [conversation.id],
    );
    if (!pendingInvite.rows[0]?.exists) {
      await queueWorkerInviteTemplate(
        client,
        conversation,
        closedWindowTemplateName ?? resumeTemplateName(conversation.worker_language),
      );
    }
  }

  await client.query(
    `UPDATE job_conversations
        SET last_message_at = now()
      WHERE id = $1`,
    [conversation.id],
  );
  await client.query(
    `UPDATE job_applications
        SET status = 'contacted',
            updated_at = now()
      WHERE id = $1
        AND status = 'pending'`,
    [conversation.application_id],
  );

  return { messageId: message.rows[0].id, queuedAsTemplate: !canSendFreeform };
}

export async function closeEmployerConversation(
  client: PoolClient,
  conversationId: string,
  employerId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_conversations
        SET status = 'closed',
            closed_at = now()
      WHERE id = $1
        AND employer_id = $2
        AND status = 'open'`,
    [conversationId, employerId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function closeWorkerConversation(
  client: PoolClient,
  conversationId: string,
  workerId: string,
  systemMessageBody?: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_conversations
        SET status = 'closed', closed_at = now()
      WHERE id = $1 AND worker_id = $2 AND status = 'open'`,
    [conversationId, workerId],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  const body = systemMessageBody ?? 'El trabajador terminó la conversación / Worker ended the conversation';
  await client.query(
    `INSERT INTO job_conversation_messages
       (conversation_id, sender_type, direction, body, status)
     VALUES ($1, 'system', 'outbound', $2, 'sent')`,
    [conversationId, body],
  );
  return true;
}

export async function recordWorkerConversationReply(
  client: PoolClient,
  workerId: string,
  body: string,
  from: string,
  messageSid: string,
  focusedConversationId?: string | null,
): Promise<WorkerReplyRouteResult> {
  let target: OpenThreadRow | null = null;
  if (focusedConversationId) {
    const focused = await client.query<OpenThreadRow>(
      `${OPEN_THREAD_SELECT}
        WHERE jc.id = $1 AND jc.worker_id = $2 AND jc.status = 'open'
        FOR UPDATE OF jc`,
      [focusedConversationId, workerId],
    );
    target = focused.rows[0] ?? null;
    if (!target) return { status: 'focus_closed' };
  }

  if (!target) {
    const open = await client.query<OpenThreadRow>(
      `${OPEN_THREAD_SELECT}
        WHERE jc.worker_id = $1 AND jc.status = 'open'
          AND jc.accepted_at IS NOT NULL
        ORDER BY jc.worker_thread_number NULLS LAST, jc.created_at
        LIMIT 10
        FOR UPDATE OF jc`,
      [workerId],
    );
    if (open.rowCount === 0) return { status: 'no_conversation' };
    if ((open.rowCount ?? 0) > 1) {
      return {
        status: 'ambiguous',
        threads: open.rows.map((r) => ({
          conversationId: r.id,
          jobTitle: r.job_title,
          companyName: r.company,
          threadNumber: r.worker_thread_number,
        })),
      };
    }
    target = open.rows[0];
  }

  await client.query(
    `INSERT INTO job_conversation_messages
       (conversation_id, sender_type, direction, body, status, twilio_message_sid, twilio_from)
     VALUES ($1, 'worker', 'inbound', $2, 'received', $3, $4)`,
    [target.id, body, messageSid, from],
  );
  await client.query(
    `UPDATE job_conversations
        SET last_message_at = now(),
            last_worker_message_at = now(),
            accepted_at = COALESCE(accepted_at, now())
      WHERE id = $1`,
    [target.id],
  );
  await client.query(
    `UPDATE job_applications
        SET status = 'talking', updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'contacted')`,
    [target.application_id],
  );

  const pending = await client.query<{ id: string; body: string }>(
    pendingEmployerMessagesSql(), [target.id],
  );
  const whatsappNumber = normalizeWhatsappNumber(from);
  if (whatsappNumber) {
    await queueWaitingEmployerMessages(client, target.id, whatsappNumber, pending.rows, {
      company: target.company,
      jobTitle: target.job_title,
      threadNumber: target.worker_thread_number,
    });
  }
  return { status: 'routed', conversationId: target.id };
}

function pendingEmployerMessagesSql(): string {
  return `SELECT id, body
     FROM job_conversation_messages
     WHERE conversation_id = $1
       AND sender_type = 'employer'
       AND status = 'waiting_worker_reply'
     ORDER BY created_at ASC`;
}

async function queueWaitingEmployerMessages(
  client: PoolClient,
  conversationId: string,
  whatsappNumber: string,
  messages: Array<{ id: string; body: string }>,
  headerData?: { company: string | null; jobTitle: string | null; threadNumber: number | null },
): Promise<number> {
  const header = headerData
    ? buildContextHeader(headerData.company, headerData.jobTitle, headerData.threadNumber)
    : '';
  for (const message of messages) {
    await client.query(
      `INSERT INTO job_message_outbox
          (conversation_id, message_id, whatsapp_number, send_kind, body)
       VALUES ($1, $2, $3, 'freeform', $4)`,
      [conversationId, message.id, whatsappNumber, `${header}${message.body}`],
    );
    await client.query(
      `UPDATE job_conversation_messages
          SET status = 'queued'
        WHERE id = $1`,
      [message.id],
    );
  }
  return messages.length;
}

export async function openWorkerConversationFromButton(
  client: PoolClient,
  workerId: string,
  conversationId: string,
  from: string,
): Promise<WorkerConversationActionResult> {
  return openWorkerConversation(client, workerId, from, conversationId);
}

export async function openLatestWorkerConversationFromButtonText(
  client: PoolClient,
  workerId: string,
  from: string,
): Promise<WorkerConversationActionResult> {
  return openWorkerConversation(client, workerId, from);
}

async function openWorkerConversation(
  client: PoolClient,
  workerId: string,
  from: string,
  conversationId?: string,
): Promise<WorkerConversationActionResult> {
  const params = conversationId ? [conversationId, workerId] : [workerId];
  const filter = conversationId
    ? 'jc.id = $1 AND jc.worker_id = $2'
    : 'jc.worker_id = $1';
  const conversation = await client.query<{
    id: string;
    application_id: string;
    worker_thread_number: number | null;
    job_title: string | null;
    company: string | null;
  }>(
    `SELECT jc.id, jc.application_id, jc.worker_thread_number,
            j.title AS job_title,
            employer_display_name(jc.employer_id) AS company
     FROM job_conversations jc
     JOIN jobs j ON j.id = jc.job_id
     WHERE ${filter}
       AND jc.status = 'open'
     ORDER BY COALESCE(jc.last_message_at, jc.created_at) DESC
     LIMIT 1
     FOR UPDATE OF jc`,
    params,
  );

  const row = conversation.rows[0];
  if (!row) return { found: false, queuedMessages: 0 };

  await client.query(
    `UPDATE job_conversations
        SET last_worker_message_at = now(),
            accepted_at = COALESCE(accepted_at, now())
      WHERE id = $1`,
    [row.id],
  );
  await client.query(
    `UPDATE job_applications
        SET status = 'talking',
            updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'contacted')`,
    [row.application_id],
  );

  const whatsappNumber = normalizeWhatsappNumber(from);
  if (!whatsappNumber) return { found: true, queuedMessages: 0, conversationId: row.id };

  const pending = await client.query<{ id: string; body: string }>(
    pendingEmployerMessagesSql(),
    [row.id],
  );
  const queuedMessages = await queueWaitingEmployerMessages(client, row.id, whatsappNumber, pending.rows, {
    company: row.company,
    jobTitle: row.job_title,
    threadNumber: row.worker_thread_number,
  });

  return { found: true, queuedMessages, conversationId: row.id };
}

export async function declineWorkerConversationFromButton(
  client: PoolClient,
  workerId: string,
  conversationId: string,
): Promise<boolean> {
  return declineWorkerConversation(client, workerId, conversationId);
}

export async function declineLatestWorkerConversationFromButtonText(
  client: PoolClient,
  workerId: string,
): Promise<boolean> {
  return declineWorkerConversation(client, workerId);
}

async function declineWorkerConversation(
  client: PoolClient,
  workerId: string,
  conversationId?: string,
): Promise<boolean> {
  const params = conversationId ? [conversationId, workerId] : [workerId];
  const filter = conversationId
    ? 'id = $1 AND worker_id = $2'
    : 'worker_id = $1';
  const result = await client.query(
    `UPDATE job_conversations jc
        SET status = 'closed',
            closed_at = now()
      WHERE jc.id = (
        SELECT id
        FROM job_conversations
        WHERE ${filter}
          AND status = 'open'
        ORDER BY COALESCE(last_message_at, created_at) DESC
        LIMIT 1
      )`,
    params,
  );
  return (result.rowCount ?? 0) > 0;
}

export async function sendPendingJobMessageOutbox(
  client: PoolClient,
  options: { conversationId?: string; actorUserId: string },
): Promise<void> {
  await setSessionInternalUser(client, options.actorUserId);
  try {
    const params: string[] = [];
    let conversationFilter = '';
    if (options.conversationId) {
      params.push(options.conversationId);
      conversationFilter = `AND conversation_id = $${params.length}`;
    }

    const pending = await client.query<{
      id: string;
      conversation_id: string;
      message_id: string | null;
      whatsapp_number: string;
      body: string | null;
      content_template: string | null;
      content_variables: Record<string, string> | null;
    }>(
      `SELECT id, conversation_id, message_id, whatsapp_number, body, content_template, content_variables
       FROM job_message_outbox
       WHERE status IN ('pending', 'failed')
         AND attempt_count < ${MAX_SEND_ATTEMPTS}
         ${conversationFilter}
       ORDER BY conversation_id, created_at ASC
       LIMIT 10`,
      params,
    );

    const failedConversations = new Set<string>();
    let lastError: Error | null = null;

    for (const row of pending.rows) {
      if (failedConversations.has(row.conversation_id)) continue; // preserve in-conversation order
      try {
        const twilioMessageSid = await sendTwilioWhatsAppMessage(
          `whatsapp:${row.whatsapp_number}`,
          row,
        );
        await client.query(
          `UPDATE job_message_outbox
              SET status = 'sent',
                  sent_at = now(),
                  twilio_message_sid = COALESCE($2, twilio_message_sid)
            WHERE id = $1`,
          [row.id, twilioMessageSid],
        );
        if (row.message_id) {
          await client.query(
            `UPDATE job_conversation_messages
                SET status = 'sent',
                    sent_at = now(),
                    twilio_message_sid = COALESCE($2, twilio_message_sid)
              WHERE id = $1`,
            [row.message_id, twilioMessageSid],
          );
        }
      } catch (err) {
        failedConversations.add(row.conversation_id);
        lastError = err as Error;
        console.log(JSON.stringify({ metric: 'JobMessageOutboxSendFailed', outboxId: row.id }));
        await client.query(
          `UPDATE job_message_outbox
              SET status = 'failed',
                  attempt_count = attempt_count + 1,
                  last_error = $1
            WHERE id = $2`,
          [(err as Error).message, row.id],
        );
        if (row.message_id) {
          await client.query(
            `UPDATE job_conversation_messages
                SET status = 'failed'
              WHERE id = $1`,
            [row.message_id],
          );
        }
        // Do not rethrow here; skip remaining rows for this conversation and continue others.
      }
    }

    // Surface failure only when nothing succeeded and something failed (total outage).
    if (
      lastError &&
      pending.rows.length > 0 &&
      pending.rows.every((r) => failedConversations.has(r.conversation_id))
    ) {
      throw lastError;
    }
  } finally {
    await clearSessionInternalUser(client);
  }
}
