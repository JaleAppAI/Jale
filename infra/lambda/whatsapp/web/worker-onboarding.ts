/**
 * `/worker/onboarding*` — the web door's HTTP surface (Sprint 22 R2-C23).
 *
 *   GET    /worker/onboarding            -> the whole OnboardingState
 *   POST   /worker/onboarding/answers    -> apply a batch of step answers
 *   POST   /worker/onboarding/back       -> step the run back one
 *   PATCH  /worker/onboarding/language   -> persist en/es
 *
 * ONE Lambda, four routes. They share a connection, a transaction shape, a
 * deps graph and an error vocabulary; four functions would have been four
 * copies of the same forty lines.
 *
 * WHY THIS LIVES UNDER `lambda/whatsapp/` AND CONNECTS AS `jale_whatsapp`.
 * The engine's every write — `worker_workflow_runs`, `worker_workflow_
 * transitions`, `worker_trust_assessments`, `legal_consent_log`,
 * `worker_preferred_cities`, `worker_onboarding_state` — is granted to
 * `jale_whatsapp` and to no other API role, column by column, across
 * migrations 042/049/066/084/086. Reaching the same state machine as
 * `jale_admin` would have meant a second, parallel privilege story for the
 * same tables. Migration 086 chose the opposite: it gave `jale_whatsapp` two
 * SECURITY DEFINER entry points (`resolve_worker_internal_id`,
 * `start_web_onboarding_workflow`) so the WEB can knock on the door the
 * WhatsApp processor already owns. This handler is that knock.
 *
 * NO LEGAL WALL. `checkCompliance` guards every other `/worker/*` route, and
 * must not guard these: accepting the terms IS step one of this flow. A
 * worker who has not accepted them yet is precisely who this endpoint is for.
 * Authentication is unaffected — the Cognito worker authorizer still gates
 * the route, and `resolve_worker_internal_id` will only ever resolve the sub
 * in the caller's own verified token.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { PoolClient } from 'pg';

import { getDbPool, setInternalUserRlsContext } from '../../lib/db';
import { corsHeaders, errorMessage } from '../../lib/http';
import { loadWorkerGate, type WorkerGate } from '../lib/onboarding-repository';
import { publishOutboxWakes } from '../lib/outbox-wake';
import { WHATSAPP_V2_WORKFLOW_VERSION } from '../onboarding/constants';
import type { PreferredLanguage } from '../lib/onboarding-types';
import {
  MAX_ANSWERS_PER_BATCH,
  applyAnswerBatch,
  applyBack,
  createWebOnboardingDeps,
  createWebSession,
  isLockConflict,
  setPreferredLanguage,
  type WebAnswerItem,
} from './onboarding-driver';
import { buildOnboardingState, type OnboardingStateDto } from './onboarding-state';

const CORS_HEADERS = corsHeaders();

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function fail(statusCode: number, error: string, extra: Record<string, unknown> = {}): APIGatewayProxyResult {
  return json(statusCode, { error, ...extra });
}

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  if (!event.body) return {};
  try {
    const parsed = JSON.parse(event.body);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The path suffix under `/worker/onboarding`, e.g. `answers`. */
function routeSuffix(event: APIGatewayProxyEvent): string {
  const resource = event.resource || event.path || '';
  const match = /\/worker\/onboarding(?:\/([a-z-]+))?\/?$/.exec(resource);
  return match?.[1] ?? '';
}

/**
 * `start_web_onboarding_workflow` refuses two states with SQLSTATE 55000: a
 * `suspended` worker (an operator decision the web door must not quietly
 * re-open around) and a `ready` worker whose completed run is missing (a data
 * anomaly that must reach a human, not be papered over with a fresh run).
 * They are distinguished by message because a single SQLSTATE carries both.
 */
function classifyStartFailure(err: unknown): { status: number; error: string } | null {
  const code = (err as { code?: string })?.code;
  if (code === '23503') return { status: 404, error: 'worker_not_found' };
  if (code === '22023') return { status: 400, error: 'invalid_request' };
  if (code !== '55000') return null;
  const message = (err as { message?: string })?.message ?? '';
  return /suspended/i.test(message)
    ? { status: 409, error: 'suspended' }
    : { status: 409, error: 'not_onboardable' };
}

