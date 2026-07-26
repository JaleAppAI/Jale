/**
 * Task 5: Router — Profile, Location, Trade, Custom Trade, Trust, Atomic
 * Readiness.
 *
 * Every dependency is an in-memory fake built in this file: no AWS SDK, no
 * PostgreSQL connection, no jest.useFakeTimers(). The clock is a plain
 * controllable object threaded through `deps.adapters.clock`.
 */

import { routeOnboardingV2 } from '../../../../lambda/whatsapp/onboarding-v2';
import type {
  OnboardingV2Deps,
  OnboardingV2Session,
  OnboardingV2InboundMessage,
} from '../../../../lambda/whatsapp/onboarding-v2';
import type { WorkerGate } from '../../../../lambda/whatsapp/lib/onboarding-repository';
import type { WorkerMessageIntentInput } from '../../../../lambda/whatsapp/lib/onboarding-types';
import type { ResolvedLocation } from '../../../../lambda/whatsapp/lib/onboarding-adapters';

const client = { marker: 'the-shared-client' } as any;

function fakeHashNormalizedPhone(phone: string): string {
  return `hash:${phone}`;
}

// ── Fake workflow-gate repository (worker_onboarding_state + runs) ──
function createFakeGateRepo() {
  const gates = new Map<string, WorkerGate>();
  const transitions: unknown[] = [];
  const completions: Array<{ workerId: string; runId: string; expectedLockVersion: number; assessmentProvenance: Record<string, unknown> }> = [];
  const completionClients: unknown[] = [];

  const repo = {
    async loadWorkerGate(_client: any, workerId: string): Promise<WorkerGate | null> {
      return gates.get(workerId) ?? null;
    },
    async bindVerifiedIdentityAndStartWorkflow(): Promise<WorkerGate> {
      throw new Error('not used in profile tests');
    },
    async advanceWorkflow(
      _client: any,
      input: {
        runId: string;
        expectedLockVersion: number;
        fromStepKey: string;
        toStepKey: string;
        status?: string;
        contextPatch: Record<string, unknown>;
        inboundMessageSid: string;
        reason: string;
      },
    ): Promise<WorkerGate> {
      let found: WorkerGate | undefined;
      for (const gate of gates.values()) {
        if (gate.runId === input.runId) found = gate;
      }
      if (!found) throw new Error('workflow_lock_conflict');
      if (found.lockVersion !== input.expectedLockVersion) {
        throw new Error('workflow_lock_conflict');
      }
      const updated: WorkerGate = {
        ...found,
        currentStepKey: input.toStepKey as WorkerGate['currentStepKey'],
        status: (input.status as WorkerGate['status']) ?? found.status,
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      transitions.push({ ...input });
      return updated;
    },
    async appendTransition(_client: any, input: unknown): Promise<{ transitionId: string }> {
      transitions.push(input);
      return { transitionId: `t-${transitions.length}` };
    },
    async completeOnboarding(
      completeClient: any,
      input: { workerId: string; runId: string; expectedLockVersion: number; assessmentProvenance: Record<string, unknown> },
    ): Promise<{ assessmentEventId: string; workerReadyEventId: string }> {
      let found: WorkerGate | undefined;
      for (const gate of gates.values()) {
        if (gate.runId === input.runId) found = gate;
      }
      if (!found) throw new Error('workflow_lock_conflict');
      if (found.lockVersion !== input.expectedLockVersion) {
        throw new Error('workflow_lock_conflict');
      }
      completions.push({ ...input });
      completionClients.push(completeClient);
      const updated: WorkerGate = {
        ...found,
        lifecycle: 'ready',
        status: 'completed',
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      return { assessmentEventId: `assessment-${completions.length}`, workerReadyEventId: `ready-${completions.length}` };
    },
    _gates: gates,
    _transitions: transitions,
    _completions: completions,
    _completionClients: completionClients,
  };
  return repo;
}

// ── Fake delivery gateway (worker_message_intents) ──
function createFakeGateway() {
  const calls: WorkerMessageIntentInput[] = [];
  const enqueueWorkerMessage = jest.fn(
    async (_client: any, input: WorkerMessageIntentInput, _now?: Date) => {
      calls.push(input);
      return { intentId: `intent-${calls.length}`, decision: { action: 'allow' as const, reason: 'workflow_message' as const }, outboxMaterialized: true };
    },
  );
  return { enqueueWorkerMessage, calls };
}

function createFakePreAuthDelivery() {
  return {
    enqueuePreAuthPrompt: jest.fn(async () => {}),
    enqueuePreAuthText: jest.fn(async () => {}),
  };
}

// ── Fake Task 2 adapters ──
function createFakeAdapters(clockRef: { now: Date }) {
  const saveNameCalls: Array<{ client: any; workerId: string; name: string }> = [];
  const saveLocationCalls: Array<{ client: any; workerId: string; location: ResolvedLocation }> = [];
  const saveTradeCalls: Array<{ client: any; workerId: string; trade: string }> = [];
  const saveCustomTradeCalls: Array<{ client: any; workerId: string; rawProfession: string }> = [];
  const saveTrustAnswerCalls: Array<{ client: any; input: any }> = [];
  const syncProfileCalls: Array<{ client: any; workerId: string }> = [];
  // Overridable per-test: what syncProfileForTrustHandoff reports (defaults
  // to "always ready" so every pre-existing test that never touches this is
  // unaffected).
  let missingFieldsOverride: string[] | null = null;

  return {
    clock: { now: () => clockRef.now },
    identity: { issueChallenge: jest.fn(), verifyChallenge: jest.fn() },
    location: {
      resolve: jest.fn((raw: string): ResolvedLocation | null => {
        const trimmed = raw.trim();
        if (/^\d{5}$/.test(trimmed)) {
          return { city: null, state: null, postalCode: trimmed, source: 'zip' };
        }
        const match = /^([A-Za-z][A-Za-z .'-]*),\s*([A-Za-z]{2})$/.exec(trimmed);
        if (match) {
          return { city: match[1].trim(), state: match[2].toUpperCase(), postalCode: null, source: 'city_state' };
        }
        return null;
      }),
    },
    trustQuestions: { generate: jest.fn() },
    profile: {
      saveName: jest.fn(async (c: any, workerId: string, name: string) => {
        saveNameCalls.push({ client: c, workerId, name });
      }),
      saveLocation: jest.fn(async (c: any, workerId: string, location: ResolvedLocation) => {
        saveLocationCalls.push({ client: c, workerId, location });
      }),
      saveTrade: jest.fn(async (c: any, workerId: string, trade: string) => {
        saveTradeCalls.push({ client: c, workerId, trade });
      }),
      saveCustomTrade: jest.fn(async (c: any, workerId: string, rawProfession: string) => {
        saveCustomTradeCalls.push({ client: c, workerId, rawProfession });
      }),
      syncProfileForTrustHandoff: jest.fn(async (c: any, workerId: string) => {
        syncProfileCalls.push({ client: c, workerId });
        const missing = missingFieldsOverride ?? [];
        return { ready: missing.length === 0, missing };
      }),
      saveTrustAnswer: jest.fn(async (c: any, input: any) => {
        saveTrustAnswerCalls.push({ client: c, input });
      }),
    },
    _saveNameCalls: saveNameCalls,
    _saveLocationCalls: saveLocationCalls,
    _saveTradeCalls: saveTradeCalls,
    _saveCustomTradeCalls: saveCustomTradeCalls,
    _saveTrustAnswerCalls: saveTrustAnswerCalls,
    _syncProfileCalls: syncProfileCalls,
    setMissingFields: (missing: string[] | null) => {
      missingFieldsOverride = missing;
    },
  };
}

function makeDeps() {
  const clockRef = { now: new Date('2026-01-01T00:00:00.000Z') };
  const gateRepo = createFakeGateRepo();
  const gateway = createFakeGateway();
  const preAuthDelivery = createFakePreAuthDelivery();
  const adapters = createFakeAdapters(clockRef);

  const deps: OnboardingV2Deps = {
    adapters: adapters as any,
    repo: {
      setInternalUserRlsContext: async () => undefined,
      loadPreAuthStateForUpdate: async () => null,
      savePreAuthState: async (_c, _phoneHash, patch) => patch as any,
      bindVerifiedIdentityAndStartWorkflow: (c, input) => gateRepo.bindVerifiedIdentityAndStartWorkflow(),
      loadWorkerGate: (c, workerId) => gateRepo.loadWorkerGate(c, workerId),
      advanceWorkflow: (c, input) => gateRepo.advanceWorkflow(c, input),
      setRunPreferredLanguage: async (_c, input) => {
        const found = [...gateRepo._gates.values()].find((candidate) => candidate.runId === input.runId);
        if (!found) throw new Error('workflow_lock_conflict');
        return found;
      },
      reactivateDeclinedLegalRun: async (_c, input) => {
        const found = [...gateRepo._gates.values()].find((candidate) => candidate.runId === input.runId);
        if (!found) throw new Error('workflow_lock_conflict');
        return found;
      },
      appendTransition: (c, input) => gateRepo.appendTransition(c, input),
      completeOnboarding: (c, input) => gateRepo.completeOnboarding(c, input),
    },
    enqueueWorkerMessage: gateway.enqueueWorkerMessage,
    enqueuePreAuthPrompt: preAuthDelivery.enqueuePreAuthPrompt,
    enqueuePreAuthText: preAuthDelivery.enqueuePreAuthText,
    hashNormalizedPhone: fakeHashNormalizedPhone,
    tosUrl: 'https://jale.example/tos',
    privacyUrl: 'https://jale.example/privacy',
    requiredLegalVersion: '1.0',
    recordLegalAcceptance: jest.fn().mockResolvedValue(undefined),
    workflowVersion: 1,
  };

  return { deps, gateRepo, gateway, preAuthDelivery, adapters, clockRef };
}

function makeSession(overrides: Partial<OnboardingV2Session> = {}): OnboardingV2Session {
  return {
    id: 'conv-1',
    user_id: null,
    whatsapp_number: '+15551234567',
    language: 'en',
    conversation_state: 'onboarding_v2',
    state_context: {},
    ...overrides,
  };
}

let msgSeq = 0;
function makeMsg(body: string, overrides: Partial<OnboardingV2InboundMessage> = {}): OnboardingV2InboundMessage {
  return {
    from: '+15551234567',
    body,
    messageSid: `sid-${++msgSeq}`,
    ...overrides,
  };
}

function seedActiveGate(
  gateRepo: ReturnType<typeof createFakeGateRepo>,
  overrides: Partial<WorkerGate> & { userId: string },
): WorkerGate {
  const gate: WorkerGate = {
    lifecycle: 'onboarding',
    runId: `run-${overrides.userId}`,
    workflowVersion: 1,
    currentStepKey: 'profile.name',
    status: 'active',
    preferredLanguage: 'en',
    lockVersion: 0,
    ...overrides,
  };
  gateRepo._gates.set(gate.userId, gate);
  return gate;
}

// ═══════════════════════════════════════════════════════════════════════
// profile.name
// ═══════════════════════════════════════════════════════════════════════

describe('profile.name', () => {
  const acceptedNames = ['Jo', 'Juan Perez', "Mary-Anne O'Brien", 'Jose Maria de la Cruz Hernandez'];

  it.each(acceptedNames)('accepts "%s" and advances to profile.location', async (name) => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: `user-${name}`, currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg(name), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.location' });
    expect(adapters._saveNameCalls).toHaveLength(1);
    expect(adapters._saveNameCalls[0].name).toBe(name.trim());
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('profile.location');
  });

  it.each(['J', 'a'.repeat(101), '   '])('rejects "%s" and reprompts without persisting', async (bad) => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: `user-bad-${bad.length}`, currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg(bad), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.name' });
    expect(adapters._saveNameCalls).toHaveLength(0);
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('profile.name');
  });

  it('reprompts under the 30-second cooldown (no duplicate send on a second invalid input)', async () => {
    const { deps, gateRepo, gateway, clockRef } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-cooldown', currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    await routeOnboardingV2(client, session, makeMsg('J'), deps);
    const firstCount = gateway.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    clockRef.now = new Date(clockRef.now.getTime() + 5000);
    await routeOnboardingV2(client, session, makeMsg('K'), deps);
    expect(gateway.calls.length).toBe(firstCount);

    clockRef.now = new Date(clockRef.now.getTime() + 31000);
    await routeOnboardingV2(client, session, makeMsg('L'), deps);
    expect(gateway.calls.length).toBeGreaterThan(firstCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gate: exact-only blocked-command classification at free-text steps
//
// Regression coverage for the data-integrity bug where typing a reserved
// command word (JOBS/CHATS/PROFILE) at a free-text step got saved as answer
// data, and for the "Chata"/"Perla" false-positive that fuzzy matching would
// have caused if applyGate simply called classifyBlockedCommand everywhere.
// ═══════════════════════════════════════════════════════════════════════

describe('applyGate: exact-only classification at free-text steps', () => {
  it.each(['profile.name', 'profile.custom_trade'] as const)(
    'at %s, an exact blocked command (JOBS) is not persisted as an answer and does not advance',
    async (stepKey) => {
      const { deps, gateRepo, adapters } = makeDeps();
      const gate = seedActiveGate(gateRepo, { userId: `user-blocked-${stepKey}`, currentStepKey: stepKey });
      const session = makeSession({ user_id: gate.userId });

      const result = await routeOnboardingV2(client, session, makeMsg('JOBS'), deps);

      expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey });
      expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe(stepKey);
      expect(adapters._saveNameCalls).toHaveLength(0);
      expect(adapters._saveTradeCalls).toHaveLength(0);
      expect(adapters._saveTrustAnswerCalls).toHaveLength(0);
    },
  );

  it('at profile.name, the legitimate name "Chata" is accepted and saved normally — the regression this design prevents', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-chata', currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('Chata'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.location' });
    expect(adapters._saveNameCalls).toHaveLength(1);
    expect(adapters._saveNameCalls[0].name).toBe('Chata');
  });

  it('at profile.location (a structured step), fuzzy blocked-command matching still applies unchanged: "trabjos" (typo of trabajos/jobs) is blocked, not resolved as a location', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-structured-fuzzy', currentStepKey: 'profile.location' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('trabjos'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.location' });
    expect(adapters._saveLocationCalls).toHaveLength(0);
  });

  it('at profile.name (a free-text step), the same fuzzy typo "trabjos" is NOT caught by the exact-only guard (no fuzzy fallback at free-text steps)', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-freetext-fuzzy', currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('trabjos'), deps);

    // Not blocked by the gate: it falls through to the name answer handler
    // and is treated as ordinary (if odd-looking) free text, exactly as any
    // other non-command name-shaped string would be.
    expect(result.stepKey).not.toBe('profile.name');
    expect(adapters._saveNameCalls).toHaveLength(1);
    expect(adapters._saveNameCalls[0].name).toBe('trabjos');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// profile.location
// ═══════════════════════════════════════════════════════════════════════

describe('profile.location', () => {
  it('a ZIP resolves with source:zip and a null postal is NOT set', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-zip', currentStepKey: 'profile.location' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('78701'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.trade' });
    expect(adapters._saveLocationCalls).toHaveLength(1);
    expect(adapters._saveLocationCalls[0].location).toEqual({
      city: null, state: null, postalCode: '78701', source: 'zip',
    });
  });

  it('a "City, ST" body resolves with source:city_state and a null postal code', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-city', currentStepKey: 'profile.location' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('Austin, TX'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.trade' });
    expect(adapters._saveLocationCalls[0].location).toEqual({
      city: 'Austin', state: 'TX', postalCode: null, source: 'city_state',
    });
  });

  it('unresolvable input reprompts without persisting or advancing', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-badloc', currentStepKey: 'profile.location' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('nowhere'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.location' });
    expect(adapters._saveLocationCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// profile.trade
// ═══════════════════════════════════════════════════════════════════════

describe('profile.trade', () => {
  const standardTrades = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'];

  it.each(standardTrades)('"%s" attaches the standard question set and advances straight to trust.question.1, never calling generate', async (trade) => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: `user-trade-${trade}`, currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg(trade), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.1' });
    expect(adapters._saveTradeCalls[0].trade).toBe(trade);
    expect(session.state_context.v2TrustSource).toBe('standard');
    expect(adapters.trustQuestions.generate).not.toHaveBeenCalled();
  });

  it('accepts a numeric list-picker choice too', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-numeric', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(result.stepKey).toBe('trust.question.1');
    expect(adapters._saveTradeCalls[0].trade).toBe('electrician');
  });

  it('"other" advances to profile.custom_trade without a question set yet', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-other', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('other'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.custom_trade' });
  });

  it('an unrecognized trade reprompts', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-bad', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('astronaut'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.trade' });
  });

  // profile.trade renders V1's approved onboarding_trade_* template, whose
  // taps arrive in V1's payload dialect (profile:main_trade:<trade>, per
  // parseProfilePayloadAnswer in flows.ts). Before this was accepted, every
  // tap on the real template fell through to the reprompt branch and the
  // worker could never get past the trade step using the buttons.
  it('accepts V1\'s profile:main_trade payload from the approved template', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-v1-payload', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(
      client,
      session,
      makeMsg('', { interactivePayload: 'profile:main_trade:plumber' }),
      deps,
    );

    expect(result.stepKey).toBe('trust.question.1');
    expect(adapters._saveTradeCalls[0].trade).toBe('plumber');
  });

  it('accepts V1\'s profile:main_trade payload for "other"', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-v1-other', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(
      client,
      session,
      makeMsg('', { interactivePayload: 'profile:main_trade:other' }),
      deps,
    );

    expect(result.stepKey).toBe('profile.custom_trade');
  });

  it('still accepts the original trade: payload for in-flight sessions', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-legacy-payload', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(
      client,
      session,
      makeMsg('', { interactivePayload: 'trade:carpenter' }),
      deps,
    );

    expect(result.stepKey).toBe('trust.question.1');
    expect(adapters._saveTradeCalls[0].trade).toBe('carpenter');
  });

  it('rejects a well-formed payload naming an unknown trade', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-trade-unknown-payload', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(
      client,
      session,
      makeMsg('', { interactivePayload: 'profile:main_trade:astronaut' }),
      deps,
    );

    expect(result.stepKey).toBe('profile.trade');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// profile.custom_trade
