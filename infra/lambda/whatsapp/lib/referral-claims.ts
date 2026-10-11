import type { PoolClient } from 'pg';
import { hashToken } from '../../lib/referral-codes';
import { isSelfReferral, writeAttribution } from '../../lib/referral-attribution';
import { recordReferredJob } from '../../lib/referred-jobs';

/**
 * WhatsApp referral carry-through (migration 056): parks a referral code
 * against a phone before any `users` row exists, and claims it once that
 * phone finishes onboarding and gets a `workerId`.
 *
 * Caller owns the transaction — same contract as every other function in
 * `onboarding-repository.ts`: no BEGIN/COMMIT/ROLLBACK here, every function
 * takes an already-open `PoolClient` so it enlists in whatever transaction
 * the caller is already running. The SAVEPOINTs in this file are
 * `claimPendingReferral`'s own: one around its referred-jobs records, and
 * inside it one for each earlier parked job, so that a failed record of one is
 * rolled back alone. Each is always released or rolled back before the
 * function returns.
 *
 * The token is recognised at every stage of the WhatsApp door, so the
 * read-only helpers the steps share live here too — `resolveApplyToken`,
 * `loadActiveJobLabel`, `findUnclaimedParkedJobId` and `isOpenUnappliedJob`.
 *
 * Never logs a raw token, a phone number, or a phone_hash — only static
 * metrics cross into any log line here or a caller might add around these
 * calls.
 */

/** A pending claim survives up to 30 days — long enough for a worker to
 * receive the WhatsApp code, get distracted, and come back to finish
 * onboarding days later. */
const PENDING_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ParkClaimResult {
  /** False for an unknown, expired, or already-consumed token — indistinguishable
   * from "no code sent at all" to every caller; never surfaced to the sender. */
  parked: boolean;
  /** The token's job when parked, so the first reply can name it. Null
   * whenever `parked` is false: a dead token reveals nothing. */
  jobId: string | null;
  /** The token row's own `locale` (`^[a-z]{2}$`, nullable) when parked: the
   * language of the page the link was opened on. Null otherwise. */
  locale: string | null;
}

export interface ClaimReferralResult {
  /** True when an unclaimed, unexpired pending claim for this phone was
   * consumed -- whether or not it earned attribution (a self-referral
   * consumes the claim and credits nobody). False when there was none. */
  claimed: boolean;
  /** The claimed job whenever a claim was consumed, so the OTP bind can hand
   * it to the processor. Null when nothing was claimed. */
  jobId: string | null;
}

/**
 * Looks up `referral_apply_tokens` by `hashToken(rawToken)`. A token is only
 * usable when `consumed_at IS NULL AND expires_at > now` — anything else
 * (unknown hash, already consumed, expired) is treated identically: no park,
 * no error, no disclosure to the caller about *why*.
 *
 * On a valid token: marks it consumed (`consumed_at` + `consumed_phone_hash`
 * together, per the table's coherence CHECK), resolves the referring worker
 * and share code from the token's share link, then upserts
 * `referral_pending_claims` keyed on `phone_hash` — `ON CONFLICT (phone_hash)
 * DO UPDATE` so a second code from the same phone takes over the claim: its
 * job, share code and referrer are what the claim credits (the last code
 * wins the credit).
 *
 * The job it takes over from is not dropped. While the existing claim is
 * still unclaimed, that job is appended to `earlier_job_ids` (once, never the
 * incoming job), so every job parked on the phone before sign-in reaches the
 * worker's list at the claim. A claimed row is semantically a brand-new
 * pending claim: its claimed state is reset and it starts an empty set.
 */
