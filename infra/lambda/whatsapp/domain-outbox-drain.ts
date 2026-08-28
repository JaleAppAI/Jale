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
//   - `assessment.requested` events resolve the pending `worker_trust_assessments`
//     row (already inserted by the workflow lane during the trust questions)
//     and dispatch `{ assessmentId, userId, professionKey }` to the existing
//     TrustScorer SQS queue — BEFORE marking the event completed. This
//     Lambda never calls Bedrock and never scores anything itself; jale_ai
//     (TrustScorer) owns scoring and is idempotent against duplicate
//     messages. The same payload is ALSO fanned out to the TrustExtractor
//     queue (R1-X) on a fail-open path: that dispatch is best-effort and its
//     failure is logged, never retried and never able to fail the event.
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
import { createReleaseRenderer } from './lib/onboarding-renderers';

import { publishWorkerIntentWake } from './lib/outbox-wake';
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
  lease_token: string;
  leased_until: Date | string;
  created_at: Date | string;
}

export interface AssessmentDispatchPayload {
  assessmentId: string;
  userId: string;
  professionKey: string;
}

export interface DomainOutboxDrainDeps {
  renderer: ReleaseRenderer;
  now?: () => Date;
  dispatchAssessment?: (payload: AssessmentDispatchPayload) => Promise<void>;
  /**
   * R1-X fan-out to the TrustExtractor queue. Optional and FAIL-OPEN: unlike
   * `dispatchAssessment`, a rejection here is logged and swallowed at the call
   * site (see processAssessmentRequested) so the event still completes.
   */
  dispatchExtraction?: (payload: AssessmentDispatchPayload) => Promise<void>;
}

/**
 * Default assessment dispatcher: sends `{ assessmentId, userId,
 * professionKey }` to the TrustScorer SQS queue (`props.trustAssessmentQueue`
 * in whatsapp-stack.ts, already consumed by `lambda/ai/trust-scorer.ts`).
 * Fails closed if the queue URL is not configured — never silently no-ops.
 * Uses the repo's existing dynamic-import SQS idiom (see processor.ts) and a
 * module-scoped client for warm-start reuse.
 */
let sqsClientPromise: Promise<import('@aws-sdk/client-sqs').SQSClient> | undefined;

async function getSqsClient(): Promise<import('@aws-sdk/client-sqs').SQSClient> {
  if (!sqsClientPromise) {
    sqsClientPromise = (async () => {
      const { SQSClient } = await import('@aws-sdk/client-sqs');
      return new SQSClient({});
    })();
  }
  return sqsClientPromise;
}

export async function defaultDispatchAssessment(payload: AssessmentDispatchPayload): Promise<void> {
  const queueUrl = process.env.TRUST_ASSESSMENT_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('trust_assessment_queue_url_not_configured');
  }
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const client = await getSqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        assessmentId: payload.assessmentId,
        userId: payload.userId,
        professionKey: payload.professionKey,
      }),
    }),
  );
}

/**
 * R1-X: default extraction dispatcher — sends the SAME `{ assessmentId,
 * userId, professionKey }` payload to the TrustExtractor SQS queue
 * (`props.trustExtractionQueue` in whatsapp-stack.ts, consumed by
 * `lambda/ai/trust-extractor.ts`).
 *
 * This function itself fails closed (throws) when the queue URL is missing,
 * exactly like `defaultDispatchAssessment`, so the misconfiguration is always
 * visible. It is the CALL SITE that is fail-open: the extraction is a
 * skill-summary nicety, and losing one must never fail an onboarding event or
 * delay a trust score.
 */
