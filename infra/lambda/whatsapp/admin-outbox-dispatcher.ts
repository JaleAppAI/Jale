import type { ScheduledEvent } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { sendPendingAdminOutbox } from './lib/outbox';

export async function handler(_event: ScheduledEvent): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await sendPendingAdminOutbox(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
