import {
  loadWorkerGate,
  loadPreAuthStateForUpdate,
  savePreAuthState,
  bindVerifiedIdentityAndStartWorkflow,
  advanceWorkflow,
  appendTransition,
  completeOnboarding,
} from '../../../../../lambda/whatsapp/lib/onboarding-repository';

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
    expect(sql).toMatch(/FOR UPDATE/);
  });
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
});