interface StartedRun {
  run_id: string;
  current_step_key: string;
  preferred_language: PreferredLanguage;
  lifecycle: string;
  created: boolean;
}

/**
 * The door's entry sequence, in the order 086 requires:
 *   `resolve_worker_internal_id(sub)` → NULL means "no such worker" and
 *   "an employer" alike (indistinguishable by design) → 404; then the RLS
 *   context, because every policy the engine relies on keys on
 *   `app.current_internal_user_id` and `start_web_onboarding_workflow`
 *   returns no user id of its own.
 */
async function resolveWorker(client: PoolClient, cognitoSub: string): Promise<string | null> {
  const result = await client.query<{ id: string | null }>(
    `SELECT public.resolve_worker_internal_id($1) AS id`,
    [cognitoSub],
  );
  return result.rows[0]?.id ?? null;
}

async function loadPhone(client: PoolClient, workerId: string): Promise<string | null> {
  const result = await client.query<{ phone: string | null }>(
    `SELECT phone FROM users WHERE id = $1`,
    [workerId],
  );
  return result.rows[0]?.phone ?? null;
}

/**
 * Loads the gate, starting a run if the worker has none. `start_web_
 * onboarding_workflow` is idempotent and adopts a live run rather than
 * minting a second one, so calling it whenever the gate has no usable run is
 * safe on every path, including a WhatsApp bind that landed in the gap.
 */
async function ensureGate(
  client: PoolClient,
  input: { workerId: string; cognitoSub: string; language: PreferredLanguage },
): Promise<WorkerGate> {
  const existing = await loadWorkerGate(client, input.workerId);
  if (existing?.runId && existing.currentStepKey) return existing;

  const started = await client.query<StartedRun>(
    `SELECT run_id, current_step_key, preferred_language, lifecycle, created
       FROM start_web_onboarding_workflow($1, $2, $3)`,
    [input.cognitoSub, input.language, WHATSAPP_V2_WORKFLOW_VERSION],
  );
  if (started.rows[0]?.created) {
    console.log(JSON.stringify({
      metric: 'WebOnboardingRunStarted',
      runId: started.rows[0].run_id,
      language: input.language,
    }));
  }

  const gate = await loadWorkerGate(client, input.workerId);
  if (!gate?.runId) throw new Error('worker_gate_missing_after_web_start');
  return gate;
}

function requestedLanguage(body: Record<string, unknown> | null): PreferredLanguage | null {
  const value = body?.preferredLanguage;
  return value === 'en' || value === 'es' ? value : null;
}

function parseAnswers(body: Record<string, unknown>): WebAnswerItem[] | null {
  const raw = body.answers;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANSWERS_PER_BATCH) return null;
  const items: WebAnswerItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const stepKey = (entry as Record<string, unknown>).stepKey;
    if (typeof stepKey !== 'string') return null;
    items.push({ stepKey, value: (entry as Record<string, unknown>).value });
  }
  return items;
}

/** `lockVersion` is required on every mutation: it is the browser's half of
 * the cross-door optimistic lock, and treating an absent one as "whatever the
 * run says" would silently disable it. */
