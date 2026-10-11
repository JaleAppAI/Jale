import type { PoolClient } from 'pg';
import { getAdminDbPool } from '../db';
import type { AdminSession } from '../session-claims';
import { adminActorFor } from './actor';

/**
 * Runs a page's reads in one transaction: BEGIN -> fn(client) -> COMMIT.
 *
 * `fn` loads the data and records the access event on the same client
 * (`recordAdminAccess(session, e, client)`) before it returns, so the read
 * and its record commit together, and the caller renders only after COMMIT.
 * Any error, including a failed event write, rolls the
 * transaction back and is rethrown: nothing is returned for rendering.
 *
 * The transaction is not READ ONLY: jale_audit.record_event inserts the
 * event row. A real session without its server-side ids is refused before a
 * connection is taken.
 */
export async function withAdminReadTransaction<T>(
  session: AdminSession,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!session?.preview) {
    adminActorFor(session);
  }

  const pool = await getAdminDbPool();
  const client = await pool.connect();
  let broken: Error | undefined;

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // A connection that cannot roll back is not returned to the pool.
      broken = rollbackError instanceof Error ? rollbackError : new Error('rollback failed');
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
