import type { ScheduledEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { sendPendingAdminOutbox } from './lib/outbox';

export async function handler(_event: ScheduledEvent): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    await sendPendingAdminOutbox(client);
  } finally {
    client.release();
  }
}
