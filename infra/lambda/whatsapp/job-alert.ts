import { getDbPool } from '../lib/db';
import { queueJobAlert } from './lib/outbox';
import { getTwilioSecret } from './lib/twilio-secret';
import { enqueueWorkerMessage } from './lib/worker-delivery-gateway';
import { hashNormalizedPhone, isV2Enabled, loadRuntimeControls } from './lib/runtime-controls';

const JOB_ALERT_EXPIRY_MS = 72 * 60 * 60 * 1000;

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
// This Lambda is the PRODUCER only: it resolves matched workers and queues
// one idempotent whatsapp_outbox row per (job, worker), then returns. It
// never calls Twilio. Sending happens on the scheduled drain
// (job-alert-drain.ts, EventBridge every 5 minutes,
// drainJobAlertOutbox()) — this removes the crash window where an inline
// send between "insert pending row" and "mark sent" could strand a row or,
// worse, re-send a message Twilio already accepted on Lambda retry.
export const handler = async (
  event: JobAlertEvent,
): Promise<{ queued: number; skipped: number }> => {
  if (!event.jobId) {
    // V1 only supports mode 1. Return early rather than error — caller can
    // extend later.
    console.warn('[job-alert] no jobId in event; V1 only supports jobId mode', event);
    return { queued: 0, skipped: 0 };
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
      return { queued: 0, skipped: 0 };
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
      return { queued: 0, skipped: 0 };
    }

    // 3. Queue the appropriate language template for each worker. No Twilio
    // call happens here — see the module doc comment above.
    const secret = await getTwilioSecret();
    const sidEs = secret.templates?.job_alert_es;
    const sidEn = secret.templates?.job_alert_en;
    if (!sidEs || !sidEn) {
      throw new Error(
        'templates.job_alert_es and job_alert_en must be set in the Twilio secret',
      );
    }

    // v2 redirect: workers allowlisted (or globally enabled) for onboarding v2
    // never get an immediate legacy whatsapp_outbox row here. Instead this
    // producer defers a `job_alert` intent for the grouped worker.ready
    // release (worker-ready-release.ts) to pick up later. The phone hash is
    // never logged. Non-v2 workers take the pre-existing legacy path,
    // unchanged.
    const controls = await loadRuntimeControls(client);

    let queued = 0;
    let skipped = 0;
    for (const worker of workers.rows) {
      const phoneHash = hashNormalizedPhone(worker.whatsapp_number);
      if (isV2Enabled(controls, phoneHash)) {
        try {
          await enqueueWorkerMessage(client, {
            workerId: worker.id,
            category: 'job_alert',
            ownerService: 'job-alert',
            sourceType: 'job',
            sourceId: job.id,
            dedupeKey: `job-alert:${job.id}:${worker.id}`,
            priority: 30,
            expiresAt: new Date(Date.now() + JOB_ALERT_EXPIRY_MS),
            payload: {
              jobId: job.id,
              title: job.title,
              companyName: job.company,
              score: 1,
            },
          });
          queued++;
        } catch (err) {
          console.error('[job-alert] v2 enqueue failed for worker', {
            workerId: worker.id,
            jobId: job.id,
            err: (err as Error).message,
          });
          skipped++;
        }
        continue;
      }

      const templateKey = worker.language === 'en' ? 'job_alert_en' : 'job_alert_es';
      const variables = {
        '1': job.title,
        '2': job.company,
        '3': job.location,
        '4': job.pay,
        '5': `job-${job.id}`, // matches parseButtonPayload expectation in flows.ts
      };
      try {
        const outboxId = await queueJobAlert(client, {
          whatsappNumber: worker.whatsapp_number,
          templateKey,
          variables,
          jobId: job.id,
          workerId: worker.id,
        });
        if (!outboxId) {
          // Already pending/sent, or failed at the attempt cap — idempotent
          // no-op, not an error.
          skipped++;
          continue;
        }
        queued++;
      } catch (err) {
        console.error('[job-alert] queue failed for worker', {
          workerId: worker.id,
          jobId: job.id,
          err: (err as Error).message,
        });
        skipped++;
      }
    }

    console.log('[job-alert] done', { jobId: job.id, queued, skipped });
    return { queued, skipped };
  } finally {
    client.release();
  }
};
