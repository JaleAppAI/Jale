// infra/lambda/referrals/retention-sweeper.ts
//
// EventBridge-scheduled retention for the referral tables (migrations 056/057).
// POST /public/jobs/{code}/apply-intent writes a referral_apply_tokens row per
// unauthenticated request and GET /public/jobs/{code} writes a job_share_opens
// row per page view; nothing else ever deletes either, so without this sweeper
// both tables grow without bound on unauthenticated write paths. The partial
// indexes in 056 (WHERE consumed_at IS NULL / WHERE claimed_at IS NULL) were
// shaped for exactly this sweep.
//
// Runs on its own job login, which holds no table rights: one capability
// call, `jale_cap.retention_purge(batch)`, deletes up to `batch` expired rows
// from each of the three tables and returns the counts. The age rules live in
// that function: apply tokens a week past their expiry (they are single-use
// and expire in 24h, so a week's grace is ample for debugging a failed
// hand-off); parked claims 30 days past their claim or, unclaimed, past their
// expiry (a parked claim lives 30 days by design, and a further 30 keeps a
// support question answerable); share opens after 400 days (they are the
// substrate every referral report is computed from, so over a year keeps
// year-on-year comparisons possible). jale_public_jobs deliberately has no
// DELETE right anywhere, and must never get one.
//
// Logs counts only — never a token, phone hash or IP.
//
// Before purging, each run takes the referral funnel's daily snapshot
// (migration 124, admin analytics item 21): `jale_cap.referral_funnel_snapshot()`
// turns the tagged apply taps and claims of the last few days into per-day
// counts, so the funnel keeps its history after the purge removes the rows.
// It runs first so it still sees what this run removes, and it is
// best-effort: a failed snapshot logs one static line and the purge runs.
//
// job_visibility_events (migration 062) was evaluated for pruning here and
// deliberately excluded -- do not add it without a new migration, which would
// need a delete right, a delete rule and an index to serve the predicate
// (`job_visibility_events_drain_idx` is partial on `status IN ('pending',
// 'failed')`, which does not cover a sent/failed sweep). Migrations are
// operator-run and forward-only.
import type { PoolClient } from 'pg';
import { getDbPool } from '../lib/db';

// Batched so one call can never hold a long lock on a table the public page
// is actively inserting into. Each call is its own short transaction.
const BATCH_SIZE = 5000;

export interface SweepResult {
  tokensDeleted: number;
  claimsDeleted: number;
  opensDeleted: number;
}

interface SnapshotRow {
  days_covered: number | string;
  rows_written: number | string;
}

async function snapshotReferralFunnel(client: PoolClient): Promise<void> {
  try {
    const snap = await client.query<SnapshotRow>(
      'SELECT days_covered, rows_written FROM jale_cap.referral_funnel_snapshot()',
    );
    const row = snap.rows[0];
    console.log(JSON.stringify({
      metric: 'ReferralFunnelSnapshot',
      daysCovered: Number(row?.days_covered ?? 0),
      rowsWritten: Number(row?.rows_written ?? 0),
    }));
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
    console.warn(JSON.stringify({ metric: 'ReferralFunnelSnapshotSkipped', code }));
  }
}

interface PurgeRow {
  tokens_deleted: number | string;
  claims_deleted: number | string;
  opens_deleted: number | string;
}

export async function handler(): Promise<SweepResult> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    await snapshotReferralFunnel(client);
    const result: SweepResult = { tokensDeleted: 0, claimsDeleted: 0, opensDeleted: 0 };
    // Until a call comes back short on every table: a full batch from any one
    // of them means it may still hold expired rows.
    for (;;) {
      const purged = await client.query<PurgeRow>(
        `SELECT tokens_deleted, claims_deleted, opens_deleted FROM jale_cap.retention_purge($1)`,
        [BATCH_SIZE],
      );
      const row = purged.rows[0];
      if (!row) throw new Error('retention_purge_missing');
      const tokens = Number(row.tokens_deleted);
      const claims = Number(row.claims_deleted);
      const opens = Number(row.opens_deleted);
      result.tokensDeleted += tokens;
      result.claimsDeleted += claims;
      result.opensDeleted += opens;
      if (tokens < BATCH_SIZE && claims < BATCH_SIZE && opens < BATCH_SIZE) break;
    }

    console.log(JSON.stringify({ metric: 'ReferralRetentionSweep', ...result }));
    return result;
  } finally {
    client.release();
  }
}
