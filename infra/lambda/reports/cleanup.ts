import { S3Client } from '@aws-sdk/client-s3';
import type { PoolClient } from 'pg';
import { getDbPool } from '../lib/db';
import { emitCleanupCompleted, emitCleanupFailed, type CleanupCounts } from './lib/metrics';
import { deleteKeys } from './lib/upload';

/**
 * Daily "report a problem" clean-up (login `jale_job_report_cleanup`).
 *
 * Keeps the retention promise: images go after 90 days, uploads never
 * attached after a day, a report's personal content after 12 months, its
 * team email once the sender is done with it, and rate buckets after two
 * days. The function decides all of that in SQL and returns the image keys to
 * delete; this job only deletes exactly those keys from storage.
 *
 * Each batch is its own short transaction, committed before any storage call.
 * The loop stops when a batch finds nothing, or after MAX_BATCHES. The run's
 * counts are emitted once the loop is done, with a dimensionless total that
 * the missing-run alarm counts; a failed run emits ReportCleanupFailed and no
 * total, and fails the invocation. Only counts are logged, never a key.
 */

export const MAX_BATCHES = 50;
const BATCH_SIZE = 500;

const s3 = new S3Client({});

interface CleanupRow extends CleanupCounts {
  delete_keys: string[] | null;
}

const KINDS: ReadonlyArray<keyof CleanupCounts> = [
  'contents_erased', 'images_expired', 'pending_cleared', 'notifications_deleted', 'buckets_deleted',
];

async function cleanupBatch(client: PoolClient): Promise<CleanupRow> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<CleanupRow>(
      `SELECT contents_erased, images_expired, pending_cleared, notifications_deleted, buckets_deleted, delete_keys
         FROM jale_cap.problem_report_cleanup($1::integer)`,
      [BATCH_SIZE],
    );
    await client.query('COMMIT');
    const row = rows[0];
    if (!row) throw new Error('problem_report_cleanup: no row');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(name) ? name : 'Error';
}

export const handler = async (): Promise<void> => {
  const totals: CleanupCounts = {
    contents_erased: 0, images_expired: 0, pending_cleared: 0, notifications_deleted: 0, buckets_deleted: 0,
  };
  let batches = 0;
  let objectsDeleted = 0;
  let client: PoolClient | undefined;
  try {
    const bucket = process.env.REPORT_IMAGES_BUCKET;
    if (!bucket) throw new Error('report_images_not_configured');
    const pool = await getDbPool();
    client = await pool.connect();

    let finished = false;
    while (!finished && batches < MAX_BATCHES) {
      const row = await cleanupBatch(client);
      batches += 1;
      let found = 0;
      for (const kind of KINDS) {
        const value = Number(row[kind] ?? 0);
        totals[kind] += value;
        found += value;
      }
      const keys = row.delete_keys ?? [];
      // After the commit, outside any transaction: the keys are already
      // cleared in SQL, and the lifecycle rules back up a failed delete.
      if (keys.length > 0) objectsDeleted += await deleteKeys(s3, bucket, keys);
      finished = found === 0 && keys.length === 0;
    }

    emitCleanupCompleted(totals);
    console.log(JSON.stringify({
      tag: 'report_cleanup',
      outcome: finished ? 'ok' : 'capped',
      batches,
      objects_deleted: objectsDeleted,
      ...totals,
    }));
  } catch (err) {
    emitCleanupFailed();
    console.error(JSON.stringify({
      tag: 'report_cleanup',
      outcome: 'failed',
      error: errorCode(err),
      batches,
      objects_deleted: objectsDeleted,
      ...totals,
    }));
    throw err;
  } finally {
    client?.release();
  }
};
