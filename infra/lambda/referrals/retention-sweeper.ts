// infra/lambda/referrals/retention-sweeper.ts
//
// EventBridge-scheduled retention for the referral tables (migration 055/056).
// POST /public/jobs/{code}/apply-intent writes a referral_apply_tokens row per
// unauthenticated request and GET /public/jobs/{code} writes a job_share_opens
// row per page view; nothing else ever deletes either, so without this sweeper
// both tables grow without bound on unauthenticated write paths. The partial
// indexes in 055 (WHERE consumed_at IS NULL / WHERE claimed_at IS NULL) were
// shaped for exactly this sweep.
//
// Runs as jale_admin (the app DB secret): jale_public_jobs deliberately has no
// DELETE grant anywhere, and must never get one.
//
// Logs counts only — never a token, phone hash or IP.
import { getDbPool } from '../lib/db';

// Apply tokens are single-use and expire in 24h; a week's grace is ample for
// debugging a failed hand-off.
const TOKEN_GRACE_DAYS = 7;
// A parked claim lives 30 days by design (migration 055); keep claimed/expired
// rows a further 30 so a support question can still be answered.
const CLAIM_GRACE_DAYS = 30;
// Opens are the substrate every referral report is computed from, so this is
// deliberately long — over a year, to keep year-on-year comparisons possible.
const OPEN_RETENTION_DAYS = 400;

// Deletes are batched so one run can never hold a long lock on a table the
// public page is actively inserting into.
const BATCH_SIZE = 5000;

export interface SweepResult {
  tokensDeleted: number;
  claimsDeleted: number;
  opensDeleted: number;
}

/**
 * Deletes in batches until a batch removes nothing. `ctid IN (SELECT ctid ...
 * LIMIT n)` keeps each statement short-lived; a plain unbatched DELETE over a
 * year of accumulated rows could lock the table for the whole scan.
 */
async function batchedDelete(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  table: string,
  where: string,
): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await client.query(
      `DELETE FROM ${table}
        WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${BATCH_SIZE})`,
    );
    const deleted = res.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH_SIZE) return total;
  }
}

export async function handler(): Promise<SweepResult> {
  const pool = await getDbPool();
  const client = await pool.connect();
  try {
    const tokensDeleted = await batchedDelete(
      client,
      'referral_apply_tokens',
      `expires_at < now() - interval '${TOKEN_GRACE_DAYS} days'`,
    );
    const claimsDeleted = await batchedDelete(
      client,
      'referral_pending_claims',
      `(claimed_at IS NOT NULL AND claimed_at < now() - interval '${CLAIM_GRACE_DAYS} days')
        OR (claimed_at IS NULL AND expires_at < now() - interval '${CLAIM_GRACE_DAYS} days')`,
    );
    const opensDeleted = await batchedDelete(
      client,
      'job_share_opens',
      `opened_at < now() - interval '${OPEN_RETENTION_DAYS} days'`,
    );

    const result: SweepResult = { tokensDeleted, claimsDeleted, opensDeleted };
    console.log(JSON.stringify({ metric: 'ReferralRetentionSweep', ...result }));
    return result;
  } finally {
    client.release();
  }
}
