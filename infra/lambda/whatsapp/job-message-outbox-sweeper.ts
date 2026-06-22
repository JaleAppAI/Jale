// infra/lambda/whatsapp/job-message-outbox-sweeper.ts
//
// EventBridge-scheduled reconciliation for job_message_outbox (V2 plan §4.4):
// employer-initiated sends flush post-commit from the API Lambda with no
// retry driver behind them. This sweeper retries pending/failed-under-cap
// rows older than 5 minutes. Discovery is SECURITY DEFINER (worker-scoped
// RLS hides other workers' rows); the flush itself uses the normal
// per-worker RLS path via sendPendingJobMessageOutbox.
import { getDbPool } from '../lib/db';
import { sendPendingJobMessageOutbox } from '../lib/job-messaging';

export async function handler(): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    const stale = await client.query<{ worker_id: string }>(
      `SELECT worker_id FROM list_stale_job_outbox_workers(INTERVAL '5 minutes')`,
    );
    for (const row of stale.rows) {
      try {
        await sendPendingJobMessageOutbox(client, { actorUserId: row.worker_id });
      } catch (err) {
        console.log(JSON.stringify({
          metric: 'JobOutboxSweepWorkerFailed',
          workerId: row.worker_id,
          error: (err as Error).message,
        }));
      }
    }
    console.log(JSON.stringify({
      metric: 'JobOutboxSweepWorkers', count: stale.rowCount ?? 0 }));
  } finally {
    client.release();
  }
}
