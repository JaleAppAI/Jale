import { requestTradeAliasGeneration } from '../../../../../lambda/lib/trade-alias-request';
import {
  saveCanonicalCustomTrade,
  loadWorkerGate,
  loadPreAuthStateForUpdate,
  savePreAuthState,
  bindVerifiedIdentityAndStartWorkflow,
  advanceWorkflow,
  setRunPreferredLanguage,
  reactivateDeclinedLegalRun,
  appendTransition,
  completeOnboarding,
  clearProfileAnswers,
  resetPendingTrustAssessmentAndSkills,
  findPreviousStepKey,
} from '../../../../../lambda/whatsapp/lib/onboarding-repository';

// The alias generator is a fire-and-forget Lambda invoke; only WHETHER it was
// asked to learn a trade is behaviour this module owns.
jest.mock('../../../../../lambda/lib/trade-alias-request');

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUN_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const PHONE_HASH = 'f'.repeat(64);

function makeClient() {
  const query = jest.fn();
  return { query, client: { query } as any };
}

describe('loadWorkerGate', () => {
  it('returns null for an unknown worker', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    const gate = await loadWorkerGate(client, WORKER_ID);

    expect(gate).toBeNull();
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    expect(query.mock.calls[0][1]).toEqual([WORKER_ID]);
  });

  it('maps the joined state + active run row and locks it', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({
      rows: [{
        user_id: WORKER_ID,
        lifecycle: 'onboarding',
        run_id: RUN_ID,
        workflow_version: 1,
        current_step_key: 'legal.review',
        status: 'active',
        preferred_language: 'es',
        lock_version: 0,
      }],
    });

    const gate = await loadWorkerGate(client, WORKER_ID);

    expect(gate).toEqual({
      userId: WORKER_ID,
      lifecycle: 'onboarding',
      runId: RUN_ID,
      workflowVersion: 1,
      currentStepKey: 'legal.review',
      status: 'active',
      preferredLanguage: 'es',
      lockVersion: 0,
    });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/worker_onboarding_state/);
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
    expect(sql).toMatch(/ORDER BY \(candidate\.status = 'active'\) DESC/);
    expect(sql).not.toMatch(/ON r\.user_id = s\.user_id AND r\.status = 'active'/);
    expect(sql).toMatch(/FOR UPDATE/);
  });

  // The active-first/latest lateral join also returns declined/completed rows
  // when no active run exists; row mapping is status-agnostic.
});

describe('pre-auth state (phone-hash keyed, never binds identity)', () => {
  const rawChallengeRow = {
    id: 'cccccccc-0000-0000-0000-000000000001',
    phone_hash: PHONE_HASH,
    provider_challenge_id: 'provider-1',
    candidate_user_id: null,
    preferred_language: 'es',
    current_step_key: 'identity.verify_otp',
    context: {},
    status: 'pending',
    attempts: 0,
    expires_at: null,
    locked_until: null,
  };

  it('loadPreAuthStateForUpdate calls load_worker_pre_auth keyed only by phone hash', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [rawChallengeRow] });

    const state = await loadPreAuthStateForUpdate(client, PHONE_HASH);

    expect(query.mock.calls[0][0]).toMatch(/load_worker_pre_auth/);
    expect(query.mock.calls[0][1]).toEqual([PHONE_HASH]);
    expect(state).toEqual({
      challengeId: rawChallengeRow.id,
      phoneHash: PHONE_HASH,
      providerChallengeId: 'provider-1',
      candidateUserId: null,
      preferredLanguage: 'es',
      currentStepKey: 'identity.verify_otp',
      context: {},
      status: 'pending',
      attempts: 0,
      expiresAt: null,
      lockedUntil: null,
    });
  });

  it('loadPreAuthStateForUpdate returns null when no row is pending/locked', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    const state = await loadPreAuthStateForUpdate(client, PHONE_HASH);

    expect(state).toBeNull();
  });

  it('savePreAuthState calls save_worker_pre_auth with a JSONB patch keyed by phone hash only', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ ...rawChallengeRow, attempts: 1 }] });

    const state = await savePreAuthState(client, PHONE_HASH, { attempts: 1 });

    expect(query.mock.calls[0][0]).toMatch(/save_worker_pre_auth/);
    const [phoneHashParam, patchParam] = query.mock.calls[0][1] as [string, string];
    expect(phoneHashParam).toBe(PHONE_HASH);
    const patch = JSON.parse(patchParam);
    expect(patch).toEqual({ attempts: 1 });
    expect(state.attempts).toBe(1);
  });

  it('savePreAuthState never sends a candidate/verified identity binding by itself', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [rawChallengeRow] });

    await savePreAuthState(client, PHONE_HASH, { currentStepKey: 'identity.verify_otp' });

    const patchParam = (query.mock.calls[0][1] as [string, string])[1];
    const patch = JSON.parse(patchParam);
    expect(patch).not.toHaveProperty('verified_user_id');
    expect(Object.keys(patch)).toEqual(['current_step_key']);
  });
});

