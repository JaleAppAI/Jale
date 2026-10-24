/**
 * Member-access catch-up sync (employer organizations, Phase 3).
 *
 * Runs every 15 minutes (BillingStack's MemberAccessSyncSchedule, no retries:
 * the next run is the retry) as the billing service login, jale_billing, the
 * one login that may execute jale_cap.org_member_access and
 * jale_cap.org_team_invite_mail_purge.
 *
 * The team handlers and the billing processor apply member access to Cognito
 * right after COMMIT, but a Cognito call can fail, run out of time, or reach
 * Cognito in a different order than the commits. Some changes also have no
 * caller at all: a removed member's re-invite that expires turns their access
 * off with nobody to apply it. This sync repairs all of them from the
 * database:
 *   1. a short transaction reads every foreman whose desired access changed
 *      in the last 7 days (newest first, at most 500);
 *   2. after COMMIT, with the client released, it makes the employer pool
 *      match (applyMemberAccess, idempotent);
 *   3. a second short transaction purges invite mail the sender is done with.
 *      It runs last and on its own, so a purge failure cannot hold up step 2.
 * Each transaction sets a 5 s lock timeout and a 30 s statement timeout.
 *
 * STALE READS. The read is a snapshot. A sync that read "enabled" just before
 * an owner's remove committed can enable the user after that remove's own
 * disable has run. This heals on the next run (the remove changed the row, so
 * it is read again within 7 days), and meanwhile the database's membership
 * check still answers 403 for a removed member, so the stale sign-in reaches
 * nothing.
 *
 * FAILURES. A DB failure (read or purge) is logged and rethrown, so the run
 * counts in the Lambda's Errors alarm. A Cognito failure is not an error: it
 * is counted in the member_access_sync line and retried on the next run (an
 * unusable pool alarms through member_access_pool_* instead).
 */
import type { ScheduledHandler } from 'aws-lambda';
import type { PoolClient } from 'pg';
import { getDbPool } from '../lib/db';
import { applyMemberAccess, type MemberAccessChange } from '../lib/member-access';

/** How far back a change is still re-applied. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows read per run; org_member_access returns the newest changes first. */
const READ_LIMIT = 500;
/** Invite mail rows deleted per run (the definer allows 1 to 1000). */
const PURGE_BATCH = 500;

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && e.code !== '') return e.code;
  return typeof e?.name === 'string' && e.name !== '' ? e.name : 'Error';
}

/** One short transaction, with the client released before it returns. */
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const handler: ScheduledHandler = async (_event, context) => {
  const deadlineAt = Date.now() + context.getRemainingTimeInMillis() - 5000;
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  let changes: MemberAccessChange[];
  try {
    changes = await inTransaction(async (client) => {
      const access = await client.query<{ cognito_sub: string; enabled: boolean }>(
        `SELECT cognito_sub, enabled FROM jale_cap.org_member_access(NULL, $1, ${READ_LIMIT})`,
        [since],
      );
      return access.rows.map((row) => ({ cognitoSub: row.cognito_sub, enabled: row.enabled }));
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'member_access_sync_failed', code: errorCode(err) }));
    throw err;
  }

  if (changes.length >= READ_LIMIT) {
    // More changed than one run reads: the oldest of them wait for later runs.
    console.warn(JSON.stringify({ event: 'member_access_sync_saturated', read: changes.length, limit: READ_LIMIT }));
  }

  const result = changes.length > 0
    ? await applyMemberAccess(changes, { deadlineAt })
    : { converged: 0, failed: [] as string[] };

  let purged: number | null = null;
  let purgeError: unknown;
  try {
    purged = await inTransaction(async (client) => {
      const purge = await client.query<{ purged: number }>(
        `SELECT jale_cap.org_team_invite_mail_purge(${PURGE_BATCH}) AS purged`,
      );
      return Number(purge.rows[0]?.purged ?? 0);
    });
  } catch (err) {
    purgeError = err;
    console.error(JSON.stringify({ event: 'member_access_purge_failed', code: errorCode(err) }));
  }

  console.info(JSON.stringify({
    event: 'member_access_sync',
    read: changes.length,
    converged: result.converged,
    failed: result.failed.length,
    purged,
  }));

  // Cognito has converged; the purge failure still fails the run so the
  // Errors alarm sees it (invite mail carries raw tokens until purged).
  if (purgeError !== undefined) throw purgeError;
};
