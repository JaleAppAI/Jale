import type { PoolClient } from 'pg';

/**
 * Web referral-apply attribution: writes `worker_attribution` for a worker
 * who just signed up after landing on a public job page via a share link
 * (`?r=<shareCode>`), claimed directly at signup rather than parked/claimed
 * through the WhatsApp carry-through (see `../whatsapp/lib/referral-claims.ts`
 * for that lane's equivalent, `claimPendingReferral`).
 *
 * Caller owns the transaction (same contract as `claimPendingReferral`): no
 * BEGIN/COMMIT/ROLLBACK here.
 *
 * SECURITY NOTE — read this before assuming this function "just works" under
 * RLS: `job_share_links` has exactly one `jale_admin` policy in migration 056,
 * `job_share_links_owner`, scoped to `referrer_worker_id = current caller`.
 * The caller of this function's SELECT is the WORKER BEING REFERRED (the
 * claimer), not the referrer who minted the link — those are, by definition
 * of a referral, two different people. Under FORCE ROW LEVEL SECURITY that
 * means the SELECT below returns zero rows for every real (non-self) referral
 * once `setRlsContext` has set `app.current_user_id` to the claimer's sub, and
 * this function will always return `{ written: false }` in production. This
 * is a pre-existing RLS gap in the schema this task was scoped to build
 * against (migration 056/057), not something introduced here — fixing it
 * requires a migration (e.g. a second SELECT policy scoped to
 * `revoked_at IS NULL`, mirroring `job_share_links_public_read`), which is out
 * of scope for this task (`infra/db/migrations/` is off-limits). Flagged here
 * and in the task's final report rather than worked around with a role switch
 * or a SECURITY DEFINER function, either of which would change the security
 * model outside this task's authorization.
 */
export async function writeWebAttribution(
  client: PoolClient,
  workerId: string,
  shareCode: string,
  now: Date,
): Promise<{ written: boolean }> {
  const nowIso = now.toISOString();

  const linkResult = await client.query<{
    job_id: string;
    channel: string;
    referrer_worker_id: string | null;
  }>(
    `SELECT job_id, channel, referrer_worker_id
       FROM job_share_links
      WHERE code = $1
        AND revoked_at IS NULL`,
    [shareCode],
  );

  const link = linkResult.rows[0];
  if (!link) {
    return { written: false };
  }

  // The channel that EARNED the referral is the share link's own channel —
  // never hardcoded here, never a channel supplied by the client. See
  // claimPendingReferral's identical rationale in
  // ../whatsapp/lib/referral-claims.ts.
  const { job_id: jobId, channel, referrer_worker_id: referrerWorkerId } = link;

  // `first_*` is inserted once and NEVER updated -- the `DO UPDATE SET` list
  // below deliberately omits every `first_*` column, because
  // `worker_attribution_first_touch_immutable` (migration 056) raises on any
  // UPDATE that changes one. `latest_*` is always refreshed. The share link's
  // `referrer_worker_id` is copied into BOTH `first_referrer_worker_id` and
  // `latest_referrer_worker_id` at write time: `job_share_links.referrer_worker_id`
  // is `ON DELETE SET NULL`, so this denormalization is what preserves credit
  // after a referring worker's account is later deleted.
  const upsertResult = await client.query(
    `INSERT INTO worker_attribution
        (worker_id,
         first_share_code, first_channel, first_job_id, first_referrer_worker_id, first_seen_at,
         latest_share_code, latest_channel, latest_job_id, latest_referrer_worker_id, latest_seen_at,
         created_at, updated_at)
     VALUES ($1,
             $2, $3, $4, $5, $6,
             $2, $3, $4, $5, $6,
             $6, $6)
     ON CONFLICT (worker_id) DO UPDATE
        SET latest_share_code         = EXCLUDED.latest_share_code,
            latest_channel             = EXCLUDED.latest_channel,
            latest_job_id              = EXCLUDED.latest_job_id,
            latest_referrer_worker_id  = EXCLUDED.latest_referrer_worker_id,
            latest_seen_at             = EXCLUDED.latest_seen_at,
            updated_at                 = EXCLUDED.updated_at`,
    [workerId, shareCode, channel, jobId, referrerWorkerId, nowIso],
  );

  // A zero-row result under FORCE RLS is a silently filtered write, not a
  // no-op -- that must be loud, never swallowed as a quiet `{ written: false }`.
  if (upsertResult.rowCount !== 1) {
    console.error(JSON.stringify({ metric: 'WebAttributionNotPersisted', workerId }));
    return { written: false };
  }

  return { written: true };
}
