import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { MessageCategory } from './onboarding-types';

// O1 — Deferred re-trigger sweep (Design D1, binding).
//
// When `deferred_delivery_enabled` is false, evaluateDelivery() defers
// ready-worker business intents with reason 'delivery_disabled'
// (delivery-policy.ts:51-53). The `worker.ready` domain event that made the
// worker ready in the first place is consumed (marked 'completed') by the
// scheduled drain the moment it releases whatever was eligible at that time
// — so once an operator later flips `deferred_delivery_enabled` back on,
// there is no outstanding trigger left to release the intents that piled up
// while it was off.
//
// This module NEVER edits domain-outbox-drain.ts (Lane C2-owned) and NEVER
// calls releaseWorkerReady itself. It only re-emits fresh `worker.ready`
// events into `worker_domain_outbox` (status 'pending') so the EXISTING
// scheduled drain leases them and calls the existing, unmodified
// releaseWorkerReady() exactly as it already does for a first-time
// completion.
//
// Idempotency/concurrency reasoning (why repeated/concurrent sweeps cannot
// duplicate messages or sequences):
//   - Each inserted event gets a fresh, sweep-generation-scoped
//     `event_key` (`worker.ready:sweep:<workerId>:<sweepRunId>`), distinct
//     from the original `worker.ready:<workerId>:<runId>` key completeOnboarding
//     wrote and from any other sweep generation. worker_domain_outbox.event_key
//     is UNIQUE, so a duplicate INSERT within one sweep generation (e.g. a
//     retried batch) is a no-op via ON CONFLICT DO NOTHING.
//   - The actual release-time correctness does not depend on the sweep at
//     all: releaseWorkerReady() leases worker_message_intents rows
//     `WHERE status IN ('deferred','eligible') ... FOR UPDATE SKIP LOCKED`.
//     Once an intent has been released, its status is 'released' (or a
//     terminal discard status) and it is never re-leased by a second
//     worker.ready event for the same worker, no matter how many sweep
//     generations run. The onboarding-complete confirmation is additionally
//     guarded by the `onboarding-complete:<workerId>` dedupe key, so a
//     repeated release for the same worker cannot re-synthesize it either.
//   - Consequently, two concurrent sweeps (or one sweep run twice) can at
//     worst enqueue two harmless extra `worker.ready` events for the same
//     worker; the drain will lease and process each, and the second
//     releaseWorkerReady() call will simply find zero eligible intents left
//     to release (0 released, 0 expired/superseded/failed) — never a
//     duplicate send.
//   - The `NOT EXISTS` guard matches only this sweep generation. It makes
//     internal paging terminate after each worker is inserted, while unrelated
//     pending/processing events never suppress this enable operation safety trigger.
// RLS precondition: this function is designed to run as `jale_admin`, which
// already holds definer policies (USING true) on every table it touches —
// `worker_onboarding_state_definer` and `worker_domain_outbox_definer`
// (migration 042) plus `worker_message_intents_definer` (migration 043, FOR
// ALL USING true). No new migration is required for this sweep: verified
// empirically against the local testbed that a `SET ROLE jale_admin` SELECT
// over the eligibility join below returns seeded rows on the 001-043 chain.
//
// Ownership/errors: caller owns the transaction — this function issues no
// BEGIN/COMMIT/ROLLBACK of its own, matching the releaseWorkerReady /
// completeOnboarding convention used elsewhere in this lane.

const BUSINESS_CATEGORIES: MessageCategory[] = ['account', 'job_alert', 'employer_chat'];

const DEFAULT_BATCH_LIMIT = 500;

interface EligibleWorkerRow {
  user_id: string;
}

export interface RetriggerDeferredReadyWorkersOptions {
  /** Max workers enqueued per DB round-trip. Loops internally until none remain. */
  limit?: number;
  /**
   * Identifies this sweep generation for event_key uniqueness. Defaults to a
   * fresh UUID per call — pass one explicitly only for deterministic tests.
   */
  sweepRunId?: string;
  now?: () => Date;
}

export interface RetriggerDeferredReadyWorkersResult {
  /** Distinct workers for whom a fresh worker.ready event was enqueued. */
  workersSwept: number;
  /** Total worker_domain_outbox rows actually inserted (excludes ON CONFLICT no-ops). */
  eventsEnqueued: number;
}

/**
 * Finds every 'ready' worker who still has at least one deferred, unrendered
 * business-category intent (`account` | `job_alert` | `employer_chat` — the
 * categories evaluateDelivery() defers with reason 'delivery_disabled'; NOT
 * 'onboarding'/'security', which are never subject to that gate) and
 * re-emits a `worker.ready` domain event for each so the existing scheduled
 * drain releases them. Processes in bounded chunks of `limit` workers,
 * looping until none remain, so a large backlog cannot exceed the caller's
 * intended enqueue batch size in a single DB round-trip.
 */
export async function retriggerDeferredReadyWorkers(
  client: PoolClient,
  options: RetriggerDeferredReadyWorkersOptions = {},
): Promise<RetriggerDeferredReadyWorkersResult> {
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('retrigger_sweep_invalid_limit');
  }
  const sweepRunId = options.sweepRunId ?? randomUUID();

  let workersSwept = 0;
  let eventsEnqueued = 0;

  for (;;) {
    const eligible = await client.query<EligibleWorkerRow>(
      `SELECT DISTINCT s.user_id
         FROM worker_onboarding_state s
         JOIN worker_message_intents i ON i.user_id = s.user_id
        WHERE s.lifecycle = 'ready'
          AND i.status = 'deferred'
          AND i.outbox_id IS NULL
          AND i.category = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1
              FROM worker_domain_outbox o
             WHERE o.aggregate_id = s.user_id
               AND o.event_type = 'worker.ready'
               AND o.event_key = 'worker.ready:sweep:' || s.user_id::text || ':' || $3
          )
        ORDER BY s.user_id
        LIMIT $2`,
      [BUSINESS_CATEGORIES, limit, sweepRunId],
    );

    if (eligible.rows.length === 0) break;

    for (const row of eligible.rows) {
      const eventKey = `worker.ready:sweep:${row.user_id}:${sweepRunId}`;
      const inserted = await client.query(
        `INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key, payload)
         VALUES ('worker.ready', $1, $2, '{}'::jsonb)
         ON CONFLICT (event_key) DO NOTHING`,
        [row.user_id, eventKey],
      );
      workersSwept += 1;
      if ((inserted.rowCount ?? 0) > 0) {
        eventsEnqueued += 1;
      }
    }

    // A batch smaller than `limit` means there is nothing left to page
    // through — stop instead of issuing one more (empty) round-trip.
    if (eligible.rows.length < limit) break;
  }

  return { workersSwept, eventsEnqueued };
}
