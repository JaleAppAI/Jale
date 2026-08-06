import type { PoolClient } from 'pg';

/**
 * Worker attribution writes, shared by BOTH referral lanes:
 *
 *   - the web apply flow (`writeWebAttribution`, called by
 *     `api/worker-referral-claim.ts` as the authenticated claimer), and
 *   - the WhatsApp carry-through (`claimPendingReferral` in
 *     `../whatsapp/lib/referral-claims.ts`, which delegates its upsert here).
 *
 * One implementation on purpose: review found the upsert existed in three
 * textually identical copies that had already diverged (the WhatsApp lane
 * reported success on a silently RLS-filtered write). The statement below is
 * the only copy; both lanes and the integration tests exercise this exact
 * function.
 *
 * Caller owns the transaction: no BEGIN/COMMIT/ROLLBACK here.
 */

export interface AttributionSource {
  jobId: string;
  /** The channel that EARNED the referral — always the share link's own
   * channel, never hardcoded and never supplied by a client. */
  channel: string;
  shareCode: string | null;
  /** At most one of referrerWorkerId / referrerEmployerId is non-null, mirroring
   * the job_share_links CHECK constraint (migration 063) — a link is referred
   * by a worker or an employer, never both. Every caller must pass both keys
   * explicitly (as null where not applicable) so neither referrer kind can be
   * silently dropped from one lane while the other keeps it. */
  referrerWorkerId: string | null;
  referrerEmployerId: string | null;
}

/**
 * Upserts `worker_attribution` for a worker.
 *
 * `first_*` is inserted once and NEVER updated — the `DO UPDATE SET` list
 * deliberately omits every `first_*` column, because
 * `worker_attribution_first_touch_immutable` (migration 056) raises on any
 * UPDATE that changes one. `latest_*` is always refreshed. The referrer is
 * denormalized into BOTH `first_referrer_worker_id`/`first_referrer_employer_id`
 * and `latest_referrer_worker_id`/`latest_referrer_employer_id`: both
 * `job_share_links.referrer_worker_id` and `.referrer_employer_id` are
 * `ON DELETE SET NULL`, so this copy is what preserves credit after a
 * referring account is later deleted. Exactly one of the worker/employer pair
 * is non-null per touch (or both null for an organic, unreferred arrival) —
 * this function never fabricates the other kind, it only persists whatever
 * `source` already carries.
 *
 * A zero-row result under FORCE RLS is a silently filtered write, not a
 * no-op — logged loudly (static metric, never a code or phone value) and
 * reported as `{ written: false }`, never swallowed as success.
 */
export async function writeAttribution(
  client: PoolClient,
  workerId: string,
  source: AttributionSource,
  now: Date,
  metric: string,
): Promise<{ written: boolean }> {
  const nowIso = now.toISOString();
  const upsertResult = await client.query(
    `INSERT INTO worker_attribution
        (worker_id,
         first_share_code, first_channel, first_job_id, first_referrer_worker_id, first_referrer_employer_id, first_seen_at,
         latest_share_code, latest_channel, latest_job_id, latest_referrer_worker_id, latest_referrer_employer_id, latest_seen_at,
         created_at, updated_at)
     VALUES ($1,
             $2, $3, $4, $5, $6, $7,
             $2, $3, $4, $5, $6, $7,
             $7, $7)
     ON CONFLICT (worker_id) DO UPDATE
        SET latest_share_code           = EXCLUDED.latest_share_code,
            latest_channel               = EXCLUDED.latest_channel,
            latest_job_id                = EXCLUDED.latest_job_id,
            latest_referrer_worker_id    = EXCLUDED.latest_referrer_worker_id,
            latest_referrer_employer_id  = EXCLUDED.latest_referrer_employer_id,
            latest_seen_at               = EXCLUDED.latest_seen_at,
            updated_at                   = EXCLUDED.updated_at`,
    [workerId, source.shareCode, source.channel, source.jobId, source.referrerWorkerId, source.referrerEmployerId, nowIso],
  );

  if (upsertResult.rowCount !== 1) {
    console.error(JSON.stringify({ metric, workerId }));
    return { written: false };
  }
  return { written: true };
}

/**
 * Web referral-apply attribution: resolves a share code and credits the
 * referral for the authenticated claimer.
 *
 * The share-link read relies on `job_share_links_claim_read` (migration 059):
 * a share code is a capability token, so possession of the code IS the
 * authorization to resolve it — the same contract the anonymous public role
 * already has. Before 059, the only `jale_admin` policy was owner-scoped and
 * this read returned zero rows for every genuine (non-self) referral.
 */
export async function writeWebAttribution(
  client: PoolClient,
  workerId: string,
  shareCode: string,
  now: Date,
): Promise<{ written: boolean }> {
  const linkResult = await client.query<{
    job_id: string;
    channel: string;
    referrer_worker_id: string | null;
    referrer_employer_id: string | null;
  }>(
    `SELECT job_id, channel, referrer_worker_id, referrer_employer_id
       FROM job_share_links
      WHERE code = $1
        AND revoked_at IS NULL`,
    [shareCode],
  );

  const link = linkResult.rows[0];
  if (!link) {
    return { written: false };
  }

  // Self-referral guard: a worker claiming their OWN share link earns no
  // credit. Without this, the first_* immutability trigger would make the
  // self-credit permanent and any future referral reward keyed on
  // first_referrer_worker_id would pay a worker for referring themselves.
  if (link.referrer_worker_id !== null && link.referrer_worker_id === workerId) {
    return { written: false };
  }

  // Defensive parity with the worker check above. An employer-referred link's
  // referrer_employer_id is a users.id from the employer side of the table,
  // so it cannot legitimately equal the claiming worker's own id -- but the
  // guard costs nothing and closes the same self-credit hazard should that
  // invariant ever be violated upstream.
  if (link.referrer_employer_id !== null && link.referrer_employer_id === workerId) {
    return { written: false };
  }

  return writeAttribution(
    client,
    workerId,
    {
      jobId: link.job_id,
      channel: link.channel,
      shareCode,
      referrerWorkerId: link.referrer_worker_id,
      referrerEmployerId: link.referrer_employer_id,
    },
    now,
    'WebAttributionNotPersisted',
  );
}
