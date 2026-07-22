/**
 * Task 4: Router — Entry, OTP, Legal, and the Authoritative Command Gate.
 *
 * Every dependency is an in-memory fake built in this file: no AWS SDK, no
 * PostgreSQL connection, no jest.useFakeTimers(). The clock is a plain
 * controllable object threaded through `deps.adapters.clock`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { routeOnboardingV2 } from '../../../../lambda/whatsapp/onboarding-v2';
import type {
  OnboardingV2Deps,
  OnboardingV2Session,
  OnboardingV2InboundMessage,
} from '../../../../lambda/whatsapp/onboarding-v2';
import type {
  PreAuthState,
  WorkerGate,
} from '../../../../lambda/whatsapp/lib/onboarding-repository';
import type { WorkerMessageIntentInput } from '../../../../lambda/whatsapp/lib/onboarding-types';

const client = {} as any;

// ── Fake phone hashing (deterministic, no real sha256 needed for tests) ──
function fakeHashNormalizedPhone(phone: string): string {
  return `hash:${phone}`;
}

// ── Fake pre-auth repository (worker_identity_challenges, phone-hash keyed) ──
function createFakePreAuthRepo() {
  const rows = new Map<string, PreAuthState>();
  let seq = 0;

  function defaultRow(phoneHash: string): PreAuthState {
    return {
      challengeId: `chal-${++seq}`,
      phoneHash,
      providerChallengeId: null,
      candidateUserId: null,
      preferredLanguage: 'es',
      currentStepKey: 'start.choose_language',
      context: {},
      status: 'pending',
      attempts: 0,
      expiresAt: null,
      lockedUntil: null,
    };
  }

  const repo = {
    async loadPreAuthStateForUpdate(_client: any, phoneHash: string): Promise<PreAuthState | null> {
      return rows.get(phoneHash) ?? null;
    },
    async savePreAuthState(
      _client: any,
      phoneHash: string,
      patch: Partial<PreAuthState>,
    ): Promise<PreAuthState> {
      const existing = rows.get(phoneHash) ?? defaultRow(phoneHash);
      const updated: PreAuthState = { ...existing, ...patch };
      rows.set(phoneHash, updated);
      return updated;
    },
    _rows: rows,
  };
  return repo;
}

// ── Fake workflow-gate repository (worker_onboarding_state + runs) ──
function createFakeGateRepo() {
  const gates = new Map<string, WorkerGate>();
  const transitions: unknown[] = [];

  const repo = {
    async loadWorkerGate(_client: any, workerId: string): Promise<WorkerGate | null> {
      return gates.get(workerId) ?? null;
    },
    async bindVerifiedIdentityAndStartWorkflow(
      _client: any,
      input: {
        conversationId: string;
        phoneHash: string;
        challengeId: string;
        verifiedWorkerId: string;
        preferredLanguage: 'en' | 'es';
        workflowVersion: number;
        inboundMessageSid: string;
      },
    ): Promise<WorkerGate> {
      const gate: WorkerGate = {
        userId: input.verifiedWorkerId,
        lifecycle: 'onboarding',
        runId: `run-${input.verifiedWorkerId}`,
        workflowVersion: input.workflowVersion,
        currentStepKey: 'legal.review',
        status: 'active',
        preferredLanguage: input.preferredLanguage,
        lockVersion: 0,
      };
      gates.set(input.verifiedWorkerId, gate);
      return gate;
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
    _gates: gates,
    _transitions: transitions,
  };
  return repo;
}

// ── Fake delivery gateway (worker_message_intents / outbox) ──
function createFakeGateway() {
  const calls: WorkerMessageIntentInput[] = [];
  const enqueueWorkerMessage = jest.fn(
    async (_client: any, input: WorkerMessageIntentInput, _now?: Date) => {
      calls.push(input);
      return { intentId: `intent-${calls.length}`, decision: { action: 'allow' as const, reason: 'workflow_message' as const } };
    },
  );
  return { enqueueWorkerMessage, calls };
}

// ── Fake pre-auth delivery gateway (phone/inbound-keyed outbox, no user_id) ──
function createFakePreAuthDelivery() {
  const promptCalls: Array<{ inboundMessageSid: string; to: string; prompt: any }> = [];
  const textCalls: Array<{ inboundMessageSid: string; to: string; body: string }> = [];
  const enqueuePreAuthPrompt = jest.fn(
    async (_client: any, inboundMessageSid: string, to: string, prompt: any) => {
      promptCalls.push({ inboundMessageSid, to, prompt });
    },
  );
  const enqueuePreAuthText = jest.fn(
    async (_client: any, inboundMessageSid: string, to: string, body: string) => {
      textCalls.push({ inboundMessageSid, to, body });
    },
  );
  return { enqueuePreAuthPrompt, enqueuePreAuthText, promptCalls, textCalls };
}

// ── Fake Task 2 adapters ──
function createFakeAdapters(clockRef: { now: Date }) {
  let otpSeq = 0;
  return {
    clock: { now: () => clockRef.now },
    identity: {
      issueChallenge: jest.fn(async (_input: { whatsappNumber: string; lang: 'en' | 'es' }) => ({
        status: 'sent' as const,
        challengeId: `otp-${++otpSeq}`,
        expiresAt: new Date(clockRef.now.getTime() + 5 * 60 * 1000),
      })),
      verifyChallenge: jest.fn(),
    },
    location: { resolve: jest.fn() },
    trustQuestions: { generate: jest.fn() },
    profile: {
      saveName: jest.fn(),
      saveLocation: jest.fn(),
      saveTrade: jest.fn(),
      saveTrustAnswer: jest.fn(),
    },
  };
}

function makeDeps() {
  const clockRef = { now: new Date('2026-01-01T00:00:00.000Z') };
  const preAuthRepo = createFakePreAuthRepo();
  const gateRepo = createFakeGateRepo();
  const gateway = createFakeGateway();
  const preAuthDelivery = createFakePreAuthDelivery();
  const adapters = createFakeAdapters(clockRef);

  const deps: OnboardingV2Deps = {
    adapters: adapters as any,
    repo: {
      loadPreAuthStateForUpdate: (c, phoneHash) => preAuthRepo.loadPreAuthStateForUpdate(c, phoneHash),
      savePreAuthState: (c, phoneHash, patch) => preAuthRepo.savePreAuthState(c, phoneHash, patch),
      bindVerifiedIdentityAndStartWorkflow: (c, input) => gateRepo.bindVerifiedIdentityAndStartWorkflow(c, input),
      loadWorkerGate: (c, workerId) => gateRepo.loadWorkerGate(c, workerId),
      advanceWorkflow: (c, input) => gateRepo.advanceWorkflow(c, input),
      appendTransition: (c, input) => gateRepo.appendTransition(c, input),
    },
    enqueueWorkerMessage: gateway.enqueueWorkerMessage,
    enqueuePreAuthPrompt: preAuthDelivery.enqueuePreAuthPrompt,
    enqueuePreAuthText: preAuthDelivery.enqueuePreAuthText,
    hashNormalizedPhone: fakeHashNormalizedPhone,
    tosUrl: 'https://jale.example/tos',
    privacyUrl: 'https://jale.example/privacy',
    workflowVersion: 1,
  };

  return { deps, preAuthRepo, gateRepo, gateway, preAuthDelivery, adapters, clockRef };
}

function makeSession(overrides: Partial<OnboardingV2Session> = {}): OnboardingV2Session {
  return {
    id: 'conv-1',
    user_id: null,
    whatsapp_number: '+15551234567',
    language: 'es',
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
    currentStepKey: 'legal.review',
    status: 'active',
    preferredLanguage: 'en',
    lockVersion: 0,
    ...overrides,
  };
  gateRepo._gates.set(gate.userId, gate);
  return gate;
}

async function bootstrapOtp(
  deps: OnboardingV2Deps,
  session: OnboardingV2Session,
  lang: 'en' | 'es' = 'en',
): Promise<void> {
  const body = lang === 'en' ? 'START' : 'EMPEZAR';
  await routeOnboardingV2(client, session, makeMsg(body), deps);
}

function warnedMetrics(spy: jest.SpyInstance): any[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(call[0] as string);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ── pre-auth delivery: the net-new unbound worker (Design A regression) ──
//
// A first inbound from a phone with NO users row, NO candidate, and NO
// pre-auth challenge is the exact shape v2 exists to onboard. Its prompts
// have no user_id and MUST NOT be dropped or routed through the user-bound
// intent gateway. This is the failing case the WIP router silently swallowed.

describe('pre-auth delivery for a genuinely unbound (net-new) worker', () => {
  it('delivers the start invitation via the phone-keyed pre-auth gateway — never dropped, never a user-bound intent', async () => {
    const { deps, preAuthDelivery, gateway, gateRepo } = makeDeps();
    // No account, no candidate, no pre-auth row.
    const session = makeSession({ user_id: null });

    const result = await routeOnboardingV2(client, session, makeMsg('hi'), deps);

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'start.choose_language' });
    // The invitation actually goes out — through the pre-auth gateway.
    expect(preAuthDelivery.promptCalls).toHaveLength(1);
    expect(preAuthDelivery.promptCalls[0].to).toBe(session.whatsapp_number);
    // It is NOT routed through the user-bound intent gateway.
    expect(gateway.calls).toHaveLength(0);
    // No identity was created or bound.
    expect(gateRepo._gates.size).toBe(0);
  });

  it('delivers the OTP prompt for an unbound worker after a language choice, via the pre-auth gateway', async () => {
    const { deps, preAuthDelivery, gateway } = makeDeps();
    const session = makeSession({ user_id: null });

    await routeOnboardingV2(client, session, makeMsg('START'), deps);

    // start invitation was NOT needed (language chosen); OTP prompt is delivered.
    expect(preAuthDelivery.promptCalls.length).toBeGreaterThanOrEqual(1);
    // Still no user-bound intent for a pre-auth send.
    expect(gateway.calls).toHaveLength(0);
  });

  it('delivers an invalid-code reply for an unbound worker via the pre-auth text gateway', async () => {
    const { deps, preAuthDelivery, gateway, adapters } = makeDeps();
    const session = makeSession({ user_id: null });
    await routeOnboardingV2(client, session, makeMsg('START'), deps);
    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'invalid', attemptsRemaining: 2, attempts: 1,
    });

    await routeOnboardingV2(client, session, makeMsg('000000'), deps);

    expect(preAuthDelivery.textCalls.length).toBeGreaterThanOrEqual(1);
    expect(gateway.calls).toHaveLength(0);
  });
});

// ── start.choose_language ──────────────────────────────────────────────

describe('start.choose_language', () => {
  it('a language choice persists preference, issues a challenge, and advances the step in ONE savePreAuthState call, with workerId null', async () => {
    const { deps, preAuthRepo, gateway, preAuthDelivery } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });
    const saveSpy = jest.spyOn(preAuthRepo, 'savePreAuthState');

    const result = await routeOnboardingV2(client, session, makeMsg('START'), deps);

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const patch = saveSpy.mock.calls[0][2] as Partial<PreAuthState>;
    expect(patch.preferredLanguage).toBe('en');
    expect(patch.currentStepKey).toBe('identity.verify_otp');
    expect(patch.providerChallengeId).toBeTruthy();
    expect(patch.expiresAt).toBeTruthy();

    // The OTP prompt is a pre-auth (unbound) send: it goes through the
    // phone-keyed pre-auth gateway, NOT the user-bound intent gateway.
    expect(preAuthDelivery.promptCalls).toHaveLength(1);
    expect(gateway.calls).toHaveLength(0);
  });

  it('creates no account, lifecycle row, or workflow run — workerId stays null throughout', async () => {
    const { deps, gateRepo } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });

    await routeOnboardingV2(client, session, makeMsg('START'), deps);

    expect(gateRepo._gates.size).toBe(0);
  });

  it('rate-limits the start invitation: cooldown blocks a resend, then the 24h daily cap blocks the 6th', async () => {
    const { deps, preAuthDelivery, clockRef } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });

    await routeOnboardingV2(client, session, makeMsg('hi'), deps);
    expect(preAuthDelivery.promptCalls).toHaveLength(1);

    clockRef.now = new Date(clockRef.now.getTime() + 2 * 60 * 1000);
    await routeOnboardingV2(client, session, makeMsg('hi'), deps);
    expect(preAuthDelivery.promptCalls).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      clockRef.now = new Date(clockRef.now.getTime() + 11 * 60 * 1000);
      await routeOnboardingV2(client, session, makeMsg('hi'), deps);
    }
    expect(preAuthDelivery.promptCalls).toHaveLength(5);

    clockRef.now = new Date(clockRef.now.getTime() + 11 * 60 * 1000);
    await routeOnboardingV2(client, session, makeMsg('hi'), deps);
    expect(preAuthDelivery.promptCalls).toHaveLength(5);
  });

  it('delivers the invitation through the phone-keyed pre-auth gateway, never a user-bound intent', async () => {
    const { deps, gateway, preAuthDelivery } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });

    await routeOnboardingV2(client, session, makeMsg('hi'), deps);

    expect(preAuthDelivery.promptCalls).toHaveLength(1);
    expect(gateway.calls).toHaveLength(0);
  });
});

// ── identity.verify_otp ──────────────────────────────────────────────

describe('identity.verify_otp', () => {
  it('a correct code verifies and binds identity, starting the workflow at legal.review', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });
    await bootstrapOtp(deps, session);
    const bindSpy = jest.spyOn(gateRepo, 'bindVerifiedIdentityAndStartWorkflow');
    adapters.identity.verifyChallenge.mockResolvedValueOnce({ status: 'verified', workerId: 'user-1' });

    const result = await routeOnboardingV2(client, session, makeMsg('123456'), deps);

    expect(result).toEqual({ handled: true, workerId: 'user-1', stepKey: 'legal.review' });
    expect(bindSpy).toHaveBeenCalledTimes(1);
  });

  it('an invalid code returns invalid and persists the RETURNED attempts count', async () => {
    const { deps, preAuthRepo, adapters } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });
    await bootstrapOtp(deps, session);
    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'invalid',
      attemptsRemaining: 2,
      attempts: 1,
    });
    const saveSpy = jest.spyOn(preAuthRepo, 'savePreAuthState');

    const result = await routeOnboardingV2(client, session, makeMsg('000000'), deps);

    expect(result).toEqual({ handled: true, workerId: null, stepKey: 'identity.verify_otp' });
    const attemptsPatch = saveSpy.mock.calls.map((c) => c[2] as Partial<PreAuthState>)
      .find((p) => 'attempts' in p);
    expect(attemptsPatch?.attempts).toBe(1);
  });

  it('three wrong attempts fire the lock log exactly once, with no OTP/phone/body, and a further attempt during the lock logs nothing new', async () => {
    const { deps, adapters, clockRef } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });
    await bootstrapOtp(deps, session);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    adapters.identity.verifyChallenge.mockResolvedValueOnce({ status: 'invalid', attemptsRemaining: 1, attempts: 1 });
    await routeOnboardingV2(client, session, makeMsg('111111'), deps);

    adapters.identity.verifyChallenge.mockResolvedValueOnce({ status: 'invalid', attemptsRemaining: 0, attempts: 2 });
    await routeOnboardingV2(client, session, makeMsg('222222'), deps);

    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'locked',
      lockedUntil: new Date(clockRef.now.getTime() + 15 * 60 * 1000),
    });
    await routeOnboardingV2(client, session, makeMsg('333333'), deps);

    const lockLogs = warnedMetrics(warnSpy).filter((m) => m.metric === 'WhatsAppOtpLock');
    expect(lockLogs).toHaveLength(1);
    const serialized = JSON.stringify(lockLogs[0]);
    expect(serialized).not.toMatch(/333333|111111|222222/);
    expect(serialized).not.toMatch(/\+1555/);
    expect(lockLogs[0]).toMatchObject({ metric: 'WhatsAppOtpLock', lockMinutes: 15 });

    warnSpy.mockClear();
    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'locked',
      lockedUntil: new Date(clockRef.now.getTime() + 14 * 60 * 1000),
    });
    await routeOnboardingV2(client, session, makeMsg('444444'), deps);

    const secondLockLogs = warnedMetrics(warnSpy).filter((m) => m.metric === 'WhatsAppOtpLock');
    expect(secondLockLogs).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('a phone tied to an existing worker still ends the OTP step unbound on a wrong code', async () => {
    const { deps, gateRepo, adapters } = makeDeps();
    const session = makeSession({ user_id: 'existing-user-1' });
    gateRepo._gates.set('existing-user-1', {
      userId: 'existing-user-1',
      lifecycle: 'ready',
      runId: null,
      workflowVersion: null,
      currentStepKey: null,
      status: null,
      preferredLanguage: 'en',
      lockVersion: null,
    });
    await bootstrapOtp(deps, session);
    const bindSpy = jest.spyOn(gateRepo, 'bindVerifiedIdentityAndStartWorkflow');
    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'invalid',
      attemptsRemaining: 2,
      attempts: 1,
    });

    const result = await routeOnboardingV2(client, session, makeMsg('000000'), deps);

    expect(result.workerId).toBeNull();
    expect(result.stepKey).toBe('identity.verify_otp');
    expect(bindSpy).not.toHaveBeenCalled();
    expect(gateRepo._gates.get('existing-user-1')?.runId).toBeNull();
  });

  it('binds identity ONLY on the verified branch — never on invalid, expired, or locked', async () => {
    const { deps, gateRepo, adapters, clockRef } = makeDeps();
    const session = makeSession({ user_id: 'user-1' });
    await bootstrapOtp(deps, session);
    const bindSpy = jest.spyOn(gateRepo, 'bindVerifiedIdentityAndStartWorkflow');

    adapters.identity.verifyChallenge.mockResolvedValueOnce({ status: 'invalid', attemptsRemaining: 2, attempts: 1 });
    await routeOnboardingV2(client, session, makeMsg('111111'), deps);

    adapters.identity.verifyChallenge.mockResolvedValueOnce({ status: 'expired' });
    await routeOnboardingV2(client, session, makeMsg('222222'), deps);

    adapters.identity.verifyChallenge.mockResolvedValueOnce({
      status: 'locked',
      lockedUntil: new Date(clockRef.now.getTime() + 15 * 60 * 1000),
    });
    await routeOnboardingV2(client, session, makeMsg('333333'), deps);

    expect(bindSpy).not.toHaveBeenCalled();
  });
});

// ── legal.review ──────────────────────────────────────────────────────

describe('legal.review', () => {
  it('Accept advances to profile.name', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-legal-accept' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('ACCEPT'), deps);

    expect(result).toEqual({ handled: true, workerId: gate.userId, stepKey: 'profile.name' });
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('profile.name');
  });

  it('Decline sets status declined while currentStepKey stays legal.review', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-legal-decline' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('DECLINE'), deps);

    expect(result.stepKey).toBe('legal.review');
    const updated = gateRepo._gates.get(gate.userId);
    expect(updated?.status).toBe('declined');
    expect(updated?.currentStepKey).toBe('legal.review');
  });

  it('Review Terms stays on the step and resends the legal prompt', async () => {
    const { deps, gateRepo, gateway } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-legal-review' });
    const session = makeSession({ user_id: gate.userId });

    const result = await routeOnboardingV2(client, session, makeMsg('REVIEW TERMS'), deps);

    expect(result.stepKey).toBe('legal.review');
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('legal.review');
    expect(gateway.calls.length).toBeGreaterThan(0);
  });
});

// ── Command gate ──────────────────────────────────────────────────────

describe('command gate', () => {
  const blockedCommands = ['JOBS', 'TRABAJOS', 'CHATS', 'MENSAJES', 'PROFILE', 'PERFIL'];

  it.each(blockedCommands)('blocks the "%s" command before it reaches a step handler', async (cmd) => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: `user-${cmd}` });
    const session = makeSession({ user_id: gate.userId });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await routeOnboardingV2(client, session, makeMsg(cmd), deps);

    expect(result.stepKey).toBe('legal.review');
    expect(gateRepo._gates.get(gate.userId)?.currentStepKey).toBe('legal.review');
    const blockedLogs = warnedMetrics(warnSpy).filter((m) => m.metric === 'OnboardingGateBlocked');
    expect(blockedLogs).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('logs OnboardingGateBlocked with the command family and step key', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-log-fields' });
    const session = makeSession({ user_id: gate.userId });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await routeOnboardingV2(client, session, makeMsg('JOBS'), deps);

    const blockedLog = warnedMetrics(warnSpy).find((m) => m.metric === 'OnboardingGateBlocked');
    expect(blockedLog).toMatchObject({ metric: 'OnboardingGateBlocked', command: 'jobs', stepKey: 'legal.review' });

    warnSpy.mockRestore();
  });

  it('answers a command typed in the non-preferred language in that command language', async () => {
    const { deps, gateRepo, gateway } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-cross-lang', preferredLanguage: 'en' });
    const session = makeSession({ user_id: gate.userId });

    await routeOnboardingV2(client, session, makeMsg('TRABAJOS'), deps);

    const replyCall = gateway.calls.find((c) => c.sourceType.includes('v2_gate_blocked'));
    expect(replyCall?.payload.lang).toBe('es');
  });

  it('does NOT treat the name "Chata" as the CHATS command at profile.name', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-chata', currentStepKey: 'profile.name' });
    const session = makeSession({ user_id: gate.userId });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await routeOnboardingV2(client, session, makeMsg('Chata'), deps);

    expect(result.stepKey).toBe('profile.name');
    const blockedLog = warnedMetrics(warnSpy).find((m) => m.metric === 'OnboardingGateBlocked');
    expect(blockedLog).toBeTruthy();
    expect(blockedLog.command).not.toBe('chats');

    warnSpy.mockRestore();
  });

  it('does NOT treat the name "Mensaje" as the CHATS/MENSAJES command at profile.custom_trade', async () => {
    const { deps, gateRepo } = makeDeps();
    const gate = seedActiveGate(gateRepo, { userId: 'user-mensaje', currentStepKey: 'profile.custom_trade' });
    const session = makeSession({ user_id: gate.userId });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await routeOnboardingV2(client, session, makeMsg('Mensaje'), deps);

    const blockedLog = warnedMetrics(warnSpy).find((m) => m.metric === 'OnboardingGateBlocked');
    expect(blockedLog?.command).not.toBe('chats');

    warnSpy.mockRestore();
  });
});

// ── Sending discipline ────────────────────────────────────────────────

describe('sending discipline', () => {
  it('pre-auth sends use the phone-keyed gateway; only bound-step sends use the user-bound intent gateway (with the correct ownerService)', async () => {
    const { deps, gateway, preAuthDelivery, gateRepo } = makeDeps();

    // Pre-auth invitation and OTP prompt: no user_id, phone-keyed gateway only.
    await routeOnboardingV2(client, makeSession({ user_id: 'user-a' }), makeMsg('hi'), deps);
    await routeOnboardingV2(client, makeSession({ user_id: 'user-a' }), makeMsg('START'), deps);
    expect(preAuthDelivery.promptCalls.length).toBeGreaterThanOrEqual(2);
    expect(gateway.calls).toHaveLength(0);

    // Bound step (legal.review): the reply is a worker-directed intent.
    const gate = seedActiveGate(gateRepo, { userId: 'user-b' });
    await routeOnboardingV2(client, makeSession({ user_id: gate.userId }), makeMsg('REVIEW TERMS'), deps);

    expect(gateway.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of gateway.calls) {
      expect(['onboarding-v2', 'identity']).toContain(call.ownerService);
      if (call.ownerService === 'identity') expect(call.category).toBe('security');
      if (call.ownerService === 'onboarding-v2') expect(call.category).toBe('onboarding');
    }
  });

  it('never writes the outbox table directly nor calls a legacy send helper (delivery only through injected deps)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../lambda/whatsapp/onboarding-v2.ts'),
      'utf8',
    );
    // Direct call/write forms — doc comments naming the injected writers are fine.
    expect(src).not.toMatch(/\bqueueOutboxText\(|\bqueueInteractivePrompt\(|\bqueueText\(/);
    expect(src).not.toMatch(/INSERT\s+INTO\s+whatsapp_outbox/i);
    expect(src).not.toMatch(/from ['"]\.\/lib\/outbox['"]/);
  });
});

// ── profile/trust stub ────────────────────────────────────────────────

describe('profile/trust steps (Task 5 stub)', () => {
  it('the gate consumes every message at profile/trust steps so the stub is never reached', async () => {
    const { deps, gateRepo } = makeDeps();
    const steps: Array<WorkerGate['currentStepKey']> = [
      'profile.name',
      'profile.location',
      'profile.trade',
      'profile.custom_trade',
      'trust.question.1',
      'trust.question.2',
      'trust.question.3',
    ];
    for (const stepKey of steps) {
      const gate = seedActiveGate(gateRepo, { userId: `user-${stepKey}`, currentStepKey: stepKey });
      const session = makeSession({ user_id: gate.userId });
      await expect(
        routeOnboardingV2(client, session, makeMsg('some free text'), deps),
      ).resolves.toMatchObject({ handled: true, stepKey });
    }
  });
});