describe('bindVerifiedIdentityAndStartWorkflow', () => {
  it('calls the definer binding function then reloads the gate at legal.review', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({
        rows: [{
          challenge_id: 'cccccccc-0000-0000-0000-000000000001',
          onboarding_state_id: 'dddddddd-0000-0000-0000-000000000001',
          run_id: RUN_ID,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          user_id: WORKER_ID,
          lifecycle: 'onboarding',
          run_id: RUN_ID,
          workflow_version: 1,
          current_step_key: 'legal.review',
          status: 'active',
          preferred_language: 'es',
          lock_version: 0,
        }],
      });

    const gate = await bindVerifiedIdentityAndStartWorkflow(client, {
      conversationId: 'eeeeeeee-0000-0000-0000-000000000001',
      phoneHash: PHONE_HASH,
      challengeId: 'cccccccc-0000-0000-0000-000000000001',
      verifiedWorkerId: WORKER_ID,
      preferredLanguage: 'es',
      workflowVersion: 1,
      inboundMessageSid: 'SM_bind',
    });

    expect(query.mock.calls[0][0]).toMatch(/bind_verified_identity_and_start_workflow/);
    expect(gate).toEqual(expect.objectContaining({
      lifecycle: 'onboarding',
      currentStepKey: 'legal.review',
      runId: RUN_ID,
    }));
  });
});

describe('advanceWorkflow', () => {
  it('guards on lock_version, patches context, and appends exactly one transition', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_id: WORKER_ID, current_step_key: 'profile.name' }],
      }) // UPDATE worker_workflow_runs
      .mockResolvedValueOnce({ rows: [{ id: 'transition-1' }] }) // appendTransition INSERT
      .mockResolvedValueOnce({
        rows: [{
          user_id: WORKER_ID,
          lifecycle: 'onboarding',
          run_id: RUN_ID,
          workflow_version: 1,
          current_step_key: 'profile.name',
          status: 'active',
          preferred_language: 'es',
          lock_version: 1,
        }],
      }); // reload gate

    const gate = await advanceWorkflow(client, {
      runId: RUN_ID,
      expectedLockVersion: 0,
      fromStepKey: 'legal.review',
      toStepKey: 'profile.name',
      contextPatch: { acceptedLegal: true },
      inboundMessageSid: 'SM_advance',
      reason: 'legal_accepted',
    });

    const updateCall = query.mock.calls[0];
    expect(updateCall[0]).toMatch(/lock_version = lock_version \+ 1/);
    expect(updateCall[0]).toMatch(/WHERE id = \$\d+ AND lock_version = \$\d+/);

    const insertTransitionCalls = query.mock.calls.filter(([sql]) =>
      /INSERT INTO worker_workflow_transitions/.test(sql));
    expect(insertTransitionCalls).toHaveLength(1);

    expect(gate?.currentStepKey).toBe('profile.name');
  });

  it('throws workflow_lock_conflict when the lock version does not match', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(advanceWorkflow(client, {
      runId: RUN_ID,
      expectedLockVersion: 5,
      fromStepKey: 'legal.review',
      toStepKey: 'profile.name',
      contextPatch: {},
      inboundMessageSid: 'SM_stale',
      reason: 'legal_accepted',
    })).rejects.toThrow('workflow_lock_conflict');

    // No transition should be appended on a failed lock guard.
    expect(query.mock.calls.filter(([sql]) =>
      /INSERT INTO worker_workflow_transitions/.test(sql))).toHaveLength(0);
  });
});

