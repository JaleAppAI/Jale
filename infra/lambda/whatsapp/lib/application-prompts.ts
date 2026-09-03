/**
 * application-prompts.ts -- the STAGE 1 prompt lane (sprint 23).
 *
 * One-tap Accept applies immediately (`applyWorkerToJob`, stage 1 only). If
 * the job carries employer-authored `pre_application_prompts`, the chat asks
 * them one at a time right here, immediately after the accept, and then
 * confirms with the revised `job_accepted` copy. Nothing else is collected:
 * `required_fields` / `certification_requirements` / `required_docs` belong
 * to stage 2 (`application-fill.ts`), which is armed only after the employer
 * asks for details.
 *
 * ── RELATIONSHIP TO THE FILL LANE (binding) ──────────────────────
 * The two lanes are MUTUALLY EXCLUSIVE. Arming either one scrubs the other's
 * `state_context` keys (`PROMPT_ARM_SCRUB` here, `FILL_SCRUB` in
 * application-fill.ts) plus the one-shot `applications_menu`, so a worker can
 * never be half-way through prompts and half-way through a document upload at
 * the same time. The processor gates them side by side, prompt lane first.
 *
 * ── STATE ────────────────────────────────────────────────────────
 *   prompt_application_id   the application whose prompts are in flight
 *   prompt_last_prompt_at   cooldown stamp, shared shape with the fill lane's
 *                           `fill_last_prompt_at` (REPROMPT_COOLDOWN_MS)
 *
 * There is deliberately no per-prompt cursor in state: the outstanding
 * prompt is re-derived from the DB (`nextStep`) on every turn, so an
 * employer editing the job's prompts mid-flow is reflected immediately and a
 * duplicate SQS delivery can never double-write (`mergePromptAnswers` is
 * write-once per id in SQL: `$1::jsonb || prompt_answers`).
 *
 * ── CANCELAR KEEPS THE APPLICATION ───────────────────────────────
 * Locked product decision: `cancelar` mid-prompts clears the lane and keeps
 * the application WITH its partial answers. Nothing is deleted and nothing
 * is rolled back -- `mergePromptAnswers` accepts partial sets precisely so
 * the worker can top the rest up later from `aplicaciones` or the web door.
 *
 * INVARIANT: like the fill lane, everything here runs INSIDE the processor's
 * per-turn transaction. This module never issues BEGIN/COMMIT/ROLLBACK.
 */
import type { PoolClient } from 'pg';
import {
  loadRequirementSnapshot,
  mergePromptAnswers,
  nextStep,
  type RequirementSnapshot,
  type RequirementStep,
} from '../../lib/application-requirements';
import { MAX_PROMPT_ANSWER_LENGTH } from '../../lib/pre-application-prompts';
import { fillMessage } from './application-fill-prompts';
import { isFillCancel, matchesFillEscape } from './application-fill';
import type { IncomingMessage } from './conversation-router';
import { t, type Lang } from './templates';
import { REPROMPT_COOLDOWN_MS } from './onboarding-language';

export interface PromptDeps {
  queueReplyText(client: PoolClient, inboundSid: string, to: string, body: string): Promise<void>;
  /** Same binding contract as `FillDeps.updateStateContext`: persist the
   * spread-merged patch AND mutate `ctx.stateContext` in place. */
  updateStateContext(client: PoolClient, conversationId: string, patch: Record<string, unknown>): Promise<void>;
  nowMs(): number;
}

export interface PromptContext {
  conversationId: string;
  workerId: string;
  lang: Lang;
  stateContext: Record<string, unknown>;
}

/** `false` => the processor continues its normal (non-prompt) routing. */
export type PromptResult = { handled: true } | { handled: false };

/** Cleared when the prompt lane ends, for any reason. */
const PROMPT_LANE_SCRUB = {
  prompt_application_id: null,
  prompt_last_prompt_at: null,
  applications_menu: null,
} as const;

/** Cleared when the prompt lane is ARMED -- the fill lane's whole key set,
 * mirroring `FILL_SCRUB`'s treatment of the prompt keys. */
const PROMPT_ARM_SCRUB = {
  fill_application_id: null,
  fill_pending: null,
  fill_cert_more_pending: null,
  fill_relay_override: null,
  fill_offer_application_id: null,
  applications_menu: null,
} as const;

/** Metadata-only log line: prompt ids and reason codes, never answer text. */
function logPrompt(promptId: string, outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: 'ApplicationPromptStep', key: promptId, outcome, reason }));
}