// ═══════════════════════════════════════════════════════════════════════

describe('profile.custom_trade', () => {
  it('rejects an empty profession and reprompts', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-custom-empty', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('   '), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.custom_trade' });
    expect(adapters.trustQuestions.generate).not.toHaveBeenCalled();
  });

  it('3 valid generated questions land on source:generated', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockResolvedValueOnce([
      { q_en: 'Q1 en', q_es: 'Q1 es' },
      { q_en: 'Q2 en', q_es: 'Q2 es' },
      { q_en: 'Q3 en', q_es: 'Q3 es' },
    ]);
    const gate = seedActiveGate(gateRepo, { userId: 'user-custom-generated', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.1' });
    expect(session.state_context.v2TrustSource).toBe('generated');
    expect(session.state_context.v2TrustQuestions).toEqual([
      { en: 'Q1 en', es: 'Q1 es' },
      { en: 'Q2 en', es: 'Q2 es' },
      { en: 'Q3 en', es: 'Q3 es' },
    ]);
  });

  it.each([
    ['null', () => Promise.resolve(null)],
    ['wrong-length', () => Promise.resolve([{ q_en: 'only one', q_es: 'solo una' }])],
    ['throwing', () => Promise.reject(new Error('bedrock down'))],
  ])('generator returning/throwing %s lands on the reviewed bilingual fallback (EN != ES) with source:fallback', async (_label, impl) => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockImplementationOnce(impl as any);
    const gate = seedActiveGate(gateRepo, { userId: `user-custom-${_label}`, currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.1' });
    expect(session.state_context.v2TrustSource).toBe('fallback');
    const questions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
    expect(questions).toHaveLength(3);
    for (const q of questions) {
      expect(q.en).not.toBe(q.es);
    }
  });

  it('generation failure never fails the run (no throw escapes the router)', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockRejectedValueOnce(new Error('bedrock down'));
    const gate = seedActiveGate(gateRepo, { userId: 'user-custom-safe', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    await expect(
      routeOnboardingV2(client, session, makeMsg('dog groomer'), deps),
    ).resolves.toMatchObject({ stepKey: 'trust.question.1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// trust.question.{1,2,3} + atomic readiness
// ═══════════════════════════════════════════════════════════════════════

function seedStandardTrustGate(gateRepo: ReturnType<typeof createFakeGateRepo>, userId: string, stepKey: WorkerGate['currentStepKey']) {
  return seedActiveGate(gateRepo, { userId, currentStepKey: stepKey });
}

describe('trust.question.{1,2,3}', () => {
  it('a standard-trade question accepts a 1-based option index and advances (answer 1 -> 2)', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-1', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('electrician'), deps); // -> trust.question.1, standard

    const result = await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.2' });
    expect(gateRepo._completions).toHaveLength(0);
  });

  it('an invalid option index reprompts trust.question.1', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-invalid', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('electrician'), deps);

    const result = await routeOnboardingV2(client, session, makeMsg('99'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.1' });
  });

  it('answers 1 and 2 do not complete onboarding; answer 3 completes exactly once with all three answers and provenance', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-full', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('plumber'), deps); // -> trust.question.1

    const r1 = await routeOnboardingV2(client, session, makeMsg('1'), deps);
    expect(r1.stepKey).toBe('trust.question.2');
    expect(gateRepo._completions).toHaveLength(0);

    const r2 = await routeOnboardingV2(client, session, makeMsg('2'), deps);
    expect(r2.stepKey).toBe('trust.question.3');
    expect(gateRepo._completions).toHaveLength(0);

    const r3 = await routeOnboardingV2(client, session, makeMsg('1'), deps);
    expect(r3.stepKey).toBe('trust.question.3');
    expect(gateRepo._completions).toHaveLength(1);

    expect(adapters._saveTrustAnswerCalls).toHaveLength(3);
    expect(adapters._saveTrustAnswerCalls.map((c) => c.input.questionIndex)).toEqual([0, 1, 2]);

    const provenance = gateRepo._completions[0].assessmentProvenance;
    expect(provenance).toMatchObject({ trade: 'plumber', source: 'standard' });
    expect(provenance.questionSetVersion).toBeTruthy();
    expect(provenance.rubricVersion).toBeTruthy();

    // `scoring_model_id` is a canonical column another lane (the trust-scorer)
    // owns and populates later — this router must never write to it.
    expect(adapters._saveTrustAnswerCalls[2].input.provenance?.scoringModelId).toBeUndefined();
  });

  it('answer-three persistence and completeOnboarding share the SAME client/transaction, persistence first', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const completeOnboardingSpy = jest.spyOn(gateRepo, 'completeOnboarding');
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-txn', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('carpenter'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);

    await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(adapters._saveTrustAnswerCalls[2].client).toBe(client);
    expect(gateRepo._completionClients[0]).toBe(client);

    // Call ORDER, not just same client: the final saveTrustAnswer must
    // complete before completeOnboarding is invoked (persist-then-complete,
    // never the reverse, on the same transaction).
    const saveOrder = (adapters.profile.saveTrustAnswer as jest.Mock).mock.invocationCallOrder;
    const completeOrder = completeOnboardingSpy.mock.invocationCallOrder;
    expect(saveOrder[saveOrder.length - 1]).toBeLessThan(completeOrder[0]);
  });

  it('readiness is reached with zero assessment results and no ready confirmation is enqueued', async () => {
    const { deps, gateRepo, gateway } = makeDeps();
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-ready', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('concrete'), deps);
    const gatewayCallsBefore = gateway.calls.length;

    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);

    // No template/prompt is sent as a "ready" confirmation by this router.
    const readyCalls = gateway.calls.slice(gatewayCallsBefore).filter((c) => c.sourceType.includes('v2_ready'));
    expect(readyCalls).toHaveLength(0);
  });

  it('a repeated final answer does not complete onboarding twice (idempotency)', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedStandardTrustGate(gateRepo, 'user-trust-repeat', 'profile.trade');
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('painting'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    expect(gateRepo._completions).toHaveLength(1);

    const result = await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(result).toEqual({
      handled: false,
      handoff: 'ready',
      workerId: gate.userId,
      stepKey: 'ready',
    });
    expect(gateRepo._completions).toHaveLength(1);
  });

  it('a generated/fallback question accepts free-text answers (not option indexes)', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockResolvedValueOnce(null); // fallback
    const gate = seedActiveGate(gateRepo, { userId: 'user-trust-freetext', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps); // -> trust.question.1 fallback

    const result = await routeOnboardingV2(client, session, makeMsg('5 years, mostly labradors'), deps);

    expect(result.stepKey).toBe('trust.question.2');
    expect(adapters._saveTrustAnswerCalls[0].input.answerText).toBe('5 years, mostly labradors');
  });

  it('an empty free-text answer on a fallback/generated question reprompts', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockResolvedValueOnce(null);
    const gate = seedActiveGate(gateRepo, { userId: 'user-trust-empty-freetext', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps);

    const result = await routeOnboardingV2(client, session, makeMsg('   '), deps);

    expect(result.stepKey).toBe('trust.question.1');
  });

  it.each(['trust.question.1', 'trust.question.2', 'trust.question.3'] as const)(
    'at %s, an exact blocked command (CHATS) is not persisted as a trust answer and does not advance',
    async (stepKey) => {
      const { deps, gateRepo, adapters } = makeDeps();
      const gate = seedStandardTrustGate(gateRepo, `user-trust-blocked-${stepKey}`, stepKey);
      const session = makeSession({ user_id: gate.userId });

      const result = await routeOnboardingV2(client, session, makeMsg('CHATS'), deps);

      expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey });
      expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe(stepKey);
      expect(adapters._saveTrustAnswerCalls).toHaveLength(0);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════
// Defect 1 — the raw custom trade is persisted, not thrown away
// ═══════════════════════════════════════════════════════════════════════

describe('profile.custom_trade: raw profession persistence (Defect 1)', () => {
  it('persists the raw typed profession via saveCustomTrade (never the old saveTrade(...,"other") call), while the NORMALIZED key still reaches the trust-question lookup', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-custom-raw', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('  Welder  '), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'trust.question.1' });

    // saveCustomTrade received the RAW (trimmed, not normalized) text.
    expect(adapters._saveCustomTradeCalls).toHaveLength(1);
    expect(adapters._saveCustomTradeCalls[0].workerId).toBe(gate.userId);
    expect(adapters._saveCustomTradeCalls[0].rawProfession).toBe('Welder');

    // The old saveTrade(client, workerId, 'other') call is gone for this path.
    expect(adapters._saveTradeCalls).toHaveLength(0);

    // The trust-question lookup still gets the NORMALIZED key.
    expect(session.state_context.v2ProfileTrade).toBe('welder');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Defect 2 — profile sync + fail-closed gate at the pre-trust handoff
// ═══════════════════════════════════════════════════════════════════════

describe('pre-trust profile sync (Defect 2)', () => {
  it('syncs the profile (via syncProfileForTrustHandoff) before advancing a STANDARD trade to trust.question.1', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-sync-standard', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('electrician'), deps);

    expect(result.stepKey).toBe('trust.question.1');
    expect(adapters._syncProfileCalls).toHaveLength(1);
    expect(adapters._syncProfileCalls[0].workerId).toBe(gate.userId);

    // Sync must run BEFORE the advanceWorkflow transition into trust.question.1.
    const syncOrder = (adapters.profile.syncProfileForTrustHandoff as jest.Mock).mock.invocationCallOrder[0];
    const advanceTransition = gateRepo._transitions.find((t: any) => t.toStepKey === 'trust.question.1');
    expect(advanceTransition).toBeDefined();
  });

  it('syncs the profile before advancing a CUSTOM trade to trust.question.1', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-sync-custom', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps);

    expect(result.stepKey).toBe('trust.question.1');
    expect(adapters._syncProfileCalls).toHaveLength(1);
    expect(adapters._syncProfileCalls[0].workerId).toBe(gate.userId);
  });

  it('repeated invocation of the sync point is idempotent: two separate workers each get exactly one sync call for their own transition', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gateA = seedActiveGate(gateRepo, { userId: 'user-sync-idem-a', currentStepKey: 'profile.trade' });
    const sessionA = makeSession({ user_id: gateA.userId });
    const gateB = seedActiveGate(gateRepo, { userId: 'user-sync-idem-b', currentStepKey: 'profile.trade' });
    const sessionB = makeSession({ user_id: gateB.userId });

    await routeOnboardingV2(client, sessionA, makeMsg('plumber'), deps);
    await routeOnboardingV2(client, sessionB, makeMsg('carpenter'), deps);

    expect(adapters._syncProfileCalls.filter((c) => c.workerId === gateA.userId)).toHaveLength(1);
    expect(adapters._syncProfileCalls.filter((c) => c.workerId === gateB.userId)).toHaveLength(1);
  });

  it('fail-closed: when the sync reports a missing required field, the worker does NOT advance to trust.question.1 and a structured OnboardingGateBlocked warning is logged', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.setMissingFields(['availability']);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = seedActiveGate(gateRepo, { userId: 'user-gate-blocked', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('electrician'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.trade' });
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('profile.trade');
    expect(gateRepo._transitions.some((t: any) => t.toStepKey === 'trust.question.1')).toBe(false);

    const logged = warnSpy.mock.calls.map((c) => c[0]).find((s) => String(s).includes('OnboardingGateBlocked'));
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged as string);
    expect(parsed).toMatchObject({ metric: 'OnboardingGateBlocked', stepKey: 'profile.trade', missing: ['availability'] });

    warnSpy.mockRestore();
  });

  it('fail-closed also blocks a CUSTOM trade advance to trust.question.1 when the profile is still incomplete after sync', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.setMissingFields(['skill']);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = seedActiveGate(gateRepo, { userId: 'user-gate-blocked-custom', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.custom_trade' });
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('profile.custom_trade');

    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Defect 3 — trust answers carry scorer-compatible q_en / q_es / answer_source
// ═══════════════════════════════════════════════════════════════════════

describe('trust answers are scorer-compatible (Defect 3)', () => {
  it('a STANDARD trade answer is saved with q_en, q_es, answer_source:"text", and answer_text matching the option chosen', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-qtext-standard', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('electrician'), deps); // -> trust.question.1

    const expectedQuestions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
    await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(adapters._saveTrustAnswerCalls).toHaveLength(1);
    const saved = adapters._saveTrustAnswerCalls[0].input;
    expect(saved.qEn).toBe(expectedQuestions[0].en);
    expect(saved.qEs).toBe(expectedQuestions[0].es);
    expect(saved.answerSource).toBe('text');
    expect(typeof saved.answerText).toBe('string');
    expect(saved.answerText.length).toBeGreaterThan(0);
  });

  it('a CUSTOM trade (fallback) answer is saved with q_en, q_es, answer_source:"text", and the free-text answerText', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    adapters.trustQuestions.generate.mockResolvedValueOnce(null); // -> fallback questions
    const gate = seedActiveGate(gateRepo, { userId: 'user-qtext-custom', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('dog groomer'), deps); // -> trust.question.1

    const expectedQuestions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;
    await routeOnboardingV2(client, session, makeMsg('5 years, mostly labradors'), deps);

    expect(adapters._saveTrustAnswerCalls).toHaveLength(1);
    const saved = adapters._saveTrustAnswerCalls[0].input;
    expect(saved.qEn).toBe(expectedQuestions[0].en);
    expect(saved.qEs).toBe(expectedQuestions[0].es);
    expect(saved.answerSource).toBe('text');
    expect(saved.answerText).toBe('5 years, mostly labradors');
  });

  it('question text advances per-question across all three answers (Q2/Q3 carry their own q_en/q_es, not Q1\'s)', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-qtext-sequence', currentStepKey: 'profile.trade' });
    const session = makeSession({ user_id: gate.userId });
    await routeOnboardingV2(client, session, makeMsg('plumber'), deps);
    const questions = session.state_context.v2TrustQuestions as Array<{ en: string; es: string }>;

    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);
    await routeOnboardingV2(client, session, makeMsg('1'), deps);

    expect(adapters._saveTrustAnswerCalls).toHaveLength(3);
    expect(adapters._saveTrustAnswerCalls.map((c) => c.input.qEn)).toEqual([
      questions[0].en, questions[1].en, questions[2].en,
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// No blocking / processing_ai / media path anywhere in this flow
// ═══════════════════════════════════════════════════════════════════════

describe('non-blocking assessment', () => {
  it('never routes through a processing_ai or media step end-to-end', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-e2e', currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });

    const seen: string[] = [];
    const r1 = await routeOnboardingV2(client, session, makeMsg('Jo'), deps);
    seen.push(r1.stepKey);
    const r2 = await routeOnboardingV2(client, session, makeMsg('78701'), deps);
    seen.push(r2.stepKey);
    const r3 = await routeOnboardingV2(client, session, makeMsg('electrician'), deps);
    seen.push(r3.stepKey);
    const r4 = await routeOnboardingV2(client, session, makeMsg('1'), deps);
    seen.push(r4.stepKey);
    const r5 = await routeOnboardingV2(client, session, makeMsg('1'), deps);
    seen.push(r5.stepKey);
    const r6 = await routeOnboardingV2(client, session, makeMsg('1'), deps);
    seen.push(r6.stepKey);

    expect(seen).not.toContain('processing_ai');
    expect(seen).not.toContain('awaiting_media_photo');
    expect(seen).not.toContain('awaiting_media_voice');
    expect(gateRepo._gates.get(gate.userId)?.status).toBe('completed');
  });
});