describe('setRunPreferredLanguage', () => {
  it('updates the authoritative run language behind the optimistic lock and reloads the gate', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ user_id: WORKER_ID }],
      })
      .mockResolvedValueOnce({
        rows: [{
          user_id: WORKER_ID,
          lifecycle: 'onboarding',
          run_id: RUN_ID,
          workflow_version: 1,
          current_step_key: 'legal.review',
          status: 'active',
          preferred_language: 'en',
          lock_version: 1,
        }],
      });

    const gate = await setRunPreferredLanguage(client, {
      runId: RUN_ID,
      expectedLockVersion: 0,
      preferredLanguage: 'en',
    });

    const updateCall = query.mock.calls[0];
    expect(updateCall[0]).toMatch(/preferred_language = \$1/);
    expect(updateCall[0]).toMatch(/lock_version = lock_version \+ 1/);
    expect(updateCall[0]).toMatch(/status = 'active'/);
    expect(updateCall[1]).toEqual(['en', RUN_ID, 0]);
    expect(gate.preferredLanguage).toBe('en');
    expect(gate.lockVersion).toBe(1);
  });

  it('throws workflow_lock_conflict when the run is stale', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(setRunPreferredLanguage(client, {
      runId: RUN_ID,
      expectedLockVersion: 4,


      preferredLanguage: 'es',
    })).rejects.toThrow('workflow_lock_conflict');

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('reactivateDeclinedLegalRun', () => {
  it('reactivates only the locked declined legal run and reloads its gate', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ user_id: WORKER_ID }] })
      .mockResolvedValueOnce({ rows: [{
        user_id: WORKER_ID,
        lifecycle: 'onboarding',
        run_id: RUN_ID,
        workflow_version: 1,
        current_step_key: 'legal.review',
        status: 'active',
        preferred_language: 'en',
        lock_version: 2,
      }] });

    const gate = await reactivateDeclinedLegalRun(client, {
      runId: RUN_ID,
      expectedLockVersion: 1,
    });

    const update = query.mock.calls[0];
    expect(update[0]).toMatch(/status = 'active'/);
    expect(update[0]).toMatch(/status = 'declined'/);
    expect(update[0]).toMatch(/current_step_key = 'legal.review'/);
    expect(update[1]).toEqual([RUN_ID, 1]);
    expect(gate).toEqual(expect.objectContaining({ status: 'active', runId: RUN_ID }));
  });
});

describe('appendTransition', () => {
  it('inserts a transition row and returns its id', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ id: 'transition-9' }] });

    const result = await appendTransition(client, {
      runId: RUN_ID,
      fromStepKey: 'legal.review',
      toStepKey: 'profile.name',
      inboundMessageSid: 'SM_t',
      reason: 'legal_accepted',
    });

    expect(result).toEqual({ transitionId: 'transition-9' });
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO worker_workflow_transitions/);
    expect(query.mock.calls[0][0]).toMatch(/RETURNING id/);
  });
});