export async function parkPendingClaim(
  client: PoolClient,
  phoneHash: string,
  rawToken: string,
  now: Date,
): Promise<ParkClaimResult> {
  const tokenHash = hashToken(rawToken);
  const nowIso = now.toISOString();

  const tokenResult = await client.query<{
    share_code: string | null;
    job_id: string;
    locale: string | null;
  }>(
    `UPDATE referral_apply_tokens
        SET consumed_at = $2,
            consumed_phone_hash = $3
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2
      RETURNING share_code, job_id, locale`,
    [tokenHash, nowIso, phoneHash],
  );

  const token = tokenResult.rows[0];
  if (!token) {
    return { parked: false, jobId: null, locale: null };
  }

  let referrerWorkerId: string | null = null;
  if (token.share_code) {
    const shareResult = await client.query<{ referrer_worker_id: string | null }>(
      `SELECT referrer_worker_id FROM job_share_links WHERE code = $1`,
      [token.share_code],
    );
    referrerWorkerId = shareResult.rows[0]?.referrer_worker_id ?? null;
  }

  const expiresAt = new Date(now.getTime() + PENDING_CLAIM_TTL_MS).toISOString();

  await client.query(
    `INSERT INTO referral_pending_claims
        (phone_hash, job_id, share_code, referrer_worker_id, locale, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (phone_hash) DO UPDATE
        SET job_id             = EXCLUDED.job_id,
            share_code         = EXCLUDED.share_code,
            referrer_worker_id = EXCLUDED.referrer_worker_id,
            locale             = EXCLUDED.locale,
            expires_at         = EXCLUDED.expires_at,
            earlier_job_ids    = CASE
                                   WHEN referral_pending_claims.claimed_at IS NULL
                                   THEN array_remove(array_remove(referral_pending_claims.earlier_job_ids,
                                                                  referral_pending_claims.job_id)
                                                     || referral_pending_claims.job_id,
                                                     EXCLUDED.job_id)
                                   ELSE '{}'::uuid[]
                                 END,
            claimed_at         = NULL,
            claimed_worker_id  = NULL,
            updated_at         = EXCLUDED.updated_at`,
    [phoneHash, token.job_id, token.share_code, referrerWorkerId, token.locale, expiresAt, nowIso],
  );

  return { parked: true, jobId: token.job_id, locale: token.locale };
}

/**
 * Finds an unclaimed, unexpired `referral_pending_claims` row for
 * `phoneHash` and, if one exists, marks it claimed (`claimed_at` +
 * `claimed_worker_id` together, per the table's coherence CHECK), writes
 * `worker_attribution` for `workerId` from the claim's own (last) code, and
 * records the claimed job -- and every job parked on the phone before it --
 * on the worker's referred-jobs list.
 *
 * `first_*` is inserted once and NEVER updated — the `DO UPDATE SET` list in
 * the shared upsert deliberately omits every `first_*` column, because
 * `worker_attribution_first_touch_immutable` (migration 056) raises on any
 * UPDATE that changes one. `latest_*` is always refreshed. The share link's
 * referrers are copied into BOTH `first_*` and `latest_*` at write time:
 * `job_share_links.referrer_worker_id` and `referrer_employer_id` are
 * `ON DELETE SET NULL`, so this denormalization is what preserves credit
 * after a referrer's account is later deleted.
 *
 * Callers: completion on both doors, inside the lifecycle-flip
 * transaction, and the OTP bind of an already-ready worker. Each runs as
 * jale_whatsapp and sets `app.current_internal_user_id` to `workerId` first:
 * the setting migration 103's policy on `worker_referred_jobs` is keyed on.
 */
