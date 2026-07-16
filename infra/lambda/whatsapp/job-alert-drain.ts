// infra/lambda/whatsapp/job-alert-drain.ts
//
// EventBridge-scheduled (every 5 minutes) crash-safe drain of job_alert
// whatsapp_outbox rows queued by job-alert.ts. See drainJobAlertOutbox() in
// lib/outbox.ts for the crash-safety, retry/backoff, and idempotency
// design. This Lambda owns no business logic beyond invoking the drain and
// emitting a structured metric log for observability.
import type { ScheduledEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { drainJobAlertOutbox } from './lib/outbox';

export async function handler(_event: ScheduledEvent): Promise<void> {
  const pool = await getDbPool();
  const result = await drainJobAlertOutbox(pool);
  console.log(JSON.stringify({ metric: 'JobAlertOutboxDrain', ...result }));
}
