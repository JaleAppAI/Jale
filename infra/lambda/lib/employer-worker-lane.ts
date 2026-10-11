/**
 * employer-worker-lane.ts -- how the employer's request paths reach the
 * worker lane.
 *
 * The request login holds no rights on the worker lane's tables: onboarding
 * state, workflow runs, message intents, runtime controls, and the WhatsApp
 * conversations and outbox. Three capability functions in schema `jale_cap`
 * carry exactly what the employer paths need. Each one re-checks the caller
 * in SQL against `app.current_internal_user_id` -- the employer's users.id,
 * which the caller sets transaction-locally (setInternalUserRlsContext)
 * before calling -- and refuses anything outside the caller's own
 * applicants (SQLSTATE 42501):
 *
 *   - `employer_worker_delivery_context(worker)`: the worker's lifecycle and
 *     languages. Locks the worker's onboarding row for the rest of the
 *     transaction, as the gate read it replaces did.
 *   - `employer_stage_recipient(application)`: the worker behind an
 *     application on one of the caller's jobs, their language, and whether
 *     they have a usable WhatsApp number.
 *   - `employer_claim_worker_intent(worker, kind, source, payload, message)`:
 *     the intent claim, the gate, the runtime controls, the delivery
 *     decision and the outbox insert, in one call, bound to a source the
 *     caller owns. Idempotent per source: a repeat never inserts a second
 *     outbox row.
 *
 * The functions own every write to the worker lane; the TypeScript callers
 * keep the orchestration and render the copy. These helpers only shape the
 * calls and their results.
 */
import type { PoolClient } from 'pg';
import type { DeliveryDecision, PreferredLanguage, ReleaseRenderedMessage } from '../whatsapp/lib/onboarding-types';

export type WorkerLifecycle = 'onboarding' | 'ready' | 'suspended';

export interface WorkerDeliveryContext {
  /** NULL when the worker has no onboarding row yet: treat it as onboarding. */
  lifecycle: WorkerLifecycle | null;
  /** The gate's language (active run first); 'es' by default. */
  workflowLanguage: PreferredLanguage;
  /** The WhatsApp conversation's language; NULL when there is none. */
  whatsappLanguage: string | null;
}

function preferredLanguage(value: unknown): PreferredLanguage {
  return value === 'en' ? 'en' : 'es';
}

/** The worker's lifecycle and languages, for one of the caller's applicants. */
export async function loadWorkerDeliveryContext(
  client: PoolClient,
  workerId: string,
): Promise<WorkerDeliveryContext> {
  const result = await client.query<{
    lifecycle: WorkerLifecycle | null;
    workflow_language: string | null;
    whatsapp_language: string | null;
  }>(
    `SELECT lifecycle, workflow_language, whatsapp_language
       FROM jale_cap.employer_worker_delivery_context($1)`,
    [workerId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('worker_delivery_context_missing');
  return {
    lifecycle: row.lifecycle,
    workflowLanguage: preferredLanguage(row.workflow_language),
    whatsappLanguage: row.whatsapp_language,
  };
}

export interface StageRecipient {
  workerId: string;
  /** The latest workflow run's language; 'es' by default. */
  language: PreferredLanguage;
  hasWhatsappNumber: boolean;
}

/** The worker behind an application on one of the caller's jobs. */
export async function loadStageRecipient(
  client: PoolClient,
  applicationId: string,
): Promise<StageRecipient> {
  const result = await client.query<{
    worker_id: string;
    language: string | null;
    has_whatsapp_number: boolean;
  }>(
    `SELECT worker_id, language, has_whatsapp_number
       FROM jale_cap.employer_stage_recipient($1)`,
    [applicationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('stage_recipient_missing');
  return {
    workerId: row.worker_id,
    language: preferredLanguage(row.language),
    hasWhatsappNumber: row.has_whatsapp_number === true,
  };
}

export type WorkerIntentKind = 'employer_chat' | 'application_stage';

/** A pre-rendered message, in the shape the claim function stores. */
export type ClaimMessage =
  | { body: string }
  | { content_template: string; content_variables: Record<string, string> };

/**
 * Converts rendered copy into the claim's message. A template wins over a
 * body, as on every outbox row (a row carries one or the other, never both);
 * nothing renderable gives NULL.
 */
export function claimMessageFrom(
  rendered: Pick<ReleaseRenderedMessage, 'body' | 'contentTemplate' | 'contentVariables'> | null,
): ClaimMessage | null {
  if (!rendered) return null;
  if (rendered.contentTemplate) {
    return { content_template: rendered.contentTemplate, content_variables: rendered.contentVariables ?? {} };
  }
  if (rendered.body) return { body: rendered.body };
  return null;
}

/** The claim's answer when an allowed delivery had nothing to send. */
export type RendererUnavailable = { action: 'reject'; reason: 'renderer_unavailable' };

export interface WorkerIntentClaim {
  intentId: string;
  decision: DeliveryDecision | RendererUnavailable;
  outboxId: string | null;
  /** True only when this call inserted the outbox row. */
  outboxMaterialized: boolean;
}

const KNOWN_DECISIONS = new Set([
  'allow/workflow_message', 'allow/security_message', 'allow/worker_ready',
  'defer/worker_onboarding', 'defer/delivery_disabled',
  'reject/worker_suspended', 'reject/invalid_owner', 'reject/renderer_unavailable',
  'expire/intent_expired',
]);

export function isRendererUnavailable(decision: WorkerIntentClaim['decision']): decision is RendererUnavailable {
  return decision.action === 'reject' && decision.reason === 'renderer_unavailable';
}

/**
 * Claims the worker's intent for a source the caller owns: an employer's
 * job_conversation_messages row (`employer_chat`) or a job_applications row
 * (`application_stage`). The function derives the category, owner, priority,
 * expiry and dedupe key from the kind and the source, overwrites the
 * payload's identifying fields from the source, and uses `message` only when
 * the decision is allow and no outbox row exists yet. An allow with no
 * message comes back as reject/renderer_unavailable; it never raises for it.
 */
export async function claimWorkerIntent(
  client: PoolClient,
  input: {
    workerId: string;
    kind: WorkerIntentKind;
    sourceId: string;
    payload: Record<string, unknown>;
    message: ClaimMessage | null;
  },
): Promise<WorkerIntentClaim> {
  const result = await client.query<{
    intent_id: string;
    decision_action: string;
    decision_reason: string;
    outbox_id: string | null;
    outbox_materialized: boolean;
  }>(
    `SELECT intent_id, decision_action, decision_reason, outbox_id, outbox_materialized
       FROM jale_cap.employer_claim_worker_intent($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      input.workerId,
      input.kind,
      input.sourceId,
      JSON.stringify(input.payload),
      input.message === null ? null : JSON.stringify(input.message),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('worker_intent_claim_missing');
  const key = `${row.decision_action}/${row.decision_reason}`;
  if (!KNOWN_DECISIONS.has(key)) throw new Error(`worker_intent_unexpected_decision:${key}`);
  return {
    intentId: row.intent_id,
    decision: { action: row.decision_action, reason: row.decision_reason } as WorkerIntentClaim['decision'],
    outboxId: row.outbox_id,
    outboxMaterialized: row.outbox_materialized === true,
  };
}