describe('clearProfileAnswers', () => {
  it('issues exactly two UPDATEs (users, worker_profiles), no DELETE, no BEGIN/COMMIT', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await clearProfileAnswers(client, WORKER_ID);

    expect(query).toHaveBeenCalledTimes(2);
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /^\s*UPDATE users/.test(sql))).toBe(true);
    expect(statements.some((sql) => /^\s*UPDATE worker_profiles/.test(sql))).toBe(true);
    expect(statements.some((sql) => /DELETE/i.test(sql))).toBe(false);
    expect(statements.some((sql) => sql === 'BEGIN')).toBe(false);
    expect(statements.some((sql) => sql === 'COMMIT')).toBe(false);
  });

  it('clears exactly the seven profile-answer fields on users, scoped to this worker as a worker account', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await clearProfileAnswers(client, WORKER_ID);

    const usersCall = query.mock.calls.find(([sql]) => /UPDATE users/.test(String(sql)))!;
    const sql = usersCall[0] as string;
    for (const column of [
      'full_name', 'city', 'main_trade', 'main_trade_other',
      'years_experience', 'has_transportation', 'availability',
    ]) {
      expect(sql).toMatch(new RegExp(`${column}\\s*=\\s*NULL`));
    }
    expect(sql).toMatch(/WHERE id = \$1 AND user_type = 'worker'/);
    expect(usersCall[1]).toEqual([WORKER_ID]);

    // Never touches legal/consent/OTP/lifecycle/trust state.
    expect(sql).not.toMatch(/trust_signals/);
    expect(sql).not.toMatch(/tos_accepted_at|privacy_accepted_at/);
    expect(sql).not.toMatch(/whatsapp_number|whatsapp_linked_at/);
  });

  it('clears the worker_profiles mirrors, with the five location columns cleared TOGETHER (constraint-group discipline)', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await clearProfileAnswers(client, WORKER_ID);

    const profilesCall = query.mock.calls.find(([sql]) => /UPDATE worker_profiles/.test(String(sql)))!;
    const sql = profilesCall[0] as string;
    for (const column of ['full_name', 'availability', 'years_experience', 'location']) {
      expect(sql).toMatch(new RegExp(`${column}\\s*=\\s*NULL`));
    }
    // worker_profiles_location_complete (migration 009) requires latitude,
    // longitude, location_source, location_confidence, location_updated_at
    // to be either all-NULL or all-set — clearing a subset would violate the
    // CHECK, so every one of the five must appear in the SAME statement.
    for (const column of [
      'latitude', 'longitude', 'location_source', 'location_confidence', 'location_updated_at',
    ]) {
      expect(sql).toMatch(new RegExp(`${column}\\s*=\\s*NULL`));
    }
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(profilesCall[1]).toEqual([WORKER_ID]);

    // bio/experience_months/certifications are reset-CLI-only columns not in
    // Task 9's seven-field scope — never touched by RESTART.
    expect(sql).not.toMatch(/\bbio\b/);
    expect(sql).not.toMatch(/experience_months/);
    expect(sql).not.toMatch(/certifications/);
  });
});

describe('findPreviousStepKey', () => {
  it('returns the from_step_key of the most recent qualifying transition', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ from_step_key: 'profile.trade' }] });

    const prev = await findPreviousStepKey(client, RUN_ID, 'profile.custom_trade');

    expect(prev).toBe('profile.trade');
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM worker_workflow_transitions/);
    expect(sql).toMatch(/to_step_key = \$2/);
    expect(sql).toMatch(/from_step_key IS NOT NULL/);
    expect(sql).toMatch(/from_step_key <> to_step_key/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(query.mock.calls[0][1]).toEqual([RUN_ID, 'profile.custom_trade']);
  });

  it('returns null when no qualifying transition exists', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [] });

    const prev = await findPreviousStepKey(client, RUN_ID, 'profile.name');

    expect(prev).toBeNull();
  });

  // Task 3/B1 fix: without excluding BACK's/RESTART's own `worker_*`-
  // prefixed navigation transitions, the SECOND consecutive BACK finds the
  // row the FIRST BACK just wrote (landing back on the step the worker just
  // left) and walks forward instead of continuing backward.
  it('excludes worker_back/worker_restart transitions from the candidate previous step', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ from_step_key: 'profile.trade' }] });

    await findPreviousStepKey(client, RUN_ID, 'profile.location');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/reason NOT LIKE 'worker\\_%'/);
  });

  // Neither voice holding step has a prompt of its own — BACK must never
  // land a worker there.
  it('excludes the two voice holding steps as a candidate previous step', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValueOnce({ rows: [{ from_step_key: 'profile.name' }] });

    await findPreviousStepKey(client, RUN_ID, 'profile.location');

    const sql = query.mock.calls[0][0] as string;
    // Voice holding steps have no prompt of their own; the pre-auth keys
    // are excluded because a self_heal_preauth_step transition records
    // from_step_key = 'start.choose_language' and BACK must never land a
    // bound run on a pre-auth step (2026-07-27 softlock incident).
    expect(sql).toMatch(/from_step_key NOT IN \('profile\.voice_choice', 'profile\.voice_processing',\s*'start\.choose_language', 'identity\.verify_otp'\)/);
  });
});