export async function claimPendingReferral(
  client: PoolClient,
  phoneHash: string,
  workerId: string,
  now: Date,
): Promise<ClaimReferralResult> {
  const nowIso = now.toISOString();

  const claimResult = await client.query<{
    job_id: string;
    share_code: string | null;
    referrer_worker_id: string | null;
    earlier_job_ids: string[] | null;
  }>(
    `UPDATE referral_pending_claims
        SET claimed_at = $2,
            claimed_worker_id = $3,
            updated_at = $2
      WHERE phone_hash = $1
        AND claimed_at IS NULL
        AND expires_at > $2
      RETURNING job_id, share_code, referrer_worker_id, earlier_job_ids`,
    [phoneHash, nowIso, workerId],
  );

  const claim = claimResult.rows[0];
  if (!claim) {
    return { claimed: false, jobId: null };
  }

  // The credit comes from the share link AS IT STANDS NOW -- the same read
  // `writeWebAttribution` does: both referrer columns, and only a link that
  // has not been revoked. The `referrer_worker_id` parked on the claim is
  // not trusted any more: it was copied at park time, and it never carried
  // an EMPLOYER referrer at all, so an employer who shared the job was never
  // credited.
  //
  // The channel that EARNED the referral is the share link's own channel
  // (e.g. 'facebook') — never the WhatsApp arrival transport, which is
  // merely how the person reached us after clicking that link. Conflating
  // the two would make "which channel drove this referral" unanswerable,
  // exactly the question `worker_attribution` exists to answer. No share
  // code, or no live link behind it, genuinely carries no channel and no
  // referrer, so that is a job-only attribution with channel 'unknown' —
  // never a fabricated 'whatsapp'.
  let link: { channel: string; referrer_worker_id: string | null; referrer_employer_id: string | null } | null = null;
  if (claim.share_code) {
    const shareResult = await client.query<{
      channel: string;
      referrer_worker_id: string | null;
      referrer_employer_id: string | null;
    }>(
      `SELECT channel, referrer_worker_id, referrer_employer_id
         FROM job_share_links
        WHERE code = $1
          AND revoked_at IS NULL`,
      [claim.share_code],
    );
    link = shareResult.rows[0] ?? null;
  }

  // A self-referral consumes the claim and credits nobody, exactly as on the
  // web (`isSelfReferral`). The job is still the one the worker came for, so
  // it is still recorded below.
  if (!link || !isSelfReferral(link, workerId)) {
    // Delegates to the single shared upsert (lib/referral-attribution.ts) —
    // review found this statement existing in three diverged copies, and
    // this lane's copy reported success even when FORCE RLS silently
    // filtered the write to zero rows. The shared implementation is loud
    // about that case.
    await writeAttribution(
      client,
      workerId,
      link
        ? {
            jobId: claim.job_id,
            channel: link.channel,
            shareCode: claim.share_code,
            referrerWorkerId: link.referrer_worker_id,
            referrerEmployerId: link.referrer_employer_id,
          }
        : {
            jobId: claim.job_id,
            channel: 'unknown',
            shareCode: null,
            referrerWorkerId: null,
            referrerEmployerId: null,
          },
      now,
      'WhatsappAttributionNotPersisted',
    );
  }

  // Sprint 27: the job goes on the worker's referred-jobs list (migration
  // 103) -- that list, not this claim, is what pins the job to the top of
  // their feed and sends it as a card at the end of onboarding. Behind its
  // OWN savepoint, inside this function: completion calls it bare in the
  // lifecycle-flip transaction, where an errored statement would abort the
  // whole transaction (25P02 on everything after it, even if caught), and a
  // bookkeeping write must never cost a worker their onboarding. Records
  // only while the job is active (`recordReferredJob`). Static metric only.
  //
  // The jobs parked on this phone before the last code go on the list first,
  // oldest first, each a millisecond older than the next, so the claimed job
  // -- the last code's -- stays the newest. Each earlier job has a savepoint
  // of its own inside this one: an earlier job whose record fails (its
  // employer deleted it a moment ago, say) is rolled back alone and never
  // costs the other jobs or the claimed one. The claimed job is recorded in
  // this savepoint itself, and never twice.
  const earlierJobIds = (claim.earlier_job_ids ?? []).filter((id) => id !== claim.job_id);
  try {
    await client.query('SAVEPOINT referral_claim_record');
    for (const [index, earlierJobId] of earlierJobIds.entries()) {
      await client.query('SAVEPOINT referral_claim_earlier_job');
      try {
        await recordReferredJob(client, {
          workerId,
          jobId: earlierJobId,
          source: 'whatsapp_token',
          now: new Date(now.getTime() - (earlierJobIds.length - index)),
        });
        await client.query('RELEASE SAVEPOINT referral_claim_earlier_job');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT referral_claim_earlier_job');
        await client.query('RELEASE SAVEPOINT referral_claim_earlier_job');
        console.error(JSON.stringify({ metric: 'ReferredJobRecordFailed' }));
      }
    }
    await recordReferredJob(client, { workerId, jobId: claim.job_id, source: 'whatsapp_token', now });
    await client.query('RELEASE SAVEPOINT referral_claim_record');
  } catch {
    try {
      await client.query('ROLLBACK TO SAVEPOINT referral_claim_record');
    } catch {
      // The transaction is already unusable; the caller's retry/DLQ
      // handling takes over as it would for any other failed statement.
    }
    console.error(JSON.stringify({ metric: 'ReferredJobRecordFailed' }));
  }

  return { claimed: true, jobId: claim.job_id };
}

