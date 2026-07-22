import type { PoolClient } from 'pg';
import {
  DELIVERY_POLICY_VERSION,
  type DeliveryDecision,
  type IntentStatus,
  type WorkerMessageIntentInput,
  type RenderedOutboxMessage,
  type CategoryRenderer,
} from './onboarding-types';
import { evaluateDelivery } from './delivery-policy';
import { loadRuntimeControls } from './runtime-controls';
import { loadWorkerGate } from './onboarding-repository';
import { insertAuthorizedIntentOutbox } from './outbox';

export type { RenderedOutboxMessage, CategoryRenderer };

// ── Category renderer registry ──
//
// Module-scope mutable state deliberately limited to this map: each
// owning lane (job-alert, job-messaging, account, ...) registers exactly
// one renderer per category it produces. `_clearCategoryRenderersForTests`
// mirrors the `_clear...ForTests()` convention in twilio-secret.ts so tests
// never leak registrations across suites.
const renderers = new Map<WorkerMessageIntentInput['category'], CategoryRenderer>();

/** Registers the renderer a category's owning lane uses to build outbound copy. */
export function registerCategoryRenderer(
  category: WorkerMessageIntentInput['category'],
  renderer: CategoryRenderer,
): void {
  renderers.set(category, renderer);
}

/** Test-only: clears all registered renderers between suites. */
export function _clearCategoryRenderersForTests(): void {
  renderers.clear();
}

const STATUS_BY_DECISION_ACTION: Record<DeliveryDecision['action'], IntentStatus> = {
  allow: 'eligible',
  defer: 'deferred',
  reject: 'rejected',
  expire: 'expired',
};

/**
 * Idempotently claims a `worker_message_intents` row for `input.dedupeKey`,
 * evaluates the delivery-policy decision against the worker's *locked*
 * onboarding gate (never a caller-supplied lifecycle), and — only when the
 * decision is 'allow' — renders and authorizes at most one `whatsapp_outbox`
 * row via `insertAuthorizedIntentOutbox`.
 *
 * Idempotency on the allow path: the intent INSERT's `RETURNING outbox_id`
 * tells us whether a prior call already materialized delivery for this
 * dedupeKey. When `outbox_id` is already non-null, a repeat call (retry, or
 * a defer -> allow -> allow re-evaluation) skips the renderer and the
 * outbox insert entirely — it never produces a second outbox row for the
 * same intent, which would otherwise be a duplicate WhatsApp send.
 *
 * Ownership/errors: caller owns the transaction; no BEGIN/COMMIT here.
 * Never calls Twilio, `fetch`, or `sendPendingOutbox` — outbox rows this
 * function writes are drained by the existing sweepers/dispatchers.
 *
 * A worker with no onboarding-state row yet (gate === null) is treated as
 * lifecycle 'onboarding' — not-ready-to-receive, consistent with
 * evaluateDelivery's onboarding/security categories being owner-checked
 * independent of lifecycle.
 */
export async function enqueueWorkerMessage(
  client: PoolClient,
  input: WorkerMessageIntentInput,
  now: Date = new Date(),
): Promise<{ intentId: string; decision: DeliveryDecision }> {
  const inserted = await client.query<{ id: string; outbox_id: string | null }>(
    `INSERT INTO worker_message_intents
        (user_id, category, owner_service, source_type, source_id, dedupe_key,
         priority, status, policy_version, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'deferred', $8, $9::jsonb, $10)
     ON CONFLICT ON CONSTRAINT worker_message_intent_dedupe
       DO UPDATE SET updated_at = now()
     RETURNING id, outbox_id`,
    [
      input.workerId,
      input.category,
      input.ownerService,
      input.sourceType,
      input.sourceId,
      input.dedupeKey,
      input.priority,
      DELIVERY_POLICY_VERSION,
      JSON.stringify(input.payload),
      input.expiresAt,
    ],
  );
  const intentId = inserted.rows[0].id;
  const alreadyMaterialized = inserted.rows[0].outbox_id !== null;

  const gate = await loadWorkerGate(client, input.workerId);
  const controls = await loadRuntimeControls(client);

  const decision = evaluateDelivery(
    {
      lifecycle: gate?.lifecycle ?? 'onboarding',
      category: input.category,
      ownerService: input.ownerService,
      controls,
      expiresAt: input.expiresAt,
    },
    now,
  );

  const status = STATUS_BY_DECISION_ACTION[decision.action];
  await client.query(
    `UPDATE worker_message_intents
        SET status = $1, decision_reason = $2, updated_at = now()
      WHERE id = $3`,
    [status, decision.reason, intentId],
  );

  if (decision.action === 'allow' && !alreadyMaterialized) {
    const renderer = renderers.get(input.category);
    const rendered = renderer ? await renderer(client, input) : null;

    if (!rendered) {
      await client.query(
        `UPDATE worker_message_intents
            SET decision_reason = $1, updated_at = now()
          WHERE id = $2`,
        ['renderer_unavailable', intentId],
      );
    } else {
      const { outboxId } = await insertAuthorizedIntentOutbox(client, intentId, rendered);
      await client.query(
        `UPDATE worker_message_intents SET outbox_id = $1 WHERE id = $2`,
        [outboxId, intentId],
      );
    }
  }

  return { intentId, decision };
}