describe('resetPendingTrustAssessmentAndSkills', () => {
  it('resets ONLY pending assessments\' answers to [] and deletes the worker\'s worker_skills rows — never a DELETE on worker_trust_assessments', async () => {
    const { query, client } = makeClient();
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await resetPendingTrustAssessmentAndSkills(client, WORKER_ID);

    expect(query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = query.mock.calls[0];
    expect(String(updateSql).toUpperCase()).toContain('UPDATE');
    expect(String(updateSql)).toContain('worker_trust_assessments');
    expect(String(updateSql)).toMatch(/answers\s*=\s*'\[\]'::jsonb/);
    expect(String(updateSql)).toMatch(/status\s*=\s*'pending'/);
    expect(updateParams).toEqual([WORKER_ID]);

    const [deleteSql, deleteParams] = query.mock.calls[1];
    expect(String(deleteSql).toUpperCase()).toContain('DELETE FROM WORKER_SKILLS');
    expect(deleteParams).toEqual([WORKER_ID]);

    // Never a DELETE on worker_trust_assessments — jale_whatsapp has no
    // DELETE grant on that table (migration 049 only granted UPDATE).
    const allSql = query.mock.calls.map(([sql]) => String(sql).toUpperCase()).join('\n');
    expect(allSql).not.toMatch(/DELETE FROM WORKER_TRUST_ASSESSMENTS/);
  });
});

describe('completeOnboarding', () => {
  function scriptHappyPath(query: jest.Mock) {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE worker_onboarding_state
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ current_step_key: 'trust.question.3' }] }) // UPDATE worker_workflow_runs
      .mockResolvedValueOnce({ rows: [{ id: 'transition-complete' }] }) // appendTransition
      .mockResolvedValueOnce({ rows: [{ id: 'assessment-event-1' }] }) // INSERT assessment.requested
      .mockResolvedValueOnce({ rows: [{ id: 'ready-event-1' }] }); // INSERT worker.ready
  }

  it('issues no BEGIN/COMMIT and completes lifecycle + run + transition + both domain events', async () => {
    const { query, client } = makeClient();
    scriptHappyPath(query);

    const result = await completeOnboarding(client, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      expectedLockVersion: 3,
      assessmentProvenance: { source: 'trust_signals' },
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql === 'BEGIN')).toBe(false);
    expect(statements.some((sql) => sql === 'COMMIT')).toBe(false);
    expect(statements.some((sql) => /lifecycle = 'ready'/.test(sql))).toBe(true);
    expect(statements.some((sql) => /status = 'completed'/.test(sql))).toBe(true);
    expect(statements.some((sql) => /INSERT INTO worker_workflow_transitions/.test(sql))).toBe(true);
    expect(statements.filter((sql) => /INSERT INTO worker_domain_outbox/.test(sql))).toHaveLength(2);
    expect(result).toEqual({
      assessmentEventId: 'assessment-event-1',
      workerReadyEventId: 'ready-event-1',
    });
  });

  it('throws workflow_lock_conflict when the run update matches zero rows', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE worker_onboarding_state
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // UPDATE worker_workflow_runs (stale lock)

    await expect(completeOnboarding(client, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      expectedLockVersion: 99,
      assessmentProvenance: {},
    })).rejects.toThrow('workflow_lock_conflict');

    expect(query.mock.calls.filter(([sql]) =>
      /INSERT INTO worker_domain_outbox/.test(String(sql)))).toHaveLength(0);
  });

  it('resolves the existing event id when ON CONFLICT (event_key) suppresses the insert', async () => {
    const { query, client } = makeClient();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE worker_onboarding_state
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ current_step_key: 'trust.question.3' }] }) // UPDATE run
      .mockResolvedValueOnce({ rows: [{ id: 'transition-complete' }] }) // appendTransition
      .mockResolvedValueOnce({ rows: [] }) // INSERT assessment.requested conflicts -> no row
      .mockResolvedValueOnce({ rows: [{ id: 'existing-assessment-event' }] }) // re-SELECT by event_key
      .mockResolvedValueOnce({ rows: [{ id: 'ready-event-2' }] }); // INSERT worker.ready (no conflict)

    const result = await completeOnboarding(client, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      expectedLockVersion: 3,
      assessmentProvenance: {},
    });

    expect(result.assessmentEventId).toBe('existing-assessment-event');
    expect(result.workerReadyEventId).toBe('ready-event-2');
  });

  // Job referrals (migration 056): claimPendingReferral runs on the SAME
  // client as the rest of completeOnboarding, so a caller that supplies
  // workerPhoneHash gets the claim attempt inside the same transaction that
  // flips lifecycle to 'ready' — never a second connection, never optional
  // by omission alone (see referral-claims.test.ts for the function's own
  // unit coverage).
  it('attempts a referral claim on the same client when workerPhoneHash is supplied', async () => {
    const { query, client } = makeClient();
    const PHONE_HASH = 'b'.repeat(64);
    // Call order: worker_onboarding_state, worker_workflow_runs, transition
    // INSERT, THEN claimPendingReferral's UPDATE referral_pending_claims
    // (no matching row here, so it stops there), THEN the two domain events.
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE worker_onboarding_state
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ current_step_key: 'trust.question.3' }] }) // UPDATE worker_workflow_runs
      .mockResolvedValueOnce({ rows: [{ id: 'transition-complete' }] }) // appendTransition
      .mockResolvedValueOnce({ rows: [] }) // claimPendingReferral: no pending claim for this hash
      .mockResolvedValueOnce({ rows: [{ id: 'assessment-event-1' }] }) // INSERT assessment.requested
      .mockResolvedValueOnce({ rows: [{ id: 'ready-event-1' }] }); // INSERT worker.ready

    await completeOnboarding(client, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      expectedLockVersion: 3,
      workerPhoneHash: PHONE_HASH,
      now: new Date('2026-07-29T00:00:00.000Z'),
      assessmentProvenance: {},
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /UPDATE referral_pending_claims/.test(sql))).toBe(true);
    // The claim attempt lands strictly BETWEEN the transition append and the
    // domain-event inserts — same client, same transaction, no reordering.
    const claimIdx = statements.findIndex((sql) => /UPDATE referral_pending_claims/.test(sql));
    const transitionIdx = statements.findIndex((sql) => /INSERT INTO worker_workflow_transitions/.test(sql));
    const eventIdx = statements.findIndex((sql) => /INSERT INTO worker_domain_outbox/.test(sql));
    expect(claimIdx).toBeGreaterThan(transitionIdx);
    expect(claimIdx).toBeLessThan(eventIdx);
    // All statements ran on the one shared client — no second connection.
    expect(query).toHaveBeenCalledTimes(6);
  });

  it('never attempts a referral claim when workerPhoneHash is omitted (every existing caller unaffected)', async () => {
    const { query, client } = makeClient();
    scriptHappyPath(query);

    await completeOnboarding(client, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      expectedLockVersion: 3,
      assessmentProvenance: {},
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /referral_pending_claims/.test(sql))).toBe(false);
  });
});