/**
 * The token row behind a typed or prefilled `JALE-XXXXXXXX` code. READ ONLY,
 * and deliberately so: unlike `parkPendingClaim` it never consumes the token
 * and checks neither `consumed_at` nor `expires_at` -- whether the row EXISTS
 * is the whole question. Used for a ready worker's typed code (processor.ts,
 * where an inquiry must not spend the code meant for someone else) and for
 * a bound worker mid-onboarding (onboarding-v2.ts), where a consumed or
 * expired code still means "this is a job, not my name".
 *
 * `jale_whatsapp` holds SELECT on `referral_apply_tokens`. The raw token is
 * hashed before it touches SQL and is never logged.
 */
export interface ApplyTokenRow {
  job_id: string;
  share_code: string | null;
  expires_at: string;
}

export async function resolveApplyToken(
  client: PoolClient,
  rawToken: string,
): Promise<ApplyTokenRow | null> {
  const res = await client.query<ApplyTokenRow>(
    `SELECT job_id, share_code, expires_at FROM referral_apply_tokens WHERE token_hash = $1`,
    [hashToken(rawToken)],
  );
  return res.rows[0] ?? null;
}

/**
 * The title and company an acknowledgement names, for an ACTIVE job only --
 * a paused, filled or closed job is never named, because it will never be
 * sent. `COALESCE(company, 'Jale')` is the feed's own expression
 * (job-matching.ts), so the ack and the card name a company the same way.
 */
export async function loadActiveJobLabel(
  client: PoolClient,
  jobId: string,
): Promise<{ title: string; company: string } | null> {
  const res = await client.query<{ title: string; company: string }>(
    `SELECT title, COALESCE(company, 'Jale') AS company
       FROM jobs
      WHERE id = $1
        AND status = 'active'`,
    [jobId],
  );
  return res.rows[0] ?? null;
}

/**
 * The job of this phone's parked claim while it is still UNCLAIMED. A new
 * token parked on top of it takes over the claim and keeps this job in the
 * claim's earlier set; a bound worker's second token reads it first all the
 * same, so the earlier job is on their list right away, not only at the claim.
 */
export async function findUnclaimedParkedJobId(
  client: PoolClient,
  phoneHash: string,
): Promise<string | null> {
  const res = await client.query<{ job_id: string }>(
    `SELECT job_id
       FROM referral_pending_claims
      WHERE phone_hash = $1
        AND claimed_at IS NULL`,
    [phoneHash],
  );
  return res.rows[0]?.job_id ?? null;
}

/**
 * Whether a job is open (`status = 'active'`) and this worker has not applied
 * to it -- the rule that decides whether a claimed job is still worth a card.
 * The worker is bound in the statement itself (`ja.worker_id = $2`): the
 * predicate is the boundary, and another worker's application must never
 * hide this worker's job.
 */
export async function isOpenUnappliedJob(
  client: PoolClient,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1
       FROM jobs j
      WHERE j.id = $1
        AND j.status = 'active'
        AND NOT EXISTS (
              SELECT 1
                FROM job_applications ja
               WHERE ja.job_id = j.id
                 AND ja.worker_id = $2
            )`,
    [jobId, workerId],
  );
  return (res.rowCount ?? 0) > 0;
}
