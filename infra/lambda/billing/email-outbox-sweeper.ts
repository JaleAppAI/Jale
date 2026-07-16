import { getDbPool } from '../lib/db';
import { sendPendingEmails } from '../lib/email-outbox';

export async function handler(): Promise<void> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await sendPendingEmails(client);
  } catch (error) {
    console.error('billing-email-outbox-sweeper failed', {
      code: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  } finally {
    client.release();
  }
}
