import type { PoolClient } from 'pg';
import type {
  PreferredLanguage,
  WorkerLifecycle,
  WorkflowRunStatus,
  WorkflowStepKey,
} from './onboarding-types';
import { claimPendingReferral } from './referral-claims';
import { canonicalizeWorkerTrade } from '../../lib/trade-canonical';
import { requestTradeAliasGeneration } from '../../lib/trade-alias-request';

// ── Contract shared by every exported function in this module ──
//
// Caller owns the transaction: none of these functions issue BEGIN, COMMIT,
// ROLLBACK, connect(), or release(). They also never set RLS context —
// the caller must already have an open transaction with the correct GUC
// (`app.current_internal_user_id`) set via `setInternalUserRlsContext`
// before calling in. All SQL is parameterized; no value or identifier is
// ever string-concatenated into a query.

export interface WorkerGate {
  userId: string;
  lifecycle: WorkerLifecycle;
  runId: string | null;
  workflowVersion: number | null;
  currentStepKey: WorkflowStepKey | null;
  status: WorkflowRunStatus | null;
  preferredLanguage: PreferredLanguage;
  lockVersion: number | null;
}

export interface PreAuthState {
  challengeId: string;
  phoneHash: string;
  providerChallengeId: string | null;
  candidateUserId: string | null;
  preferredLanguage: PreferredLanguage;
  currentStepKey: 'start.choose_language' | 'identity.verify_otp';
  context: Record<string, unknown>;
  status: 'pending' | 'expired' | 'locked' | 'superseded';
  attempts: number;
  expiresAt: Date | null;
  lockedUntil: Date | null;
}

interface WorkerGateRow {
  user_id: string;
  lifecycle: WorkerLifecycle;
  run_id: string | null;
  workflow_version: number | null;
  current_step_key: WorkflowStepKey | null;
  status: WorkflowRunStatus | null;
  preferred_language: PreferredLanguage;
  lock_version: number | null;
}

function mapGateRow(row: WorkerGateRow): WorkerGate {
  return {
    userId: row.user_id,
    lifecycle: row.lifecycle,
    runId: row.run_id,
    workflowVersion: row.workflow_version,
    currentStepKey: row.current_step_key,
    status: row.status,
    preferredLanguage: row.preferred_language,
    lockVersion: row.lock_version,
  };
}

/**
 * Loads (and locks) a worker's onboarding-state + active-workflow-run gate
 * in one round trip. Returns null when the worker has no onboarding-state
 * row (unknown worker). Never binds identity or mutates state.
 *
 * Ownership/errors: caller owns the transaction; throws nothing beyond
 * whatever the underlying `client.query` rejects with.
 */
export async function loadWorkerGate(
  client: PoolClient,
  workerId: string,
): Promise<WorkerGate | null> {
  const result = await client.query<WorkerGateRow>(
    `SELECT s.user_id AS user_id,
            s.lifecycle AS lifecycle,
            r.id AS run_id,
            r.workflow_version AS workflow_version,
            r.current_step_key AS current_step_key,
            r.status AS status,
            COALESCE(r.preferred_language, 'es') AS preferred_language,
            r.lock_version AS lock_version
       FROM worker_onboarding_state s
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM worker_workflow_runs candidate
          WHERE candidate.user_id = s.user_id
          ORDER BY (candidate.status = 'active') DESC,
                   candidate.created_at DESC,
                   candidate.id DESC
          LIMIT 1
       ) r ON true
      WHERE s.user_id = $1
      FOR UPDATE OF s`,
    [workerId],
  );
  const row = result.rows[0];
  return row ? mapGateRow(row) : null;
}

interface IdentityChallengeRow {
  id: string;
  phone_hash: string;
  provider_challenge_id: string | null;
  candidate_user_id: string | null;
  preferred_language: PreferredLanguage;
  current_step_key: 'start.choose_language' | 'identity.verify_otp';
  context: Record<string, unknown>;
  status: 'pending' | 'expired' | 'locked' | 'superseded';
  attempts: number;
  expires_at: Date | null;
  locked_until: Date | null;
}