/** "Pregunta {i} de {n}: {text}" -- the position is derived from the job's
 * own prompt order, never from a cursor in state_context. */
function askBody(lang: Lang, snapshot: RequirementSnapshot, promptId: string, text: string): string {
  const index = snapshot.prompts.findIndex((prompt) => prompt.id === promptId);
  return fillMessage('prompt_ask', lang, {
    i: String(index >= 0 ? index + 1 : 1),
    n: String(snapshot.prompts.length),
    text,
  });
}

const EXIT_COPY = {
  job_inactive: 'exit_job_inactive',
  application_gone: 'exit_application_gone',
  application_closed: 'exit_application_closed',
} as const;

/** The confirmation key the lane ends on. `job_already_applied` is used for
 * exactly one case: the accept path re-tapped on a job whose prompts are
 * already fully answered, where "Application sent" would be a lie. Every
 * other completion (including the last answer of a real prompt run) is
 * `job_accepted`. */
export type PromptCompleteKey = 'job_accepted' | 'job_already_applied';

/** Stage 1 is finished: clear the lane and send the revised confirmation. */
async function finishPromptLane(
  client: PoolClient,
  ctx: PromptContext,
  inboundSid: string,
  from: string,
  deps: PromptDeps,
  completeKey: PromptCompleteKey,
): Promise<void> {
  await deps.updateStateContext(client, ctx.conversationId, { ...PROMPT_LANE_SCRUB });
  await deps.queueReplyText(client, inboundSid, from, t(completeKey, ctx.lang));
  logPrompt('complete', 'prompted');
}

async function exitPromptLane(
  client: PoolClient,
  ctx: PromptContext,
  inboundSid: string,
  from: string,
  deps: PromptDeps,
  reason: keyof typeof EXIT_COPY,
): Promise<void> {
  await deps.updateStateContext(client, ctx.conversationId, { ...PROMPT_LANE_SCRUB });
  await deps.queueReplyText(client, inboundSid, from, fillMessage(EXIT_COPY[reason], ctx.lang));
  logPrompt(reason, 'exited');
}

/**
 * Sends whatever `nextStep` says is outstanding for the prompt lane and
 * keeps/clears the lane accordingly. `arm` is true only on the very first
 * call (right after Accept), which is the one time the lane key is written
 * even though it may immediately be cleared again by the complete arm.
 */
async function advance(
  client: PoolClient,
  ctx: PromptContext,
  applicationId: string,
  inboundSid: string,
  from: string,
  deps: PromptDeps,
  extra: Record<string, unknown> = {},
  completeKey: PromptCompleteKey = 'job_accepted',
): Promise<void> {
  const snapshot = await loadRequirementSnapshot(client, applicationId);
  const step: RequirementStep = nextStep(snapshot);

  if (step.kind === 'exit') {
    await exitPromptLane(client, ctx, inboundSid, from, deps, step.reason);
    return;
  }
  if (step.kind !== 'prompt') {
    // 'complete' (either stage) or a stage-2 step: stage 1 is done either
    // way -- the stage-2 collector is NEVER armed from here.
    await finishPromptLane(client, ctx, inboundSid, from, deps, completeKey);
    return;
  }

  await deps.updateStateContext(client, ctx.conversationId, {
    ...extra,
    prompt_application_id: applicationId,
    prompt_last_prompt_at: deps.nowMs(),
  });
  await deps.queueReplyText(
    client,
    inboundSid,
    from,
    askBody(ctx.lang, snapshot!, step.promptId, step.text),
  );
  logPrompt(step.promptId, 'prompted');
}

/**
 * Called from the accept path once the application row exists. Asks the
 * FIRST outstanding prompt, or -- when the job has none, or they are already
 * answered from a previous apply -- sends the revised `job_accepted` and
 * arms nothing.
 */
export async function armPromptLane(
  client: PoolClient,
  ctx: PromptContext,
  applicationId: string,
  inboundSid: string,
  from: string,
  deps: PromptDeps,
  options: { completeKey?: PromptCompleteKey } = {},
): Promise<void> {
  await advance(
    client, ctx, applicationId, inboundSid, from, deps,
    { ...PROMPT_ARM_SCRUB },
    options.completeKey ?? 'job_accepted',
  );
}

