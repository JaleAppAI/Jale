import type { PoolClient } from 'pg';
import { hashToken } from '../../lib/referral-codes';

/**
 * WhatsApp referral carry-through (migration 056): parks a referral code
 * against a phone before any `users` row exists, and claims it once that
 * phone finishes onboarding and gets a `workerId`.
 *
 * Caller owns the transaction — same contract as every other function in
 * `onboarding-repository.ts`: no BEGIN/COMMIT/ROLLBACK here, both functions
 * take an already-open `PoolClient` so they enlist in whatever transaction
 * the caller is already running.
 *
 * Never logs a raw token, a phone number, or a phone_hash — only ids and
 * booleans cross into any log line a caller might add around these calls.
 */

/** A pending claim survives up to 30 days — long enough for a worker to
 * receive the WhatsApp code, get distracted, and come back to finish
 * onboarding days later. */
const PENDING_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ParkClaimResult {
  /** False for an unknown, expired, or already-consumed token — indistinguishable
   * from "no code sent at all" to every caller; never surfaced to the sender. */
  parked: boolean;
}

export interface ClaimReferralResult {
  /** False when no unclaimed, unexpired pending claim exists for this phone. */
  claimed: boolean;
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
 * DO UPDATE` so a second code from the same phone replaces the first
 * (newest code wins), resetting any prior claimed state since this is,
 * semantically, a brand-new pending claim.
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
    return { parked: false };
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
            claimed_at         = NULL,
            claimed_worker_id  = NULL,
            updated_at         = EXCLUDED.updated_at`,
    [phoneHash, token.job_id, token.share_code, referrerWorkerId, token.locale, expiresAt, nowIso],
  );

  return { parked: true };
}

/**
 * Finds an unclaimed, unexpired `referral_pending_claims` row for
 * `phoneHash` and, if one exists, marks it claimed (`claimed_at` +
 * `claimed_worker_id` together, per the table's coherence CHECK) and writes
 * `worker_attribution` for `workerId`.
 *
 * `first_*` is inserted once and NEVER updated — the `DO UPDATE SET` list
 * below deliberately omits every `first_*` column, because
 * `worker_attribution_first_touch_immutable` (migration 056) raises on any
 * UPDATE that changes one. `latest_*` is always refreshed. The share link's
 * `referrer_worker_id` is copied into BOTH `first_referrer_worker_id` and
 * `latest_referrer_worker_id` at write time: `job_share_links.referrer_worker_id`
 * is `ON DELETE SET NULL`, so this denormalization is what preserves credit
 * after a referring worker's account is later deleted.
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
  }>(
    `UPDATE referral_pending_claims
        SET claimed_at = $2,
            claimed_worker_id = $3,
            updated_at = $2
      WHERE phone_hash = $1
        AND claimed_at IS NULL
        AND expires_at > $2
      RETURNING job_id, share_code, referrer_worker_id`,
    [phoneHash, nowIso, workerId],
  );

  const claim = claimResult.rows[0];
  if (!claim) {
    return { claimed: false };
  }

  // The channel that EARNED the referral is the share link's own channel
  // (e.g. 'facebook') — never the WhatsApp arrival transport, which is
  // merely how the person reached us after clicking that link. Conflating
  // the two would make "which channel drove this referral" unanswerable,
  // exactly the question `worker_attribution` exists to answer. A null
  // `share_code` genuinely carries no channel information, so 'unknown' is
  // the honest value here — never a fabricated 'whatsapp'.
  let channel = 'unknown';
  if (claim.share_code) {
    const shareResult = await client.query<{ channel: string }>(
      `SELECT channel FROM job_share_links WHERE code = $1`,
      [claim.share_code],
    );
    channel = shareResult.rows[0]?.channel ?? 'unknown';
  }

  await client.query(
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
    [workerId, claim.share_code, channel, claim.job_id, claim.referrer_worker_id, nowIso],
  );

  return { claimed: true };
}
