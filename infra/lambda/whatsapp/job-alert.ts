import { getDbPool } from '../lib/db';
import { sendTwilioWhatsAppMessage } from './lib/outbox';
import { getTwilioSecret } from './lib/twilio-secret';

// ── Handler event shape ─────────────────────────────────────────
/**
 * The sender can be invoked in two modes:
 *
 *   1. "all-matched-for-job" — send a specific job to all matched workers
 *      (e.g. triggered when an employer posts a new job).
 *        { jobId: "<uuid>" }
 *
 *   2. "specific" — send a list of jobs to a single worker (e.g. "Trabajos"
 *      keyword reply, or direct re-engagement).
 *        { userId: "<uuid>", jobIds: ["<uuid>", ...] }
 *
 * V1 implements mode 1 only; mode 2 is reserved for Phase 7+.
 */
interface JobAlertEvent {
  jobId?: string;
  userId?: string;
  jobIds?: string[];
}

interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  pay: string;
}

interface WorkerRow {
  id: string;
  whatsapp_number: string;
  language: 'en' | 'es';
  main_trade: string | null;
}

// ── Handler ─────────────────────────────────────────────────────
export const handler = async (
  event: JobAlertEvent,
): Promise<{ sent: number; skipped: number }> => {
  if (!event.jobId) {
    // V1 only supports mode 1. Return early rather than error — caller can
    // extend later.
    console.warn('[job-alert] no jobId in event; V1 only supports jobId mode', event);
    return { sent: 0, skipped: 0 };
  }

  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    // 1. Look up the job
    const jobResult = await client.query<JobRow>(
      `SELECT id, title, company, location, pay FROM jobs WHERE id = $1`,
      [event.jobId],
    );
    if (jobResult.rowCount === 0) {
      console.warn('[job-alert] job not found', { jobId: event.jobId });
      return { sent: 0, skipped: 0 };
    }
    const job = jobResult.rows[0];

    // 2. Find matched workers.
    // V1 matching: any worker in `idle` state with a linked WhatsApp number.
    // Future V1.5: filter by main_trade = job.trade, city proximity, etc.
    // The processor keeps workers' conversations in `idle` only after the
    // full profile is built, so this set = "ready-to-receive" workers.
    //
    // Skip workers who already applied to this job (dedup) or who have
    // already been alerted for it. V1 uses the UNIQUE(job_id, worker_id)
    // constraint on job_applications as the dedup signal for accepts;
    // for the alert send itself, we just skip workers with an existing
    // application row.
    const workers = await client.query<WorkerRow>(
      `SELECT u.id, u.whatsapp_number, wc.language, u.main_trade
         FROM users u
         JOIN whatsapp_conversations wc ON wc.user_id = u.id
        WHERE u.user_type = 'worker'
          AND u.whatsapp_number IS NOT NULL
          AND wc.conversation_state = 'idle'
          AND NOT EXISTS (
              SELECT 1 FROM job_applications ja
               WHERE ja.job_id = $1 AND ja.worker_id = u.id
          )`,
      [job.id],
    );

    if (workers.rowCount === 0) {
      console.log('[job-alert] no matched workers', { jobId: job.id });
      return { sent: 0, skipped: 0 };
    }

    // 3. Send the appropriate language template to each worker.
    const secret = await getTwilioSecret();
    const sidEs = secret.templates?.job_alert_es;
    const sidEn = secret.templates?.job_alert_en;
    if (!sidEs || !sidEn) {
      throw new Error(
        'templates.job_alert_es and job_alert_en must be set in the Twilio secret',
      );
    }

    let sent = 0;
    let skipped = 0;
    for (const worker of workers.rows) {
      const templateKey = worker.language === 'en' ? 'job_alert_en' : 'job_alert_es';
      const variables = {
        '1': job.title,
        '2': job.company,
        '3': job.location,
        '4': job.pay,
        '5': `job-${job.id}`, // matches parseButtonPayload expectation in flows.ts
      };
      let outboxId: string | undefined;
      try {
        // Claim a durable outbox row before the network call. The unique
        // idempotency key prevents duplicate alerts across retries/invocations.
        const claimed = await client.query<{ id: string }>(
          `INSERT INTO whatsapp_outbox
             (inbound_message_sid, sequence, whatsapp_number, body,
              content_template, content_variables, source_type, source_id,
              idempotency_key)
           VALUES (NULL, 1, $1, NULL, $2, $3::jsonb, 'job_alert', $4, $5)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET status = 'pending'
             WHERE whatsapp_outbox.status = 'failed'
               AND whatsapp_outbox.attempt_count < 5
           RETURNING id`,
          [worker.whatsapp_number, templateKey, JSON.stringify(variables), job.id,
            `job-alert:${job.id}:${worker.id}`],
        );
        outboxId = claimed.rows[0]?.id;
        if (!outboxId) {
          skipped++;
          continue;
        }
        const twilioMessageSid = await sendTwilioWhatsAppMessage(
          `whatsapp:${worker.whatsapp_number}`,
          { body: null, content_template: templateKey, content_variables: variables },
        );
        await client.query(
          `UPDATE whatsapp_outbox
              SET status = 'sent', sent_at = now(),
                  twilio_message_sid = COALESCE($2, twilio_message_sid)
            WHERE id = $1`,
          [outboxId, twilioMessageSid],
        );
        sent++;
      } catch (err) {
        if (outboxId) {
          await client.query(
            `UPDATE whatsapp_outbox
                SET status = 'failed', attempt_count = attempt_count + 1,
                    last_error = $2
              WHERE id = $1`,
            [outboxId, err instanceof Error ? err.message : String(err)],
          ).catch(() => undefined);
        }
        // Log per-worker failures but keep sending to others. Real failures
        // land in CloudWatch; operational alarms are out of V1 scope.
        console.error('[job-alert] send failed for worker', {
          workerId: worker.id,
          jobId: job.id,
          err: (err as Error).message,
        });
        skipped++;
      }
    }

    console.log('[job-alert] done', { jobId: job.id, sent, skipped });
    return { sent, skipped };
  } finally {
    client.release();
  }
};
