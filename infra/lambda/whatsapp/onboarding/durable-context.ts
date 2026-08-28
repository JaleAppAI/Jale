/**
 * WhatsApp v2 onboarding — the DURABLE half of `session.state_context`.
 *
 * Sprint 22 R2-C23 (web door). The v2 router keeps a scratch bag on
 * `session.state_context`: the three bilingual trust questions, their
 * provenance versions, the resolved trade, the pending location confirm and
 * the IDIOMA language override. On WhatsApp that bag survives between turns
 * because the processor writes it back to `whatsapp_conversations.
 * state_context` after every message.
 *
 * A WEB worker has no `whatsapp_conversations` row at all. Each HTTP request
 * is its own transaction with a freshly-invented session, so without this
 * module the bag is born empty every time and:
 *   - `buildTrustQuestionBody` renders the FALLBACK questions instead of the
 *     ones `seedTrustQuestions` actually generated at `profile.trade`, and
 *   - `recordTrustAnswer` stores those fallback strings as `q_en`/`q_es` on
 *     `worker_trust_assessments.answers`, permanently mislabelling what the
 *     worker was asked (the scorer reads `{ q_en, answer_text }`).
 *
 * The fix belongs in the ENGINE, not in the web driver, because it is also
 * what makes the two doors ONE state machine: a worker who picks their trade
 * on the web and then answers on WhatsApp (or the reverse) must see the same
 * three questions. `worker_workflow_runs.context` is the shared home —
 * `jale_whatsapp` already holds `SELECT (context)` and `UPDATE (context)` on
 * that table (042:263-266), so this needs no migration.
 *
 * WHAT IS NOT PERSISTED, and why:
 *   - `v2LastPromptAt:*` — per-channel reprompt cooldown bookkeeping. A web
 *     form has no reprompt cooldown, and copying WhatsApp's timestamps into a
 *     shared home would suppress a legitimate WhatsApp reprompt.
 *   - `v2VoiceExecutionArn` / `v2TrustVoiceExecutionArn` / `v2VoiceStartedAt`
 *     — Step Functions staleness anchors for the voice lanes. They are
 *     deliberately channel-local: BACK/RESTART delete them precisely so a
 *     late transcript cannot look current again, and a durable copy would
 *     resurrect exactly the staleness this design prevents.
 *
 * DELETION SEMANTICS. `advanceWorkflow` merges with `context || patch`, which
 * cannot remove a key — but RESTART *deletes* keys from `state_context` so a
 * re-run re-seeds them. `durableContextPatch` therefore always writes ALL the
 * durable keys, using an explicit JSON `null` for any the session no longer
 * holds, and `hydrateStateContextFromRunContext` treats `null` as absent.
 * Every consumer of these keys tests truthiness (`if (pending)`,
 * `?? fallback`), so null and absent are already indistinguishable to them.
 */

import type { PoolClient } from 'pg';
import type { OnboardingV2Session } from './types';

/**
 * The `state_context` keys that belong to the run, not to the channel.
 *
 * `v2PreferredLanguageOverride` is here for the same reason as the rest: the
 * gate's IDIOMA branch writes it as the durable half of a language change
 * (the other half is `setRunPreferredLanguage`), and a web `PATCH /worker/
 * onboarding/language` has no conversation row to keep it in.
 */
export const V2_DURABLE_CONTEXT_KEYS = [
  'v2TrustQuestions',
  'v2TrustSource',
  'v2QuestionSetVersion',
  'v2RubricVersion',
  'v2ProfileTrade',
  'v2CustomTradeText',
  'v2LocationPendingConfirm',
  'v2PreferredLanguageOverride',
] as const;

export type V2DurableContextKey = (typeof V2_DURABLE_CONTEXT_KEYS)[number];

/**
 * The full-width patch for `worker_workflow_runs.context`: every durable key,
 * with `null` standing in for "the session dropped this one" (see the header
 * on deletion semantics).
 */
export function durableContextPatch(
  stateContext: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of V2_DURABLE_CONTEXT_KEYS) {
    const value = stateContext[key];
    patch[key] = value === undefined ? null : value;
  }
  return patch;
}

/**
 * Copies durable keys the session does not already hold out of the run's
 * persisted context. Returns the keys actually hydrated (for logging).
 *
 * Never overwrites a value the session already carries: on WhatsApp the
 * conversation's own `state_context` is authoritative and complete, so this
 * is a no-op there and behaviour is unchanged.
 */
export function hydrateStateContextFromRunContext(
  stateContext: Record<string, unknown>,
  runContext: Record<string, unknown> | null | undefined,
): V2DurableContextKey[] {
  if (!runContext || typeof runContext !== 'object') return [];
  const hydrated: V2DurableContextKey[] = [];
  for (const key of V2_DURABLE_CONTEXT_KEYS) {
    const current = stateContext[key];
    if (current !== undefined && current !== null) continue;
    const stored = (runContext as Record<string, unknown>)[key];
    if (stored === undefined || stored === null) continue;
    stateContext[key] = stored;
    hydrated.push(key);
  }
  return hydrated;
}

/** Reads `worker_workflow_runs.context`. Column-scoped SELECT only — a
 * `SELECT *` here is a hard 42501 for `jale_whatsapp`. */
export async function loadRunContext(
  client: PoolClient,
  runId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ context: Record<string, unknown> | null }>(
    `SELECT context FROM worker_workflow_runs WHERE id = $1`,
    [runId],
  );
  const context = result.rows[0]?.context;
  return context && typeof context === 'object' ? context : {};
}

/**
 * Writes the durable bag back to the run. Deliberately does NOT bump
 * `lock_version`: this is bookkeeping about what the run already decided, not
 * a state transition, and the web door hands `lock_version` to the browser as
 * an optimistic-concurrency token that must only move when the run does.
 */
export async function persistDurableStateContext(
  client: PoolClient,
  runId: string,
  stateContext: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE worker_workflow_runs
        SET context = context || $2::jsonb
      WHERE id = $1`,
    [runId, JSON.stringify(durableContextPatch(stateContext))],
  );
}

/**
 * Hydrate-before-dispatch. Called by `routeBoundStep` for both doors: on
 * WhatsApp the session already holds everything and this only costs one
 * indexed primary-key SELECT; on the web it is what makes the run resumable.
 */
export async function hydrateSessionFromRun(
  client: PoolClient,
  session: OnboardingV2Session,
  runId: string,
): Promise<void> {
  session.state_context ??= {};
  const runContext = await loadRunContext(client, runId);
  const hydrated = hydrateStateContextFromRunContext(session.state_context, runContext);
  if (hydrated.length > 0) {
    console.log(JSON.stringify({
      metric: 'OnboardingRunContextHydrated',
      runId,
      keys: hydrated,
    }));
  }
}
