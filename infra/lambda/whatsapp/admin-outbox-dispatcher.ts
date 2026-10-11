import type { Context, ScheduledEvent } from 'aws-lambda';
import { auditCallerFor } from '../lib/audit/caller';
import { getDbPool } from '../lib/db';
import { sendPendingAdminOutbox } from './lib/outbox';

export async function handler(_event: ScheduledEvent, context?: Pick<Context, 'awsRequestId'>): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    // A scheduled drain on the shared WhatsApp login: the platform is the
    // actor, named by this invocation.
    await sendPendingAdminOutbox(client, auditCallerFor(context?.awsRequestId ?? '', { kind: 'platform' }, 'whatsapp'));
  } finally {
    client.release();
  }
}