function parseLockVersion(body: Record<string, unknown>): number | null {
  const value = body.lockVersion;
  return Number.isInteger(value) ? (value as number) : null;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const cognitoSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
  if (!cognitoSub) return fail(401, 'unauthorized');

  const method = (event.httpMethod || 'GET').toUpperCase();
  const suffix = routeSuffix(event);
  const body = parseBody(event);
  if (body === null) return fail(400, 'invalid_request');

  let client: PoolClient | undefined;
  let committed = false;
  // Poked AFTER the commit, never inside it: the drain must not read a row
  // the transaction has not made visible yet.
  let wakeDomainOutbox = false;
  // `v2TrustSource === 'fallback'` means the question generator was
  // unreachable and the worker is being asked three generic questions. It is
  // invisible in the flow and only shows up as un-scorable assessments weeks
  // later, so it is worth one operator-facing log line per web run.
  let fallbackSeeded = false;

  try {
    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');

    const workerId = await resolveWorker(client, cognitoSub);
    if (!workerId) {
      await client.query('COMMIT');
      committed = true;
      return fail(404, 'worker_not_found');
    }
    await setInternalUserRlsContext(client, workerId);

    // The requested language only ever seeds a NEW run; a live run's own
    // preference wins (`start_web_onboarding_workflow` ignores the argument
    // when it adopts an existing run), and changing it is the PATCH's job.
    const language = requestedLanguage(body) ?? 'en';
    let gate: WorkerGate;
    try {
      gate = await ensureGate(client, { workerId, cognitoSub, language });
    } catch (err) {
      const classified = classifyStartFailure(err);
      if (!classified) throw err;
      // The definer raised before writing anything; the transaction is
      // aborted, so roll back rather than commit.
      await client.query('ROLLBACK');
      committed = true;
      const lifecycle = classified.error === 'suspended' ? 'suspended' : undefined;
      return fail(classified.status, classified.error, lifecycle ? { lifecycle } : {});
    }

    // `start_web_onboarding_workflow` refuses to start a run for a suspended
    // worker, but a worker suspended AFTER their run began still has one, so
    // the definer is never consulted and the check has to be repeated here.
    // Suspension is an operator decision; no door may work around it.
    if (gate.lifecycle === 'suspended') {
      await client.query('COMMIT');
      committed = true;
      return fail(409, 'suspended', { lifecycle: 'suspended' });
    }

    const now = new Date();
    const phone = await loadPhone(client, workerId);
    const session = createWebSession({ workerId, phone, language: gate.preferredLanguage });
    const deps = createWebOnboardingDeps({
      clock: { now: () => now },
      requiredLegalVersion: process.env.REQUIRED_TOS_VERSION ?? '1.0',
      tosUrl: process.env.TOS_URL ?? 'https://jaleapp.ai/legal/terms',
      privacyUrl: process.env.PRIVACY_URL ?? 'https://jaleapp.ai/legal/privacy',
      workflowVersion: WHATSAPP_V2_WORKFLOW_VERSION,
    });

    let result: APIGatewayProxyResult | null = null;

    if (method === 'GET' && suffix === '') {
      // Nothing to do: `ensureGate` already did the only mutation a GET
      // performs (starting the run, which is what makes the first page load
      // idempotent).
      result = null;
    } else if (method === 'POST' && suffix === 'answers') {
      const answers = parseAnswers(body);
      const lockVersion = parseLockVersion(body);
      if (!answers || lockVersion === null) {
        await client.query('ROLLBACK');
        committed = true;
        return fail(400, 'invalid_request');
      }
      if (lockVersion !== gate.lockVersion) {
        result = await conflict(client, workerId, gate);
      } else {
        // Scoped to the request that actually SEEDS the questions
        // (`profile.trade` / `profile.custom_trade`). The bag is hydrated on
        // every later request too, so an unscoped read would re-log the same
        // fallback on every remaining step of the run.
        const seedsQuestions = answers.some(
          (a) => a.stepKey === 'profile.trade' || a.stepKey === 'profile.custom_trade',
        );
        const outcome = await applyAnswerBatch(client, deps, { workerId, session, gate, answers, now });
        wakeDomainOutbox = outcome.completed;
        fallbackSeeded = seedsQuestions && session.state_context.v2TrustSource === 'fallback';
        if (outcome.rejection) {
          const fresh = await freshGate(client, workerId);
          const state = await buildOnboardingState(client, { workerId, gate: fresh });
          // COMMIT, not rollback — see `applyAnswerBatch` on why partial
          // progress is kept.
          await client.query('COMMIT');
          committed = true;
          return json(422, {
            error: outcome.rejection.code,
            rejectedStepKey: outcome.rejection.stepKey,
            reason: outcome.rejection.reason,
            state,
          });
        }
      }
    } else if (method === 'POST' && suffix === 'back') {
      const lockVersion = parseLockVersion(body);
      if (lockVersion === null) {
        await client.query('ROLLBACK');
        committed = true;
        return fail(400, 'invalid_request');
      }
      if (lockVersion !== gate.lockVersion) {
        result = await conflict(client, workerId, gate);
      } else {
        const back = await applyBack(client, deps, { gate, now });
        if (!back.moved) {
          const state = await buildOnboardingState(client, { workerId, gate });
          await client.query('COMMIT');
          committed = true;
          return json(422, { error: 'nothing_to_go_back_to', reason: back.reason, state });
        }
      }
    } else if (method === 'PATCH' && suffix === 'language') {
      const preferredLanguage = requestedLanguage(body);
      const lockVersion = parseLockVersion(body);
      if (!preferredLanguage) {
        await client.query('ROLLBACK');
        committed = true;
        return fail(400, 'invalid_request');
      }
      // The language toggle lives in the page header, where the browser may
      // legitimately not have a fresh lock version in hand. It is honoured
      // when supplied and not demanded when it is not — this is the one
      // mutation that cannot advance the run's STEP, so a lost update here
      // costs a language preference, not an answer.
      if (lockVersion !== null && lockVersion !== gate.lockVersion) {
        result = await conflict(client, workerId, gate);
      } else {
        await setPreferredLanguage(client, deps, { gate, session, preferredLanguage });
      }
    } else {
      await client.query('ROLLBACK');
      committed = true;
      return fail(404, 'not_found');
    }

    if (result) {
      await client.query('COMMIT');
      committed = true;
      return result;
    }

    const finalGate = await freshGate(client, workerId);
    const state = await buildOnboardingState(client, { workerId, gate: finalGate });
    await client.query('COMMIT');
    committed = true;

    if (fallbackSeeded) {
      console.warn(JSON.stringify({
        metric: 'WebOnboardingFallbackQuestionsSeeded',
        runId: finalGate.runId,
        count: 1,
      }));
    }
    if (wakeDomainOutbox) {
      // Post-commit, best-effort, exactly as the processor does it: without
      // it the worker's scoring and skill extraction wait for the cron.
      await publishOutboxWakes({ workerIntent: false, domain: true });
    }
    return json(200, state);
  } catch (err) {
    if (client && !committed) await client.query('ROLLBACK').catch(() => undefined);
    if (isLockConflict(err)) {
      // The engine's own optimistic lock lost the race INSIDE the
      // transaction: the other door advanced the run between our read and our
      // write. A zero-row UPDATE is a SQL success, so the transaction was
      // never poisoned — but it has been rolled back above, so a retry starts
      // from a fresh read.
      //
      // `workflow_lock_conflict` is also what `advanceWorkflow` raises when
      // the row is INVISIBLE rather than stale — an UPDATE that matches no
      // row under RLS is indistinguishable, at the SQL level, from one whose
      // `lock_version` moved (R2-C0 group 7b pins this). That conflation is
      // safe here precisely because it is a conflation: a caller who cannot
      // see the run learns only "try again", never whether the run exists or
      // whose it is. It does mean a genuine cross-tenant bug would present as
      // a client that 409s forever, so `WebOnboardingRequestFailed` is not
      // the signal to watch for one — a run stuck at the same step is.
      return fail(409, 'lock_conflict');
    }
    console.error(JSON.stringify({
      metric: 'WebOnboardingRequestFailed',
      method,
      suffix,
      error: errorMessage(err),
    }));
    return fail(500, 'internal_error');
  } finally {
    client?.release();
  }
};

async function freshGate(client: PoolClient, workerId: string): Promise<WorkerGate> {
  const gate = await loadWorkerGate(client, workerId);
  if (!gate?.runId) throw new Error('worker_gate_missing_after_web_request');
  return gate;
}

/** 409 with the run as it actually stands, so the browser's retry costs no
 * extra round trip. */
async function conflict(
  client: PoolClient,
  workerId: string,
  gate: WorkerGate,
): Promise<APIGatewayProxyResult> {
  const state: OnboardingStateDto = await buildOnboardingState(client, { workerId, gate });
  return json(409, { error: 'lock_conflict', state });
}