export async function defaultDispatchExtraction(payload: AssessmentDispatchPayload): Promise<void> {
  const queueUrl = process.env.TRUST_EXTRACTION_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('trust_extraction_queue_url_not_configured');
  }
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const client = await getSqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        assessmentId: payload.assessmentId,
        userId: payload.userId,
        professionKey: payload.professionKey,
      }),
    }),
  );
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
    let updatedRows = 0;
    if (atCap) {
      const result = await client.query(
        `UPDATE worker_domain_outbox
            SET status='failed', attempts=$2, last_error=$3,
                leased_until=NULL, lease_token=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE event_key=$1 AND status='processing' AND lease_token=$4`,
        [event.event_key, attempts, message, event.lease_token],
      );
      updatedRows = result.rowCount ?? 0;
    } else {
      const delay = backoffMs(attempts);
      const result = await client.query(
        `UPDATE worker_domain_outbox
            SET status='pending', attempts=$2, last_error=$3,
                next_attempt_at=now() + ($4 || ' milliseconds')::interval,
                leased_until=NULL, lease_token=NULL, updated_at=now()
          WHERE event_key=$1 AND status='processing' AND lease_token=$5`,
        [event.event_key, attempts, message, String(delay), event.lease_token],
      );
      updatedRows = result.rowCount ?? 0;
    }
    if (updatedRows !== 1) {
      throw new Error('domain_event_lease_lost');
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
    const completion = await client.query(
      `UPDATE worker_domain_outbox
          SET status='completed', leased_until=NULL, lease_token=NULL,
              next_attempt_at=NULL, updated_at=now()
        WHERE event_key=$1 AND status='processing' AND lease_token=$2`,
      [event.event_key, event.lease_token],
    );
    if (completion.rowCount !== 1) throw new Error('domain_event_lease_lost');
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
 * Dispatches one `assessment.requested` event: resolves the pending
 * `worker_trust_assessments` row inserted by the workflow lane during the
 * trust questions (in the same transaction that emitted this event, per
 * `completeOnboarding()`), and sends `{ assessmentId, userId, professionKey }`
 * to the TrustScorer SQS queue BEFORE marking the event completed — all in
 * the same transaction, per the plan's ordering contract. No Bedrock call,
 * no scoring here; jale_ai (TrustScorer) owns that and idempotently claims
 * the pending row, so a duplicate SQS send from a re-leased event is
 * harmless.
 *
 * Fails closed (throws, never dispatches, never completes the event) when:
 *   - the payload's `professionKey` is missing/not a string
 *     (`assessment_provenance_missing_profession_key`)
 *   - no matching pending/scoring/scored row is found
 *     (`assessment_pending_row_not_found`)
 *   - the dispatch itself throws (e.g. queue URL unconfigured)
 * On any failure: ROLLBACK, emit WhatsAppAssessmentDispatchFailure (safe
 * scalars only), then markFailure() in its own transaction (capped retry).
 *
 * RLS context is set to aggregate_id (== userId) first — the resolve SELECT
 * and the terminal UPDATE on worker_domain_outbox both run under it (the
 * `worker_trust_assessments` SELECT policy `wta_whatsapp_pending_rows` is
 * USING(true), so the context is not strictly required for that query, but
 * setting it once up front keeps the transaction's RLS posture uniform).
 */
async function processAssessmentRequested(
  client: PoolClient,
  event: LeasedDomainEventRow,
  deps: DomainOutboxDrainDeps,
): Promise<boolean> {
  const dispatch = deps.dispatchAssessment ?? defaultDispatchAssessment;
  const dispatchExtraction = deps.dispatchExtraction ?? defaultDispatchExtraction;
  try {
    await client.query('BEGIN');
    await setInternalUserRlsContext(client, event.aggregate_id);

    const payload = event.payload ?? {};
    const professionKey = typeof payload.professionKey === 'string' && payload.professionKey
      ? payload.professionKey
      : null;
    if (!professionKey) {
      throw new Error('assessment_provenance_missing_profession_key');
    }

    const resolved = await client.query<{ id: string }>(
      `SELECT id FROM worker_trust_assessments
        WHERE user_id = $1 AND profession_key = $2
          AND status IN ('pending','scoring','scored')
        ORDER BY created_at DESC LIMIT 1`,
      [event.aggregate_id, professionKey],
    );
    const row = resolved.rows[0];
    if (!row) {
      throw new Error('assessment_pending_row_not_found');
    }
    const assessmentId = row.id;

    await dispatch({ assessmentId, userId: event.aggregate_id, professionKey });

    // R1-X fan-out, FAIL-OPEN. Deliberately swallows everything: this inner
    // catch is the only thing standing between an extraction-queue outage and
    // a rolled-back onboarding event. The metric carries safe scalars only —
    // never the caught message (an SQS error quotes the queue URL, and the
    // payload carries user ids).
    try {
      await dispatchExtraction({ assessmentId, userId: event.aggregate_id, professionKey });
    } catch {
      console.log(JSON.stringify({
        metric: 'WhatsAppExtractionDispatchFailure',
        event_type: event.event_type,
      }));
    }

    const completion = await client.query(
      `UPDATE worker_domain_outbox
          SET status='completed', leased_until=NULL, lease_token=NULL,
              next_attempt_at=NULL, updated_at=now()
        WHERE event_key=$1 AND status='processing' AND lease_token=$2`,
      [event.event_key, event.lease_token],
    );
    if (completion.rowCount !== 1) throw new Error('domain_event_lease_lost');
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.log(JSON.stringify({ metric: 'WhatsAppAssessmentDispatchFailure', event_type: event.event_type }));
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
): Promise<{ claimed: number; completed: number; failed: number; readyCompleted: number }> {
  const now = deps.now ? deps.now() : new Date();
  const client = await pool.connect();
  try {
    const leased = await leaseBatch(client, DOMAIN_EVENT_BATCH_LIMIT);

    let completed = 0;
    let readyCompleted = 0;
    let failed = 0;

    for (const event of leased) {
      emitBacklogAgedIfStale(event, now);

      const ok = event.event_type === 'worker.ready'
        ? await processWorkerReady(client, event, deps)
        : await processAssessmentRequested(client, event, deps);

      if (ok) {
        completed += 1;
        if (event.event_type === 'worker.ready') readyCompleted += 1;
      }
      else failed += 1;
    }

    // One summary line per run that DID work; silent when idle (a scheduled
    // no-op run every minute would drown the log group). Counts only —
    // respects this module's strict PII policy documented at the top.
    if (leased.length > 0) {
      console.log(JSON.stringify({
        metric: 'DomainOutboxDrained',
        leased: leased.length,
        completed,
        failed,
        readyCompleted,
      }));
    }

    return { claimed: leased.length, completed, failed, readyCompleted };
  } finally {
    client.release();
  }
}

// EventBridge entrypoint. Deliberately takes no meaningful argument (matches
// the plan's `handler: () => Promise<...>` interface) — EventBridge invokes
// this with a ScheduledEvent as its first argument, which must NEVER be
// mistaken for `deps` (see the comment on `activeDeps` above).
export const handler = async (): Promise<{ claimed: number; completed: number; failed: number; readyCompleted: number }> => {
  const pool = await getDbPool();
  const result = await runDrain(pool, activeDeps);
  if (result.readyCompleted > 0) {
    await publishWorkerIntentWake();
  }
  return result;
};

// C10 wiring seam (binding decision #3): now that the workflow lane's
// `createReleaseRenderer()` is merged into this branch, replace the unwired
// placeholder with the real renderer once at module load. The production
// `handler` reads `activeDeps`; unit tests bypass this by calling
// `runDrain(pool, explicitDeps)` directly, so this line does not affect them.
// `createReleaseRenderer()` is a pure factory (no DB/network/clock at
// construction), so calling it at import is safe.
setDomainOutboxDrainDeps({ renderer: createReleaseRenderer() });