// ── L6: the canonicalising custom-trade write ───────────────────────
describe('saveCanonicalCustomTrade', () => {
  const WELDER = { trade_key: 'welder', canonical_en: 'Welder', canonical_es: 'Soldador', trade_category: null };
  const ELECTRICIAN = { trade_key: 'electrician', canonical_en: 'Electrician', canonical_es: 'Electricista', trade_category: 'electrician' };

  /** Answers the one `trade_aliases` SELECT; everything else is a plain write. */
  function seed(aliasRow?: Record<string, unknown>) {
    const { query, client } = makeClient();
    query.mockImplementation((sql: string) =>
      /FROM trade_aliases/.test(sql)
        ? Promise.resolve({ rows: aliasRow ? [aliasRow] : [], rowCount: aliasRow ? 1 : 0 })
        : Promise.resolve({ rows: [], rowCount: 1 }),
    );
    return { query, client };
  }

  const usersUpdate = (query: jest.Mock) =>
    query.mock.calls.find(([sql]) => /UPDATE users/.test(String(sql)));

  beforeEach(() => {
    (requestTradeAliasGeneration as jest.Mock).mockReset();
    (requestTradeAliasGeneration as jest.Mock).mockResolvedValue(undefined);
  });

  it('stores the canonical Spanish name for a resolved custom trade', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, '  soldador ', 'es');

    expect(usersUpdate(query)![1]).toEqual([WORKER_ID, 'other', 'Soldador']);
    expect(requestTradeAliasGeneration).not.toHaveBeenCalled();
  });

  it('stores the canonical English name for an English worker', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, 'soldadura', 'en');

    expect(usersUpdate(query)![1]).toEqual([WORKER_ID, 'other', 'Welder']);
  });

  it('defaults to Spanish when no language is supplied', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, 'Welder');

    expect(usersUpdate(query)![1]).toEqual([WORKER_ID, 'other', 'Soldador']);
  });

  it('every spelling of one trade converges on the same stored text', async () => {
    for (const raw of ['soldador', 'Soldadura', 'WELDING', 'welders']) {
      const { query, client } = seed(WELDER);
      await saveCanonicalCustomTrade(client, WORKER_ID, raw, 'es');
      expect(usersUpdate(query)![1][2]).toBe('Soldador');
    }
  });

  it('promotes a resolved standard trade onto the enum and clears the free text', async () => {
    const { query, client } = seed(ELECTRICIAN);

    await saveCanonicalCustomTrade(client, WORKER_ID, 'electricista', 'es');

    expect(usersUpdate(query)![1]).toEqual([WORKER_ID, 'electrician', null]);
  });

  it('tidies an unresolved trade and asks the generator to learn it', async () => {
    const { query, client } = seed();

    await saveCanonicalCustomTrade(client, WORKER_ID, '  pipe   fitter ', 'es');

    expect(usersUpdate(query)![1]).toEqual([WORKER_ID, 'other', 'Pipe fitter']);
    expect(requestTradeAliasGeneration).toHaveBeenCalledWith('Pipe fitter');
  });

  it('writes nothing for blank input — chk_trade_other would reject the pair', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, '   ', 'es');

    expect(query).not.toHaveBeenCalled();
    expect(requestTradeAliasGeneration).not.toHaveBeenCalled();
  });

  it('never writes main_trade other with a null main_trade_other', async () => {
    for (const row of [WELDER, ELECTRICIAN, undefined]) {
      const { query, client } = seed(row);
      await saveCanonicalCustomTrade(client, WORKER_ID, 'soldador', 'es');
      const [, params] = usersUpdate(query)!;
      if (params[1] === 'other') expect(params[2]).toBeTruthy();
    }
  });

  it('owns no transaction: no BEGIN/COMMIT/ROLLBACK, and one UPDATE', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, 'soldador', 'es');

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
    expect(statements.filter((sql) => /UPDATE users/.test(sql))).toHaveLength(1);
  });

  it('scopes the write to workers, like every other profile write here', async () => {
    const { query, client } = seed(WELDER);

    await saveCanonicalCustomTrade(client, WORKER_ID, 'soldador', 'es');

    expect(String(usersUpdate(query)![0])).toMatch(/user_type = 'worker'/);
  });

  it('a failing generator invoke never fails the write', async () => {
    const { query, client } = seed();
    (requestTradeAliasGeneration as jest.Mock).mockRejectedValueOnce(new Error('invoke failed'));

    await expect(saveCanonicalCustomTrade(client, WORKER_ID, 'pipe fitter', 'es')).resolves.toBeUndefined();
    expect(usersUpdate(query)).toBeDefined();
  });
});