function mapPreAuthRow(row: IdentityChallengeRow): PreAuthState {
  return {
    challengeId: row.id,
    phoneHash: row.phone_hash,
    providerChallengeId: row.provider_challenge_id,
    candidateUserId: row.candidate_user_id,
    preferredLanguage: row.preferred_language,
    currentStepKey: row.current_step_key,
    context: row.context,
    status: row.status,
    attempts: row.attempts,
    expiresAt: row.expires_at,
    lockedUntil: row.locked_until,
  };
}

/**
 * Loads the pending/locked pre-auth challenge for a phone hash via the
 * SECURITY DEFINER `load_worker_pre_auth` function — `jale_whatsapp` has no
 * direct SELECT on `worker_identity_challenges`. Keyed only by phone hash;
 * never resolves or binds a verified worker identity. Returns null when no
 * pending/locked row exists for the hash.
 */
export async function loadPreAuthStateForUpdate(
  client: PoolClient,
  phoneHash: string,
): Promise<PreAuthState | null> {
  const result = await client.query<IdentityChallengeRow>(
    `SELECT * FROM public.load_worker_pre_auth($1)`,
    [phoneHash],
  );
  const row = result.rows[0];
  return row ? mapPreAuthRow(row) : null;
}

const PRE_AUTH_PATCH_FIELD_MAP: Array<{
  key: keyof PreAuthState;
  column: string;
  serialize?: (value: unknown) => unknown;
}> = [
  { key: 'providerChallengeId', column: 'provider_challenge_id' },
  { key: 'candidateUserId', column: 'candidate_user_id' },
  { key: 'preferredLanguage', column: 'preferred_language' },
  { key: 'currentStepKey', column: 'current_step_key' },
  { key: 'context', column: 'context' },
  { key: 'status', column: 'status' },
  { key: 'attempts', column: 'attempts' },
  {
    key: 'expiresAt',
    column: 'expires_at',
    serialize: (value) => (value instanceof Date ? value.toISOString() : value),
  },
  {
    key: 'lockedUntil',
    column: 'locked_until',
    serialize: (value) => (value instanceof Date ? value.toISOString() : value),
  },
];

/**
 * Saves a narrow, allow-listed patch of pre-auth fields via the SECURITY
 * DEFINER `save_worker_pre_auth` function, keyed only by phone hash. Only
 * fields present on `patch` are sent — this can never set `verified_user_id`
 * or any identity-binding field; that transition only happens through
 * `bindVerifiedIdentityAndStartWorkflow`.
 *
 * Throws whatever `save_worker_pre_auth` raises (e.g. an invalid status
 * transition) if the definer function rejects the patch.
 */
