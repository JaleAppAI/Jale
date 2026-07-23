// infra/lambda/whatsapp/domain-outbox-drain.ts
//
// EventBridge-scheduled (every 1 minute) crash-safe drain of
// worker_domain_outbox events written by the workflow lane's
// completeOnboarding() (migration 042). This Lambda owns lease + dispatch +
// retry/backoff orchestration only — it never talks to Twilio and never
// implements onboarding/trust business logic itself:
//
//   - `worker.ready` events are dispatched to C6's `releaseWorkerReady()`
//     (imported, never re-implemented here). That call is
//     CALLER-OWNED-TRANSACTION and requires
//     `app.current_internal_user_id` RLS context set to the leased event's
//     `aggregate_id` (== workerId) BEFORE it is invoked — see the BEGIN /
//     setInternalUserRlsContext / releaseWorkerReady / UPDATE...completed /
//     COMMIT sequence in processWorkerReady() below.
//   - `assessment.requested` events are acknowledged only: this Lambda does
//     NOT call Bedrock and does NOT score anything. The workflow lane
//     already inserts the pending `worker_trust_assessments` row during the
//     trust questions; scoring is jale_ai's job (wired in a later task).
//     This handler's INSERT is a defensive, idempotent no-op in the normal
//     flow — see the plan's assessment.requested section. C10 owns wiring
//     the real scoring/assessment lane.
//
// Renderer: `releaseWorkerReady` needs a `ReleaseRenderer`. C2's
// `createReleaseRenderer()` (workflow lane) is not merged into this branch
// yet — it lands at C10 — so the renderer is an INJECTED dependency here
// (`deps.renderer`, defaulted to a placeholder that throws). C10 replaces
// the default with the real `createReleaseRenderer()` wiring.
//
// Log safety: every console.log line in this module is restricted to safe
// scalars (metric name, event_type, attempts, counts) — never the caught
// error message/last_error, a phone number, or an OTP value. `last_error`
// is a DB column only.
import type { Pool, PoolClient } from 'pg';
import { getDbPool, setInternalUserRlsContext } from '../lib/db';
import { releaseWorkerReady } from './worker-ready-release';
import type { ReleaseRenderer } from './lib/onboarding-types';

export const MAX_DOMAIN_EVENT_ATTEMPTS = 5;
export const DOMAIN_EVENT_BATCH_LIMIT = 25;

const BACKOFF_BASE_MS = 30 * 1000; // 30s
const BACKOFF_CAP_MS = 30 * 60 * 1000; // 30min
const BACKLOG_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

type DomainEventType = 'worker.ready' | 'assessment.requested';

interface LeasedDomainEventRow {
  id: string;
  event_type: DomainEventType;
  aggregate_id: string;
  event_key: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  created_at: Date | string;
}

export interface DomainOutboxDrainDeps {
  renderer: ReleaseRenderer;
  now?: () => Date;
}

// Placeholder until C10 wires the real createReleaseRenderer() (workflow
// lane, not merged into this branch — lands at C10). Synth never executes
// this; tests inject a fake/recording renderer.
const unwiredRenderer: ReleaseRenderer = {
  async render() {
    throw new Error(
      'release_renderer_not_wired: domain-outbox-drain has no ReleaseRenderer '
      + 'injected. C10 wires the real createReleaseRenderer() here.',
    );
  },
};

const defaultDeps: DomainOutboxDrainDeps = { renderer: unwiredRenderer };

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Leases up to `limit` domain events total across BOTH event types in one
 * invocation. `lease_worker_domain_events` (migration 042) validates a
 * single `p_event_type` and REJECTS `p_limit < 1` with error 22023 — so the
 * shared budget is tracked in code: `worker.ready` is leased first with the
 * full limit, then `assessment.requested` is leased with whatever budget
 * remains. If the first call already exhausts the budget, the second call
 * is skipped entirely rather than passed a 0 limit (which would throw).
 * This is what makes "claims at most DOMAIN_EVENT_BATCH_LIMIT per
 * invocation" true in code, not merely by trusting the DB-side LIMIT.
 */
