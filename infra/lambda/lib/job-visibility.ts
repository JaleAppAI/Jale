import type { Client, PoolClient } from 'pg';

/**
 * Shared visibility-transition logic for the three call sites that decide
 * whether a job's effective public visibility just changed, and enqueue a
 * job_visibility_events row (migration 062, via the SECURITY DEFINER
 * enqueue_job_visibility_event()) when it did:
 *   - employer-jobs-update.ts (status-only branch)
 *   - employer-job-public-listing.ts (public_listing_enabled toggle)
 *   - employer-jobs-delete.ts (job deletion -- one-directional: the job is
 *     always non-visible afterward, because it no longer exists)
 *
 * Extracted so the wasVisible/isVisible transition matrix and the
 * enqueue_job_visibility_event() call it drives live in exactly one place,
 * rather than being copy-pasted (and potentially drifting) across all three
 * handlers.
 */

/** Effective public visibility: active status AND the employer's opt-in. */
export function isEffectivelyVisible(status: string, publicListingEnabled: boolean): boolean {
  return status === 'active' && publicListingEnabled === true;
}

/**
 * Enqueues a job_visibility_events row for the SINGLE transition that
 * actually happened (false->true = 'published', true->false = 'removed'),
 * or does nothing when visibility didn't change (including active->active,
 * paused->paused, or a job that was never effectively visible in the first
 * place).
 *
 * Callers compute wasVisible/isVisible themselves (typically via
 * isEffectivelyVisible on each side of their own write) rather than this
 * function re-deriving status/public_listing_enabled -- that keeps it usable
 * from a one-sided transition like employer-jobs-delete.ts, where "after" is
 * always not-visible-because-the-row-is-gone, with no second status/enabled
 * pair to read.
 */
export async function enqueueVisibilityTransition(
  client: Client | PoolClient,
  jobId: string,
  publicCode: string,
  wasVisible: boolean,
  isVisible: boolean,
): Promise<void> {
  if (!wasVisible && isVisible) {
    await client.query(`SELECT enqueue_job_visibility_event($1, $2, $3)`, [jobId, publicCode, 'published']);
  } else if (wasVisible && !isVisible) {
    await client.query(`SELECT enqueue_job_visibility_event($1, $2, $3)`, [jobId, publicCode, 'removed']);
  }
}

/**
 * Enqueues a 'published' ping for a job whose effective visibility did NOT
 * change -- unlike enqueueVisibilityTransition above, which only fires on an
 * actual wasVisible/isVisible flip. Used by employer-jobs-update.ts's
 * content-edit path: a title/description/etc edit never changes status or
 * public_listing_enabled, so enqueueVisibilityTransition would silently no-op
 * there, yet Google's Indexing API still needs to know the content behind an
 * already-published URL changed.
 *
 * Callers MUST dedupe before calling this (e.g. skip when a pending
 * 'published' row already exists for this job_id) -- rapid successive edits
 * must not flood the quota-limited Indexing API drain with redundant pings.
 */
export async function enqueueVisibilityPing(
  client: Client | PoolClient,
  jobId: string,
  publicCode: string,
): Promise<void> {
  await client.query(`SELECT enqueue_job_visibility_event($1, $2, $3)`, [jobId, publicCode, 'published']);
}