/**
 * Dispatch-tail re-prompt, mirroring the fill lane's `maybeRepromptFill`: an
 * escape (help/chats/jobs/...) queued its own unrelated reply this turn, so
 * the worker's outstanding question would otherwise go unanswered.
 * Cooldown-guarded by the same `prompt_last_prompt_at`/`REPROMPT_COOLDOWN_MS`
 * pair `advance` stamps.
 */
export async function repromptPromptLane(
  client: PoolClient,
  ctx: PromptContext,
  inboundSid: string,
  from: string,
  deps: PromptDeps,
): Promise<void> {
  const applicationId = ctx.stateContext.prompt_application_id;
  if (typeof applicationId !== 'string') return;
  const last = ctx.stateContext.prompt_last_prompt_at;
  if (typeof last === 'number' && deps.nowMs() - last < REPROMPT_COOLDOWN_MS) return;
  await advance(client, ctx, applicationId, inboundSid, from, deps);
}

/**
 * One inbound turn while the prompt lane is armed. Escape order mirrors the
 * fill lane's (application-fill.ts's `handleFillMessage`) so a worker's
 * muscle memory works identically in both:
 *   1. no lane armed                       -> not ours
 *   2. button/interactive payload          -> not ours (self-identifying)
 *   3. media                               -> `prompt_text_only`, lane KEPT
 *   4. `cancelar`                          -> lane cleared, application KEPT
 *   5. a picker digit while `pending_picker` -> not ours
 *   6. command escapes / exact jobs / typed job action -> not ours
 *   7. an over-long answer                 -> `prompt_too_long`, lane KEPT
 *   8. otherwise: merge the answer, then ask the next prompt or confirm.
 */
export async function handlePromptMessage(
  client: PoolClient,
  ctx: PromptContext,
  msg: IncomingMessage,
  deps: PromptDeps,
): Promise<PromptResult> {
  const applicationId = ctx.stateContext.prompt_application_id;
  if (typeof applicationId !== 'string') return { handled: false };

  if (msg.buttonPayload || msg.interactivePayload) return { handled: false };

  if (msg.numMedia > 0) {
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('prompt_text_only', ctx.lang));
    logPrompt('media', 'text_only');
    return { handled: true };
  }

  const body = msg.body ?? '';

  if (isFillCancel(body)) {
    // The application STAYS, with whatever partial answers it already has.
    await deps.updateStateContext(client, ctx.conversationId, { ...PROMPT_LANE_SCRUB });
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('prompt_canceled', ctx.lang));
    logPrompt('cancel', 'canceled');
    return { handled: true };
  }

  if (ctx.stateContext.pending_picker && /^\d{1,2}$/.test(body.trim())) {
    return { handled: false };
  }

  if (matchesFillEscape(body)) return { handled: false };

  const answer = body.trim();
  if (answer.length === 0) return { handled: false };
  if (answer.length > MAX_PROMPT_ANSWER_LENGTH) {
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('prompt_too_long', ctx.lang));
    logPrompt('answer', 'too_long');
    return { handled: true };
  }

  const snapshot = await loadRequirementSnapshot(client, applicationId);
  const step = nextStep(snapshot);
  if (step.kind === 'exit') {
    await exitPromptLane(client, ctx, msg.messageSid, msg.from, deps, step.reason);
    return { handled: true };
  }
  if (step.kind !== 'prompt') {
    await finishPromptLane(client, ctx, msg.messageSid, msg.from, deps, 'job_accepted');
    return { handled: true };
  }

  const merged = await mergePromptAnswers(client, {
    applicationId,
    workerId: ctx.workerId,
    answers: { [step.promptId]: answer },
  });
  if (!merged.ok) {
    if (merged.reason === 'not_found') {
      await exitPromptLane(client, ctx, msg.messageSid, msg.from, deps, 'application_gone');
      return { handled: true };
    }
    if (merged.reason === 'closed') {
      await exitPromptLane(client, ctx, msg.messageSid, msg.from, deps, 'application_closed');
      return { handled: true };
    }
    // 'invalid' (control characters, a prompt the job dropped mid-turn) and
    // 'too_large' (the POST-MERGE byte cap, which only the DB can see) both
    // mean "that text cannot be stored" -- same actionable advice.
    await deps.queueReplyText(client, msg.messageSid, msg.from, fillMessage('prompt_too_long', ctx.lang));
    logPrompt(step.promptId, 'merge_failed', merged.reason);
    return { handled: true };
  }
  logPrompt(step.promptId, 'merged');

  await advance(client, ctx, applicationId, msg.messageSid, msg.from, deps);
  return { handled: true };
}