async function leaseBatch(client: PoolClient, limit: number): Promise<LeasedDomainEventRow[]> {
  if (limit <= 0) return [];

  const readyResult = await client.query<LeasedDomainEventRow>(
    `SELECT * FROM lease_worker_domain_events($1, $2)`,
    ['worker.ready', limit],
  );
  const claimed: LeasedDomainEventRow[] = [...readyResult.rows];

  const remaining = limit - claimed.length;
  if (remaining > 0) {
    const assessmentResult = await client.query<LeasedDomainEventRow>(
      `SELECT * FROM lease_worker_domain_events($1, $2)`,
      ['assessment.requested', remaining],
    );
    claimed.push(...assessmentResult.rows);
  }

  return claimed;
}

function emitBacklogAgedIfStale(event: LeasedDomainEventRow, now: Date): void {
  const createdAt = toDate(event.created_at);
  if (now.getTime() - createdAt.getTime() > BACKLOG_AGE_THRESHOLD_MS) {
    console.log(JSON.stringify({ metric: 'WhatsAppDeferredBacklogAged', event_type: event.event_type }));
  }
}

/**
 * Records a dispatch failure in a SEPARATE transaction from the one that
 * was just rolled back (per the plan's failure policy). Sets RLS context to
 * the event's aggregate_id first — the terminal UPDATE on
 * worker_domain_outbox is RLS-gated on `aggregate_id =
 * current_setting('app.current_internal_user_id', true)`. `last_error` is
 * stored in the DB row only; it is never written to a log line.
 */
async function markFailure(client: PoolClient, event: LeasedDomainEventRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = event.attempts + 1;
  const atCap = attempts >= MAX_DOMAIN_EVENT_ATTEMPTS;

  await client.query('BEGIN');
  try {
    await setInternalUserRlsContext(client, event.aggregate_id);
    if (atCap) {
      await client.query(
        `UPDATE worker_domain_outbox
            SET status = 'failed', attempts = $2, last_error = $3, updated_at = now()
          WHERE event_key = $1`,
        [event.event_key, attempts, message],
      );
    } else {
      const delay = backoffMs(attempts);
      await client.query(
        `UPDATE worker_domain_outbox
            SET status = 'pending', attempts = $2, last_error = $3,
                next_attempt_at = now() + ($4 || ' milliseconds')::interval,
                updated_at = now()
          WHERE event_key = $1`,
        [event.event_key, attempts, message, String(delay)],
      );
    }
    await client.query('COMMIT');
  } catch (markErr) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw markErr;
  }

  if (atCap) {
    console.log(JSON.stringify({ metric: 'WhatsAppDomainEventStuck', event_type: event.event_type, attempts }));
  }
}

/**
 * Dispatches one `worker.ready` event: BEGIN, set RLS context to
 * aggregate_id (== workerId), call releaseWorkerReady exactly once, mark
 * the event completed, COMMIT — all in the same transaction, per the
 * binding contract locked by the C6 review. On any throw: ROLLBACK, emit
 * WhatsAppReleaseFailure, then markFailure() in its own transaction.
 */