export async function savePreAuthState(
  client: PoolClient,
  phoneHash: string,
  patch: Partial<PreAuthState>,
): Promise<PreAuthState> {
  const patchObject: Record<string, unknown> = {};
  for (const field of PRE_AUTH_PATCH_FIELD_MAP) {
    if (field.key in patch) {
      const raw = (patch as Record<string, unknown>)[field.key];
      patchObject[field.column] = field.serialize ? field.serialize(raw) : raw;
    }
  }

  const result = await client.query<IdentityChallengeRow>(
    `SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)`,
    [phoneHash, JSON.stringify(patchObject)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('pre_auth_save_failed');
  }
  return mapPreAuthRow(row);
}

/**
 * Binds a verified worker identity to the WhatsApp conversation and starts
 * the onboarding workflow run (at `legal.review`) via the SECURITY DEFINER
 * `bind_verified_identity_and_start_workflow` function. This is the only
 * path that may attach a `user_id` to a conversation or challenge.
 *
 * Returns the resulting gate (never null — the definer function always
 * creates the onboarding-state + active run rows before returning).
 */
export async function bindVerifiedIdentityAndStartWorkflow(
  client: PoolClient,
  input: {
    conversationId: string;
    phoneHash: string;
    challengeId: string;
    verifiedWorkerId: string;
    preferredLanguage: PreferredLanguage;
    workflowVersion: number;
    inboundMessageSid: string;
  },
): Promise<WorkerGate> {
  await client.query(
    `SELECT * FROM public.bind_verified_identity_and_start_workflow($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.phoneHash,
      input.verifiedWorkerId,
      input.conversationId,
      input.workflowVersion,
      input.preferredLanguage,
      input.inboundMessageSid,
      JSON.stringify({}),
    ],
  );

  const gate = await loadWorkerGate(client, input.verifiedWorkerId);
  if (!gate) {
    throw new Error('worker_gate_missing_after_bind');
  }
  return gate;
}

/**
 * Advances a workflow run to a new step, guarded by optimistic
 * `lock_version`. Merges `contextPatch` into the run's JSONB context and
 * appends exactly one transition row recording the move.
 *
 * A validated legal terminal status ('declined' | 'cancelled' | 'failed')
 * may be applied via `status` while `toStepKey` still records the
 * canonical current step.
 *
 * Throws `Error('workflow_lock_conflict')` when no row matches
 * `id = runId AND lock_version = expectedLockVersion` (stale caller state
 * or a concurrent writer already advanced the run).
 */
export async function advanceWorkflow(
  client: PoolClient,
  input: {
    runId: string;
    expectedLockVersion: number;
    fromStepKey: WorkflowStepKey;
    toStepKey: WorkflowStepKey;
    status?: WorkflowRunStatus;
    contextPatch: Record<string, unknown>;
    inboundMessageSid: string;
    reason: string;
  },
): Promise<WorkerGate> {
  const result = await client.query<{ user_id: string; current_step_key: WorkflowStepKey }>(
    `UPDATE worker_workflow_runs
        SET current_step_key = $1,
            status = COALESCE($2, status),
            context = context || $3::jsonb,
            lock_version = lock_version + 1,
            updated_at = now()
      WHERE id = $4 AND lock_version = $5
      RETURNING user_id, current_step_key`,
    [
      input.toStepKey,
      input.status ?? null,
      JSON.stringify(input.contextPatch),
      input.runId,
      input.expectedLockVersion,
    ],
  );
  if (result.rowCount === 0) {
    throw new Error('workflow_lock_conflict');
  }
  const workerId = result.rows[0].user_id;

  await appendTransition(client, {
    runId: input.runId,
    fromStepKey: input.fromStepKey,
    toStepKey: input.toStepKey,
    inboundMessageSid: input.inboundMessageSid,
    reason: input.reason,
  });

  // v2 onboarding funnel datapoint (2026-07-27 observability pass): every
  // successful advance flows through here, so this single line gives the
  // per-step funnel a MetricFilter reads off the processor log group. Safe
  // scalars only — runId is a UUID; never a phone, name, or message body.
  console.log(JSON.stringify({
    metric: 'OnboardingStepAdvanced',
    fromStepKey: input.fromStepKey,
    toStepKey: input.toStepKey,
    runId: input.runId,
  }));

  const gate = await loadWorkerGate(client, workerId);
  if (!gate) {
    throw new Error('worker_gate_missing_after_advance');
  }
  return gate;
}

/**
 * Persists the workflow run's authoritative language preference without
 * advancing its current step. The optimistic lock prevents a stale command
 * from overwriting a concurrent workflow transition.
 */
export async function setRunPreferredLanguage(
  client: PoolClient,
  input: {
    runId: string;
    expectedLockVersion: number;
    preferredLanguage: PreferredLanguage;
  },
): Promise<WorkerGate> {
  const result = await client.query<{ user_id: string }>(
    `UPDATE worker_workflow_runs
        SET preferred_language = $1,
            lock_version = lock_version + 1,
            updated_at = now()
      WHERE id = $2
        AND lock_version = $3
        AND status = 'active'
      RETURNING user_id`,
    [input.preferredLanguage, input.runId, input.expectedLockVersion],
  );
  if (result.rowCount === 0) {
    throw new Error('workflow_lock_conflict');
  }

  const gate = await loadWorkerGate(client, result.rows[0].user_id);
  if (!gate) {
    throw new Error('worker_gate_missing_after_language_update');
  }
  return gate;
}

export async function reactivateDeclinedLegalRun(
  client: PoolClient,
  input: { runId: string; expectedLockVersion: number },
): Promise<WorkerGate> {
  const result = await client.query<{ user_id: string }>(
    `UPDATE worker_workflow_runs
        SET status = 'active',
            lock_version = lock_version + 1,
            updated_at = now()
      WHERE id = $1
        AND lock_version = $2
        AND status = 'declined'
        AND current_step_key = 'legal.review'
      RETURNING user_id`,
    [input.runId, input.expectedLockVersion],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error('workflow_lock_conflict');
  }

  const gate = await loadWorkerGate(client, result.rows[0].user_id);
  if (!gate) {
    throw new Error('worker_gate_missing_after_reactivation');
  }
  return gate;
}

/**
 * Appends one immutable transition row to `worker_workflow_transitions`.
 * Pure insert — never mutates the run itself.
 */
export async function appendTransition(
  client: PoolClient,
  input: {
    runId: string;
    fromStepKey: WorkflowStepKey | null;
    toStepKey: WorkflowStepKey;
    inboundMessageSid: string | null;
    reason: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ transitionId: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO worker_workflow_transitions
        (run_id, from_step_key, to_step_key, inbound_message_sid, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      input.runId,
      input.fromStepKey,
      input.toStepKey,
      input.inboundMessageSid,
      input.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return { transitionId: result.rows[0].id };
}

/**
 * Clears exactly the seven profile-answer fields a worker has typed during
 * onboarding (plus their `worker_profiles` mirrors), for the RESTART/
 * REINICIAR gate command (see `onboarding/gate.ts`). Mirrors the
 * constraint-safe UPDATE column lists in
 * `scripts/reset-whatsapp-onboarding-v2.ts` (WORKER_PROFILES_UPDATE /
 * USERS_UPDATE) but is deliberately narrower: legal acceptance, consent,
 * OTP/identity state, lifecycle, and `users.trust_signals` /
 * `trust_signals_completed_at` / `trade_competency_score` are left
 * completely untouched — RESTART re-asks the profile questions, it does not
 * revoke legal consent, sign the worker out, or discard a scored trust
 * assessment. Never deletes a row; both statements run UPDATE-only.
 *
 * The five `worker_profiles` location columns (latitude, longitude,
 * location_source, location_confidence, location_updated_at) are cleared
 * TOGETHER — same constraint-group discipline as the reset CLI — because
 * `worker_profiles_location_complete` (migration 009) requires them to be
 * either all-NULL or all-set; clearing a subset would violate the CHECK.
 *
 * No BEGIN/COMMIT here — both UPDATEs run on the caller's already-open
 * transaction, same contract as every other function in this module. Every
 * column cleared here is one `jale_whatsapp` already writes directly via
 * `ProfilePersistenceAdapter` (saveName/saveTrade/saveCustomTrade/
 * saveExperience/saveTransportation/saveAvailability/saveLocation in
 * `lib/onboarding-adapters.ts`), so no new grant is required.
 */
export async function clearProfileAnswers(
  client: PoolClient,
  workerId: string,
): Promise<void> {
  await client.query(
    `UPDATE users
        SET full_name = NULL,
            city = NULL,
            main_trade = NULL,
            main_trade_other = NULL,
            years_experience = NULL,
            has_transportation = NULL,
            availability = NULL
      WHERE id = $1 AND user_type = 'worker'`,
    [workerId],
  );

  await client.query(
    `UPDATE worker_profiles
        SET full_name = NULL,
            availability = NULL,
            years_experience = NULL,
            location = NULL,
            latitude = NULL,
            longitude = NULL,
            location_source = NULL,
            location_confidence = NULL,
            location_updated_at = NULL
      WHERE user_id = $1`,
    [workerId],
  );
}

/**
 * RESTART repair (migration 052): resets the worker's PENDING trust
 * assessment answers and clears any residual `worker_skills` row(s) so a
 * restart with a different trade doesn't leave the abandoned trade's skill
 * matched (`upsertWorkerProfileFromUsers`'s seeding INSERT is
 * `ON CONFLICT DO NOTHING`, so without this the old row survives forever).
 *
 * Never a DELETE on `worker_trust_assessments` — `jale_whatsapp` has no
 * DELETE grant on that table (migration 049 only granted UPDATE(answers,
 * rubric_version, scoring_model_id)), and this must never touch a scored or
 * completed assessment: `WHERE status = 'pending'` both satisfies the
 * `wta_whatsapp_pending_rows` policy and keeps this scoped to the
 * in-progress attempt being abandoned. `worker_skills` DELETE is granted by
 * migration 052 with a worker-scoped policy mirroring
 * `worker_skills_whatsapp_insert`.
 */
export async function resetPendingTrustAssessmentAndSkills(
  client: PoolClient,
  workerId: string,
): Promise<void> {
  await client.query(
    `UPDATE worker_trust_assessments
        SET answers = '[]'::jsonb
      WHERE user_id = $1 AND status = 'pending'`,
    [workerId],
  );

  await client.query(
    `DELETE FROM worker_skills WHERE worker_id = $1`,
    [workerId],
  );
}

/**
 * Looks up the step a run was on immediately before its CURRENT step, for
 * the BACK/ATRAS gate command (`onboarding/gate.ts`). Reads the most recent
 * `worker_workflow_transitions` row that landed ON `currentStepKey` and
 * actually moved from somewhere else: `from_step_key IS NOT NULL` excludes
 * a run's very first transition (bind-time entry has no prior step), and
 * `from_step_key <> to_step_key` excludes no-op markers like
 * `completeOnboarding`'s terminal transition (from = to). Returns null when
 * no such transition exists — nothing to go back to. Read-only: never locks
 * or mutates a row.
 *
 * `reason NOT LIKE 'worker\_%'` excludes BACK's own `worker_back` and
 * RESTART's `worker_restart` transitions (the only two `worker_`-prefixed
 * reasons; every forward-progress reason is `profile_*`/`legal_*`/
 * `trust_*`/`onboarding_complete`) — without it, `handleBackCommand`'s own
 * write (landing back ON the step the worker just left) becomes the
 * "previous" step on the very next BACK, so a second press walks the worker
 * forward again instead of continuing backward. The pre-auth keys are
 * excluded because a `self_heal_preauth_step` transition (routeBoundStep)
 * legitimately records `from_step_key = 'start.choose_language'`, and BACK
 * must never land a bound run on a pre-auth step. `from_step_key NOT IN
 * (...)` excludes the two voice holding steps: neither has a prompt of its
 * own, so BACK must never land a worker there.
 */
export async function findPreviousStepKey(
  client: PoolClient,
  runId: string,
  currentStepKey: WorkflowStepKey,
): Promise<WorkflowStepKey | null> {
  const result = await client.query<{ from_step_key: WorkflowStepKey }>(
    `SELECT from_step_key
       FROM worker_workflow_transitions
      WHERE run_id = $1
        AND to_step_key = $2
        AND from_step_key IS NOT NULL
        AND from_step_key <> to_step_key
        AND reason NOT LIKE 'worker\\_%'
        AND from_step_key NOT IN ('profile.voice_choice', 'profile.voice_processing',
                                  'start.choose_language', 'identity.verify_otp')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [runId, currentStepKey],
  );
  return result.rows[0]?.from_step_key ?? null;
}

async function insertDomainEventIdempotent(
  client: PoolClient,
  input: {
    eventType: 'assessment.requested' | 'worker.ready';
    aggregateId: string;
    eventKey: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [input.eventType, input.aggregateId, input.eventKey, JSON.stringify(input.payload)],
  );
  if (inserted.rows[0]) {
    return inserted.rows[0].id;
  }
  // A concurrent writer already claimed this event_key; look up its id.
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM worker_domain_outbox WHERE event_key = $1`,
    [input.eventKey],
  );
  return existing.rows[0].id;
}

/**
 * Marks onboarding complete: flips lifecycle to 'ready', completes the
 * workflow run (guarded by `expectedLockVersion`), appends one terminal
 * transition, and idempotently enqueues the two downstream domain events
 * (`assessment.requested`, `worker.ready`) other lanes react to.
 *
 * No BEGIN/COMMIT, no fetch, no AWS SDK calls — every statement runs on the
 * caller's already-open transaction.
 *
 * Throws `Error('workflow_lock_conflict')` when the run update matches zero
 * rows (stale `expectedLockVersion`).
 */
export async function completeOnboarding(
  client: PoolClient,
  input: {
    workerId: string;
    runId: string;
    expectedLockVersion: number;
    assessmentProvenance: Record<string, unknown>;
    /**
     * Job referrals (migration 056): the worker's phone hash, derived by the
     * caller via `hashNormalizedPhone` from whatever phone value is already
     * in scope (`trust.ts` uses `session.whatsapp_number`) — this module
     * never loads or hashes a phone itself, and `jale_whatsapp` has no grant
     * on `users.whatsapp_number` to do so even if it wanted to. `Required`
     * at the `OnboardingV2RepoDeps.completeOnboarding` injection-contract
     * level (`onboarding/types.ts`) — every router-owned call site must
     * supply it, so a future step handler that forgets it fails to compile
     * rather than silently skipping the claim. Kept optional on THIS
     * lower-level function only so its other direct caller — the DB
     * integration suite (`test/unit/db/`, out of scope, predates this
     * feature) — keeps compiling unchanged; when omitted, no referral claim
     * is attempted and lifecycle completion itself is unaffected either way.
     */
    workerPhoneHash?: string;
    /** Defaults to `new Date()` when omitted — only `claimPendingReferral`'s
     * expiry comparison depends on this; every other write below already
     * uses the database's own `now()`. */
    now?: Date;
  },
): Promise<{ assessmentEventId: string; workerReadyEventId: string }> {
  await client.query(
    `UPDATE worker_onboarding_state
        SET lifecycle = 'ready',
            ready_at = now(),
            lifecycle_changed_at = now(),
            updated_at = now()
      WHERE user_id = $1`,
    [input.workerId],
  );

  const runResult = await client.query<{ current_step_key: WorkflowStepKey }>(
    `UPDATE worker_workflow_runs
        SET status = 'completed',
            completed_at = now(),
            lock_version = lock_version + 1,
            updated_at = now()
      WHERE id = $1 AND lock_version = $2
      RETURNING current_step_key`,
    [input.runId, input.expectedLockVersion],
  );
  if (runResult.rowCount === 0) {
    throw new Error('workflow_lock_conflict');
  }
  const currentStepKey = runResult.rows[0].current_step_key;

  await appendTransition(client, {
    runId: input.runId,
    fromStepKey: currentStepKey,
    toStepKey: currentStepKey,
    inboundMessageSid: null,
    reason: 'onboarding_complete',
  });

  // Job referrals (migration 056): claimed in the SAME transaction that
  // flips lifecycle to 'ready', so the attribution write can never be lost
  // to a later step failing. No-op (never throws) when the caller has no
  // phone hash in scope, or when no unclaimed/unexpired pending claim
  // exists for it.
  if (input.workerPhoneHash) {
    await claimPendingReferral(client, input.workerPhoneHash, input.workerId, input.now ?? new Date());
  }

  const assessmentEventId = await insertDomainEventIdempotent(client, {
    eventType: 'assessment.requested',
    aggregateId: input.workerId,
    eventKey: `assessment.requested:${input.workerId}:${input.runId}`,
    payload: input.assessmentProvenance,
  });
  const workerReadyEventId = await insertDomainEventIdempotent(client, {
    eventType: 'worker.ready',
    aggregateId: input.workerId,
    eventKey: `worker.ready:${input.workerId}:${input.runId}`,
    payload: {},
  });

  // Funnel terminus (2026-07-27 observability pass). Safe scalars only.
  console.log(JSON.stringify({ metric: 'OnboardingCompleted', runId: input.runId }));

  return { assessmentEventId, workerReadyEventId };
}

/**
 * Sprint 24 L6 — the canonicalising custom-trade write.
 *
 * `ProfilePersistenceAdapter.saveCustomTrade` (lib/onboarding-adapters.ts)
 * stores the worker's raw typed profession verbatim, so "soldador",
 * "Soldadura" and "welder" become three different stored trades for one job.
 * This resolves the text through the bilingual `trade_aliases` cache first and
 * writes the canonical pair instead (decision D4):
 *
 *   - resolves to a row whose `trade_category` is also a `users.main_trade`
 *     enum key -> that key, with `main_trade_other` cleared
 *   - resolves otherwise (welder, drywall, ...) -> stays custom, with the
 *     canonical name in the worker's own language
 *   - resolves to nothing -> the worker's words, tidied, and the alias
 *     generator is asked to learn the trade so the NEXT write canonicalises
 *
 * Blank input writes NOTHING: `main_trade = 'other'` with a null
 * `main_trade_other` is exactly what `chk_trade_other` (004_whatsapp.sql:66-70)
 * rejects, and there is no trade to record anyway.
 *
 * `lang` is a parameter rather than a lookup on purpose — every caller already
 * holds the run's `preferredLanguage` (`WorkerGate.preferredLanguage`), and
 * re-reading it here would mean either duplicating `loadWorkerGate`'s
 * run-selection SQL or taking its `FOR UPDATE` row lock a second time.
 *
 * Same module contract as everything else here: no BEGIN/COMMIT/ROLLBACK, no
 * RLS context, one parameterized UPDATE on the caller's open transaction. The
 * `trade_aliases` read therefore runs INSIDE that transaction; a genuine DB
 * failure there aborts it and the UPDATE below fails loudly rather than
 * silently storing something wrong.
 */
export async function saveCanonicalCustomTrade(
  client: PoolClient,
  workerId: string,
  rawProfession: string,
  lang: PreferredLanguage = 'es',
): Promise<void> {
  const canonical = await canonicalizeWorkerTrade(client, { raw: rawProfession, lang });
  if (canonical.main_trade === 'other' && !canonical.main_trade_other) return;

  await client.query(
    `UPDATE users
        SET main_trade = $2,
            main_trade_other = $3
      WHERE id = $1 AND user_type = 'worker'`,
    [workerId, canonical.main_trade, canonical.main_trade_other],
  );

  // Fire-and-forget cache growth, and only for a trade the cache did not
  // know. `requestTradeAliasGeneration` never throws by contract; the
  // try/catch is defence in depth so learning a trade can never fail the
  // worker's onboarding turn.
  if (!canonical.resolved && canonical.main_trade_other) {
    try {
      await requestTradeAliasGeneration(canonical.main_trade_other);
    } catch {
      // Swallowed intentionally -- see comment above.
    }
  }
}
