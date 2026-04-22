import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { getDbPool } from '../lib/db';
import type { TwilioSecret } from './lib/twilio';

// ── Module-level clients + caches ───────────────────────────────
const secretsManager = new SecretsManagerClient({});

let cachedTwilio: TwilioSecret | null = null;
let twilioCacheExp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getTwilioSecret(): Promise<TwilioSecret> {
  const now = Date.now();
  if (cachedTwilio && now < twilioCacheExp) return cachedTwilio;
  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) throw new Error('TWILIO_SECRET_ARN not set');
  const r = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error('TWILIO secret empty');
  cachedTwilio = JSON.parse(r.SecretString) as TwilioSecret;
  twilioCacheExp = now + CACHE_TTL_MS;
  return cachedTwilio;
}

// ── Twilio Content API template send ────────────────────────────
/**
 * Sends an approved WhatsApp template (Content API) via Twilio.
 *
 * Uses the "Messages" endpoint with ContentSid + ContentVariables — this is
 * the correct path for business-initiated messages (outside the 24h session
 * window). Free-form Body-only sends would fail outside the session.
 *
 * ContentVariables is a JSON string mapping numeric variable indices to values.
 * For jale_job_alert_*:
 *   {{1}} = job title      (body)
 *   {{2}} = company name   (body)
 *   {{3}} = location       (body)
 *   {{4}} = pay rate       (body)
 *   {{5}} = job id         (button payload, not shown in body)
 */
async function sendTemplate(
  to: string, // "whatsapp:+1..."
  contentSid: string,
  contentVariables: Record<string, string>,
  secret: TwilioSecret,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${secret.accountSid}/Messages.json`;
  const form = new URLSearchParams({
    MessagingServiceSid: secret.messagingServiceSid,
    To: to,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(contentVariables),
  });
  const auth = Buffer.from(`${secret.accountSid}:${secret.authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio template send failed ${res.status}: ${text}`);
  }
}

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
    // already been alerted for it. V1 uses the UNIQUE(job_id, user_id)
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
               WHERE ja.job_id = $1 AND ja.user_id = u.id
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
      const sid = worker.language === 'en' ? sidEn : sidEs;
      const variables = {
        '1': job.title,
        '2': job.company,
        '3': job.location,
        '4': job.pay,
        '5': `job-${job.id}`, // matches parseButtonPayload expectation in flows.ts
      };
      try {
        await sendTemplate(
          `whatsapp:${worker.whatsapp_number}`,
          sid,
          variables,
          secret,
        );
        sent++;
      } catch (err) {
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