async function processWorkerReady(
  client: PoolClient,
  event: LeasedDomainEventRow,
  deps: DomainOutboxDrainDeps,
): Promise<boolean> {
  try {
    await client.query('BEGIN');
    await setInternalUserRlsContext(client, event.aggregate_id);
    await releaseWorkerReady(client, event.event_key, { renderer: deps.renderer, now: deps.now });
    await client.query(
      `UPDATE worker_domain_outbox SET status = 'completed', updated_at = now() WHERE event_key = $1`,
      [event.event_key],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.log(JSON.stringify({ metric: 'WhatsAppReleaseFailure', event_type: event.event_type }));
    await markFailure(client, event, err);
    return false;
  }
}

/**
 * Dispatches one `assessment.requested` event. No Bedrock call, no scoring
 * — the workflow lane already inserted the pending worker_trust_assessments
 * row during the trust questions. This is an idempotent acknowledge:
 *   - payload carries a string `profession_key` → INSERT a pending row,
 *     ON CONFLICT DO NOTHING against the existing active-assessment unique
 *     index (a no-op in the normal flow, since the workflow lane's row
 *     already exists).
 *   - otherwise → mark the event completed without inserting.
 * Either way, RLS context is set to aggregate_id first because the
 * terminal UPDATE on worker_domain_outbox is RLS-gated on aggregate_id
 * (the worker_trust_assessments INSERT itself needs no context — its
 * `wta_whatsapp_pending_rows` policy is USING true).
 */
async function processAssessmentRequested(
  client: PoolClient,
  event: LeasedDomainEventRow,
): Promise<boolean> {
  try {
    await client.query('BEGIN');
    await setInternalUserRlsContext(client, event.aggregate_id);

    const payload = event.payload ?? {};
    const professionKey = typeof payload.profession_key === 'string' && payload.profession_key
      ? payload.profession_key
      : null;

    if (professionKey) {
      const answers = Array.isArray(payload.answers) ? payload.answers : [];
      await client.query(
        `INSERT INTO worker_trust_assessments (id, user_id, profession_key, answers, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, 'pending', now())
         ON CONFLICT (user_id, profession_key) WHERE status IN ('pending','scoring','scored') DO NOTHING`,
        [event.aggregate_id, professionKey, JSON.stringify(answers)],
      );
    }

    await client.query(
      `UPDATE worker_domain_outbox SET status = 'completed', updated_at = now() WHERE event_key = $1`,
      [event.event_key],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    await markFailure(client, event, err);
    return false;
  }
}

// Module-level seam for the real EventBridge entrypoint (`handler`, which
// per the plan's interface takes NO arguments — EventBridge invokes it with
// a ScheduledEvent as the first argument, so `deps` must never be read from
// a handler parameter or the ScheduledEvent object would silently become
// `deps` and `deps.renderer` would be undefined). C10 calls
// `setDomainOutboxDrainDeps({ renderer: createReleaseRenderer(), ... })`
// once at module load to replace the unwired placeholder with the real
// renderer. Tests exercise the orchestration logic directly through
// `runDrain(pool, deps)` instead, which takes deps explicitly.
let activeDeps: DomainOutboxDrainDeps = defaultDeps;

/** C10 wiring seam — see the module-level comment above. */
export function setDomainOutboxDrainDeps(deps: DomainOutboxDrainDeps): void {
  activeDeps = deps;
}

export async function runDrain(
  pool: Pool,
  deps: DomainOutboxDrainDeps = defaultDeps,
): Promise<{ claimed: number; completed: number; failed: number }> {
  const now = deps.now ? deps.now() : new Date();
  const client = await pool.connect();
  try {
    const leased = await leaseBatch(client, DOMAIN_EVENT_BATCH_LIMIT);

    let completed = 0;
    let failed = 0;

    for (const event of leased) {
      emitBacklogAgedIfStale(event, now);

      const ok = event.event_type === 'worker.ready'
        ? await processWorkerReady(client, event, deps)
        : await processAssessmentRequested(client, event);

      if (ok) completed += 1;
      else failed += 1;
    }

    return { claimed: leased.length, completed, failed };
  } finally {
    client.release();
  }
}

// EventBridge entrypoint. Deliberately takes no meaningful argument (matches
// the plan's `handler: () => Promise<...>` interface) — EventBridge invokes
// this with a ScheduledEvent as its first argument, which must NEVER be
// mistaken for `deps` (see the comment on `activeDeps` above).
export const handler = async (): Promise<{ claimed: number; completed: number; failed: number }> => {
  const pool = await getDbPool();
  return runDrain(pool, activeDeps);
};
