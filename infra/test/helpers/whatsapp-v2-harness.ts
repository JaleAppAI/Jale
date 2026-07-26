/**
 * Task 7: Deterministic Conversation Testbed for the WhatsApp v2 onboarding
 * lane.
 *
 * This module is NOT a `.test.ts` and lives outside `roots:
 * ['<rootDir>/test/unit']` (see `infra/jest.config.js`), so Jest never
 * collects it as a suite — it is only ever `import`ed by
 * `test/unit/lambda/whatsapp/onboarding-v2-conversation.test.ts`, which
 * ts-jest resolves via the relative path at compile time.
 *
 * Everything here is an in-memory fake wired to the REAL `routeOnboardingV2`
 * router plus the REAL, pure decision/render functions this lane ships
 * (`evaluateDelivery`, `createLocationResolver`, `createReleaseRenderer`).
 * No AWS SDK client, no PostgreSQL connection, and — critically —
 * `jest.useFakeTimers()` is NEVER used: the clock is a single plain mutable
 * object (`{ now: Date }`) threaded through `deps.adapters.clock`, advanced
 * only by `advanceTime()`.
 *
 * Two modeling requirements drove this design (see the module docs on
 * `routeOnboardingV2` in `../../lambda/whatsapp/onboarding-v2.ts` and the
 * v2 branch added to `processor.ts`'s `routeMessage` in Task 6):
 *
 *   1. `state_context` durability — the processor persists
 *      `whatsapp_conversations.state_context` back to the DB after every
 *      turn, in the SAME transaction, and reloads it on the next inbound
 *      message. This harness's `routeTurn` mirrors that write-back exactly:
 *      it JSON round-trips `state_context` OUT of the persisted
 *      conversation row before the call and back IN after, so a router bug
 *      that silently relies on in-memory object identity (rather than the
 *      contents actually surviving a serialize/deserialize round trip)
 *      would be caught here.
 *
 *   2. `user_id` binding across turns — `routeOnboardingV2` itself never
 *      mutates `session.user_id`; production binds it via the SECURITY
 *      DEFINER `bind_verified_identity_and_start_workflow(...)` function,
 *      keyed by `conversationId`, called from
 *      `bindVerifiedIdentityAndStartWorkflow`. The fake gate repo below
 *      mirrors that exact side effect: on a verified OTP it looks up the
 *      persisted conversation by `input.conversationId` and sets its
 *      `user_id` directly, so the NEXT turn's `session.user_id` is already
 *      bound — exactly like a fresh `SELECT * FROM whatsapp_conversations`
 *      would return after a real bind.
 *
 * Business-message deferral is modeled with the REAL `evaluateDelivery`
 * (delivery-policy.ts) — not a hand-coded pass/fail — wired into the same
 * fake `enqueueWorkerMessage` the router itself calls for onboarding/
 * security sends. `injectEmployerMessage`/`injectJobAlert` call the exact
 * same function with a business category, so a `defer` decision is
 * authentic, not asserted against a fake that always agrees with the test.
 */

import type { PoolClient } from 'pg';
import {
  routeOnboardingV2,
  type OnboardingV2Deps,
  type OnboardingV2Session,
  type OnboardingV2InboundMessage,
  type RouteResult,
} from '../../lambda/whatsapp/onboarding-v2';
import type { PreAuthState, WorkerGate } from '../../lambda/whatsapp/lib/onboarding-repository';
import type {
  WorkerMessageIntentInput,
  WorkflowStepKey,
  MessageCategory,
  OwnerService,
  DeliveryDecision,
  PreferredLanguage,
} from '../../lambda/whatsapp/lib/onboarding-types';
import { evaluateDelivery } from '../../lambda/whatsapp/lib/delivery-policy';
import type { RuntimeControls } from '../../lambda/whatsapp/lib/runtime-controls';
import { createLocationResolver } from '../../lambda/whatsapp/lib/onboarding-adapters';

// The shared client marker is never actually queried against — every fake
// below is a plain in-memory structure — but it IS the value threaded
// through every call site, so a suite can assert (as the profile suite
// does) that the answer-three persistence and `completeOnboarding` share
// the exact same object.
export const HARNESS_CLIENT = { marker: 'whatsapp-v2-conversation-harness' } as unknown as PoolClient;

// ── Small deterministic helpers (no Date.now(), no Math.random()) ──────

let sidSeq = 0;
function nextSid(prefix: string): string {
  sidSeq += 1;
  return `${prefix}-${sidSeq}`;
}

let workerSeq = 0;
function nextWorkerId(): string {
  workerSeq += 1;
  return `worker-${workerSeq}`;
}

/** Deep, JSON-safe round trip — mirrors a real DB JSONB column write + read. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Fake pre-auth repository (worker_identity_challenges, phone-hash keyed) ──

function createFakePreAuthRepo() {
  const rows = new Map<string, PreAuthState>();
  let seq = 0;

  function defaultRow(phoneHash: string): PreAuthState {
    seq += 1;
    return {
      challengeId: `chal-${seq}`,
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

  return {
    async loadPreAuthStateForUpdate(_client: PoolClient, phoneHash: string): Promise<PreAuthState | null> {
      return rows.get(phoneHash) ?? null;
    },
    async savePreAuthState(
      _client: PoolClient,
      phoneHash: string,
      patch: Partial<PreAuthState>,
    ): Promise<PreAuthState> {
      const existing = rows.get(phoneHash) ?? defaultRow(phoneHash);
      const updated: PreAuthState = { ...existing, ...patch };
      rows.set(phoneHash, updated);
      return updated;
    },
    _rows: rows,
    _seedCandidate(phoneHash: string, candidateUserId: string): void {
      const existing = rows.get(phoneHash) ?? defaultRow(phoneHash);
      rows.set(phoneHash, { ...existing, candidateUserId });
    },
  };
}

// ── Fake conversations store (whatsapp_conversations, phone/id keyed) ───
//
// One row per phone. `bindVerifiedIdentityAndStartWorkflow` writes
// `user_id` here directly (mirrors the SECURITY DEFINER function's actual
// side effect against the real table), keyed by `conversationId` — never
// by anything the router itself controls.

interface ConversationRow {
  id: string;
  whatsapp_number: string;
  user_id: string | null;
  language: PreferredLanguage;
  conversation_state: string;
  state_context: Record<string, unknown>;
}

function createFakeConversationsStore() {
  const byId = new Map<string, ConversationRow>();

  return {
    ensure(conversationId: string, whatsappNumber: string): ConversationRow {
      let row = byId.get(conversationId);
      if (!row) {
        row = {
          id: conversationId,
          whatsapp_number: whatsappNumber,
          user_id: null,
          language: 'es',
          conversation_state: 'onboarding_v2',
          state_context: {},
        };
        byId.set(conversationId, row);
      }
      return row;
    },
    bindUserId(conversationId: string, userId: string): void {
      const row = byId.get(conversationId);
      if (row) row.user_id = userId;
    },
    _byId: byId,
  };
}

// ── Fake gate repository (worker_onboarding_state + worker_workflow_runs) ──

interface TransitionRecord {
  runId: string;
  fromStepKey: WorkflowStepKey | null;
  toStepKey: WorkflowStepKey;
  status?: string;
  inboundMessageSid: string | null;
  reason: string;
}

interface CompletionRecord {
  workerId: string;
  runId: string;
  expectedLockVersion: number;
  assessmentProvenance: Record<string, unknown>;
}

function createFakeGateRepo(conversations: ReturnType<typeof createFakeConversationsStore>) {
  const gates = new Map<string, WorkerGate>();
  const transitions: TransitionRecord[] = [];
  const completions: CompletionRecord[] = [];
  const completionClients: unknown[] = [];

  return {
    async loadWorkerGate(_client: PoolClient, workerId: string): Promise<WorkerGate | null> {
      return gates.get(workerId) ?? null;
    },
    async bindVerifiedIdentityAndStartWorkflow(
      _client: PoolClient,
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
      // The one and only place `user_id` is ever attached to a conversation
      // — mirrors `bind_verified_identity_and_start_workflow`'s real effect.
      conversations.bindUserId(input.conversationId, input.verifiedWorkerId);

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
      transitions.push({
        runId: gate.runId!,
        fromStepKey: null,
        toStepKey: 'legal.review',
        inboundMessageSid: input.inboundMessageSid,
        reason: 'otp_verified',
      });
      return gate;
    },
    async advanceWorkflow(
      _client: PoolClient,
      input: {
        runId: string;
        expectedLockVersion: number;
        fromStepKey: WorkflowStepKey;
        toStepKey: WorkflowStepKey;
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
        currentStepKey: input.toStepKey,
        status: (input.status as WorkerGate['status']) ?? found.status,
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      transitions.push({
        runId: input.runId,
        fromStepKey: input.fromStepKey,
        toStepKey: input.toStepKey,
        status: input.status,
        inboundMessageSid: input.inboundMessageSid,
        reason: input.reason,
      });
      return updated;
    },
    async setRunPreferredLanguage(_client: PoolClient, input: { runId: string; expectedLockVersion: number; preferredLanguage: PreferredLanguage }): Promise<WorkerGate> {
      let found: WorkerGate | undefined;
      for (const gate of gates.values()) {
        if (gate.runId === input.runId) found = gate;
      }
      if (!found || found.status !== 'active' || found.lockVersion !== input.expectedLockVersion) {
        throw new Error('workflow_lock_conflict');
      }
      const updated: WorkerGate = {
        ...found,
        preferredLanguage: input.preferredLanguage,
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      return updated;
    },
    async reactivateDeclinedLegalRun(_client: PoolClient, input: { runId: string; expectedLockVersion: number }): Promise<WorkerGate> {
      let found: WorkerGate | undefined;
      for (const gate of gates.values()) {
        if (gate.runId === input.runId) found = gate;
      }
      if (!found || found.status !== 'declined' || found.currentStepKey !== 'legal.review' || found.lockVersion !== input.expectedLockVersion) {
        throw new Error('workflow_lock_conflict');
      }
      const updated: WorkerGate = {
        ...found,
        status: 'active',
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      return updated;
    },
    async appendTransition(
      _client: PoolClient,
      input: {
        runId: string;
        fromStepKey: WorkflowStepKey | null;
        toStepKey: WorkflowStepKey;
        inboundMessageSid: string | null;
        reason: string;
      },
    ): Promise<{ transitionId: string }> {
      transitions.push({
        runId: input.runId,
        fromStepKey: input.fromStepKey,
        toStepKey: input.toStepKey,
        inboundMessageSid: input.inboundMessageSid,
        reason: input.reason,
      });
      return { transitionId: `t-${transitions.length}` };
    },
    async completeOnboarding(
      client: PoolClient,
      input: {
        workerId: string;
        runId: string;
        expectedLockVersion: number;
        assessmentProvenance: Record<string, unknown>;
      },
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
      completionClients.push(client);
      // Mirrors the real `completeOnboarding`'s two writes exactly:
      // `worker_onboarding_state.lifecycle` flips to 'ready' AND the run's
      // status becomes 'completed' — both in the same call.
      const updated: WorkerGate = {
        ...found,
        lifecycle: 'ready',
        status: 'completed',
        lockVersion: (found.lockVersion ?? 0) + 1,
      };
      gates.set(updated.userId, updated);
      return {
        assessmentEventId: `assessment-${completions.length}`,
        workerReadyEventId: `ready-${completions.length}`,
      };
    },
    _gates: gates,
    _transitions: transitions,
    _completions: completions,
    _completionClients: completionClients,
  };
}

// ── Fake worker-directed delivery gateway — REAL evaluateDelivery ──────
//
// Every send this router itself produces (category 'onboarding'/'security')
// is unconditionally allowed by evaluateDelivery regardless of lifecycle —
// so routing this through the real function costs nothing for the normal
// conversation flow, and buys authenticity for the one case that matters:
// business categories ('job_alert' / 'employer_chat' / 'account') hitting
// an onboarding-lifecycle worker must genuinely `defer`.

interface RecordedIntent {
  input: WorkerMessageIntentInput;
  decision: DeliveryDecision;
}

const DEFAULT_CONTROLS: RuntimeControls = {
  onboardingV2Enabled: true,
  onboardingV2GlobalEnabled: true,
  onboardingV2PhoneHashes: new Set<string>(),
  deferredDeliveryEnabled: true,
};

function createFakeWorkerGateway(gateRepo: ReturnType<typeof createFakeGateRepo>) {
  const intents: RecordedIntent[] = [];
  const allowed: WorkerMessageIntentInput[] = [];

  async function enqueueWorkerMessage(
    _client: PoolClient,
    input: WorkerMessageIntentInput,
    now: Date = new Date(),
  ): Promise<{ intentId: string; decision: DeliveryDecision; outboxMaterialized: boolean }> {
    const gate = gateRepo._gates.get(input.workerId) ?? null;
    const decision = evaluateDelivery(
      {
        lifecycle: gate?.lifecycle ?? 'onboarding',
        category: input.category,
        ownerService: input.ownerService,
        controls: DEFAULT_CONTROLS,
        expiresAt: input.expiresAt,
      },
      now,
    );
    intents.push({ input, decision });
    if (decision.action === 'allow') allowed.push(input);
    return { intentId: `intent-${intents.length}`, decision, outboxMaterialized: true };
  }

  return { enqueueWorkerMessage, intents, allowed };
}

// ── Fake pre-auth delivery gateway (phone/inbound-keyed outbox, no user_id) ──

interface RecordedPreAuthPrompt {
  inboundMessageSid: string;
  to: string;
  prompt: { templateName: string; variables: Record<string, string>; fallbackBody: string };
}
interface RecordedPreAuthText {
  inboundMessageSid: string;
  to: string;
  body: string;
}

function createFakePreAuthDelivery() {
  const prompts: RecordedPreAuthPrompt[] = [];
  const texts: RecordedPreAuthText[] = [];

  async function enqueuePreAuthPrompt(
    _client: PoolClient,
    inboundMessageSid: string,
    to: string,
    prompt: RecordedPreAuthPrompt['prompt'],
  ): Promise<void> {
    prompts.push({ inboundMessageSid, to, prompt });
  }

  async function enqueuePreAuthText(
    _client: PoolClient,
    inboundMessageSid: string,
    to: string,
    body: string,
  ): Promise<void> {
    texts.push({ inboundMessageSid, to, body });
  }

  return { enqueuePreAuthPrompt, enqueuePreAuthText, prompts, texts };
}

// ── Fake identity adapter — deterministic code, supersede-on-resend,
//    expiry/lock/cap enforced exactly as the real Cognito adapter's
//    contract requires (see onboarding-adapters.ts's IdentityAdapter). ──

interface FakeChallenge {
  code: string;
  expiresAt: Date;
}

function createFakeIdentity(clockRef: { now: Date }) {
  let codeSeq = 0;
  const challenges = new Map<string, FakeChallenge>();
  // Seeded (or learned) phone -> workerId map, mirroring reconcileUserRow's
  // idempotent phone->account resolution. A phone with no prior entry gets
  // a freshly minted worker id on first successful verification — same
  // shape as a real net-new Cognito reconciliation.
  const phoneToWorkerId = new Map<string, string>();

  return {
    identity: {
      async issueChallenge(input: { whatsappNumber: string; lang: PreferredLanguage }) {
        codeSeq += 1;
        const code = String(100000 + codeSeq).padStart(6, '0');
        const challengeId = `chal-otp-${codeSeq}`;
        const expiresAt = new Date(clockRef.now.getTime() + 5 * 60 * 1000);
        challenges.set(challengeId, { code, expiresAt });
        return { status: 'sent' as const, challengeId, expiresAt };
      },
      async verifyChallenge(
        _client: PoolClient,
        input: {
          challengeId: string;
          whatsappNumber: string;
          code: string;
          attempts: number;
          lockedUntil: Date | null;
        },
      ) {
        const now = clockRef.now;
        if (input.lockedUntil && input.lockedUntil.getTime() > now.getTime()) {
          return { status: 'locked' as const, lockedUntil: input.lockedUntil };
        }
        const challenge = challenges.get(input.challengeId);
        if (!challenge) {
          return { status: 'expired' as const };
        }
        if (now.getTime() > challenge.expiresAt.getTime()) {
          return { status: 'expired' as const };
        }
        if (input.code !== challenge.code) {
          const newCount = input.attempts + 1;
          if (newCount >= 3) {
            return { status: 'locked' as const, lockedUntil: new Date(now.getTime() + 15 * 60 * 1000) };
          }
          return { status: 'invalid' as const, attemptsRemaining: 3 - newCount, attempts: newCount };
        }
        let workerId = phoneToWorkerId.get(input.whatsappNumber);
        if (!workerId) {
          workerId = nextWorkerId();
          phoneToWorkerId.set(input.whatsappNumber, workerId);
        }
        return { status: 'verified' as const, workerId };
      },
    },
    _challenges: challenges,
    _lastCodeFor(challengeId: string): string | undefined {
      return challenges.get(challengeId)?.code;
    },
    _seedExistingWorker(phone: string, workerId: string): void {
      phoneToWorkerId.set(phone, workerId);
    },
  };
}

// ── Fake trust-question generator — controllable via failAdapter() ─────

type TrustQ = { q_en: string; q_es: string };

function createFakeTrustQuestions() {
  let mode: 'succeed' | 'fail' = 'succeed';
  return {
    trustQuestions: {
      async generate(_client: PoolClient, profession: string): Promise<TrustQ[] | null> {
        if (mode === 'fail') {
          throw new Error('generator_unavailable');
        }
        return [
          { q_en: `How long have you worked as a ${profession}?`, q_es: `Cuanto tiempo llevas como ${profession}?` },
          { q_en: `What tools do you use as a ${profession}?`, q_es: `Que herramientas usas como ${profession}?` },
          { q_en: `Describe a recent ${profession} job.`, q_es: `Describe un trabajo reciente de ${profession}.` },
        ];
      },
    },
    _fail(): void {
      mode = 'fail';
    },
    _succeed(): void {
      mode = 'succeed';
    },
  };
}

// ── Fake profile persistence adapter (users / worker_profiles / trust) ──

interface SavedProfile {
  name?: string;
  location?: { city: string | null; state: string | null; postalCode: string | null; source: string };
  trade?: string;
  tradeOther?: string;
  yearsExperience?: string;
  hasTransportation?: boolean;
  availability?: string;
  trustAnswers: Array<{
    questionIndex: number;
    qEn?: string;
    qEs?: string;
    answerText: string;
    answerSource?: string;
    provenance?: Record<string, unknown>;
  }>;
}

function createFakeProfileAdapter() {
  const profiles = new Map<string, SavedProfile>();
  const syncCalls: string[] = [];
  // Overridable per-test: which fields `syncProfileForTrustHandoff` reports
  // missing (defaults to "always ready" so existing flows aren't affected).
  let missingFieldsOverride: string[] | null = null;

  function ensure(workerId: string): SavedProfile {
    let p = profiles.get(workerId);
    if (!p) {
      p = { trustAnswers: [] };
      profiles.set(workerId, p);
    }
    return p;
  }

  return {
    profile: {
      async saveName(_client: PoolClient, workerId: string, name: string): Promise<void> {
        ensure(workerId).name = name;
      },
      async saveLocation(_client: PoolClient, workerId: string, location: SavedProfile['location']): Promise<void> {
        ensure(workerId).location = location;
      },
      async saveTrade(_client: PoolClient, workerId: string, trade: string): Promise<void> {
        ensure(workerId).trade = trade;
      },
      async saveCustomTrade(_client: PoolClient, workerId: string, rawProfession: string): Promise<void> {
        const p = ensure(workerId);
        p.trade = 'other';
        p.tradeOther = rawProfession;
      },
      async saveExperience(_client: PoolClient, workerId: string, yearsExperience: string): Promise<void> {
        ensure(workerId).yearsExperience = yearsExperience;
      },
      async saveTransportation(_client: PoolClient, workerId: string, hasTransportation: boolean): Promise<void> {
        ensure(workerId).hasTransportation = hasTransportation;
      },
      async saveAvailability(_client: PoolClient, workerId: string, availability: string): Promise<void> {
        ensure(workerId).availability = availability;
      },
      async syncProfileForTrustHandoff(
        _client: PoolClient,
        workerId: string,
      ): Promise<{ ready: boolean; missing: string[] }> {
        syncCalls.push(workerId);
        const missing = missingFieldsOverride ?? [];
        return { ready: missing.length === 0, missing };
      },
      async saveTrustAnswer(
        _client: PoolClient,
        input: {
          workerId: string;
          questionIndex: number;
          qEn?: string;
          qEs?: string;
          answerText: string;
          answerSource?: string;
          provenance?: Record<string, unknown>;
        },
      ): Promise<void> {
        ensure(input.workerId).trustAnswers.push({
          questionIndex: input.questionIndex,
          qEn: input.qEn,
          qEs: input.qEs,
          answerText: input.answerText,
          answerSource: input.answerSource,
          provenance: input.provenance,
        });
      },
    },
    _profiles: profiles,
    _syncCalls: syncCalls,
    setMissingFields(missing: string[] | null): void {
      missingFieldsOverride = missing;
    },
  };
}

// ── Deterministic, dependency-free phone hash (never a real sha256 —
//    determinism for tests, not security). ─────────────────────────────

function fakeHashNormalizedPhone(phone: string): string {
  return `hash:${phone}`;
}

// ── Harness public surface ──────────────────────────────────────────────

export interface SentMessage {
  phase: 'pre_auth_prompt' | 'pre_auth_text' | 'bound';
  to?: string;
  lang?: string;
  templateName?: string;
  fallbackBody?: string;
  body?: string;
  sourceType?: string;
  category?: MessageCategory;
  ownerService?: OwnerService;
}

export interface HarnessOptions {
  phone?: string;
  now?: Date;
}

export interface DriveOptions {
  lang?: 'en' | 'es';
  trade?: string;
  customProfession?: string;
}

export interface InjectOptions {
  workerId?: string;
  expiresAt?: Date | null;
  sourceId?: string;
}

export function createWhatsAppV2Harness(options: HarnessOptions = {}): WhatsAppV2Harness {
  return new WhatsAppV2Harness(options);
}

export class WhatsAppV2Harness {
  readonly phone: string;
  readonly conversationId: string;
  private readonly clockRef: { now: Date };
  private readonly preAuthRepo = createFakePreAuthRepo();
  private readonly conversations = createFakeConversationsStore();
  private readonly gateRepo: ReturnType<typeof createFakeGateRepo>;
  private readonly gateway: ReturnType<typeof createFakeWorkerGateway>;
  private readonly preAuthDelivery = createFakePreAuthDelivery();
  private readonly identityFake: ReturnType<typeof createFakeIdentity>;
  private readonly trustQuestionsFake = createFakeTrustQuestions();
  private readonly profileFake = createFakeProfileAdapter();
  private readonly locationResolver = createLocationResolver();
  private readonly deps: OnboardingV2Deps;
  private readonly processedSids = new Map<string, RouteResult>();
  private readonly sent: SentMessage[] = [];
  private readonly canonicalLegalConsents: Array<{ workerId: string; documentVersion: string }> = [];
  private locationFailing = false;

  constructor(options: HarnessOptions = {}) {
    this.phone = options.phone ?? '+15550001111';
    this.conversationId = `conv:${this.phone}`;
    this.clockRef = { now: options.now ?? new Date('2026-01-01T00:00:00.000Z') };
    this.gateRepo = createFakeGateRepo(this.conversations);
    this.gateway = createFakeWorkerGateway(this.gateRepo);
    this.identityFake = createFakeIdentity(this.clockRef);
    this.conversations.ensure(this.conversationId, this.phone);

    // The router now reads the persisted profile directly, via the REAL
    // loadProfileFromDb (lib/profile-flow.ts) — a `client.query(...)` call,
    // not another injected adapter fake — to resolve which profile field is
    // next (resolveNextProfileStep). HARNESS_CLIENT is a single shared
    // module-level object (see its header comment / the identity assertion
    // in onboarding-v2-conversation.test.ts), so its `.query` is rebound
    // here, per harness construction, to this instance's own fake profile
    // store. Tests only ever drive one harness at a time, so this rebind is
    // safe: it stays pointed at whichever harness constructed it last.
    (HARNESS_CLIENT as unknown as { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }).query =
      async (_sql: string, params: unknown[]) => {
        const workerId = params[0] as string;
        const p = this.profileFake._profiles.get(workerId);
        return {
          rows: [
            {
              full_name: p?.name ?? null,
              city: p?.location ? (p.location.city ?? p.location.postalCode) : null,
              main_trade: p?.trade ?? null,
              main_trade_other: null,
              years_experience: p?.yearsExperience ?? null,
              has_transportation: p?.hasTransportation ?? null,
              availability: p?.availability ?? null,
            },
          ],
        };
      };

    this.deps = {
      adapters: {
        clock: { now: () => this.clockRef.now },
        identity: this.identityFake.identity,
        location: {
          resolve: (raw: string) => {
            if (this.locationFailing) return null;
            return this.locationResolver.resolve(raw);
          },
        },
        trustQuestions: this.trustQuestionsFake.trustQuestions,
        profile: this.profileFake.profile,
      },
      repo: {
        setInternalUserRlsContext: async () => undefined,
        loadPreAuthStateForUpdate: (c, phoneHash) => this.preAuthRepo.loadPreAuthStateForUpdate(c, phoneHash),
        savePreAuthState: (c, phoneHash, patch) => this.preAuthRepo.savePreAuthState(c, phoneHash, patch),
        bindVerifiedIdentityAndStartWorkflow: (c, input) =>
          this.gateRepo.bindVerifiedIdentityAndStartWorkflow(c, input),
        loadWorkerGate: (c, workerId) => this.gateRepo.loadWorkerGate(c, workerId),
        advanceWorkflow: (c, input) => this.gateRepo.advanceWorkflow(c, input as any),
        setRunPreferredLanguage: (c, input) => this.gateRepo.setRunPreferredLanguage(c, input),
        reactivateDeclinedLegalRun: (c, input) => this.gateRepo.reactivateDeclinedLegalRun(c, input),
        appendTransition: (c, input) => this.gateRepo.appendTransition(c, input as any),
        completeOnboarding: (c, input) => this.gateRepo.completeOnboarding(c, input),
      },
      enqueueWorkerMessage: this.gateway.enqueueWorkerMessage,
      enqueuePreAuthPrompt: (c, sid, to, prompt) => {
        this.recordPreAuthPrompt(sid, to, prompt as RecordedPreAuthPrompt['prompt']);
        return this.preAuthDelivery.enqueuePreAuthPrompt(c, sid, to, prompt as RecordedPreAuthPrompt['prompt']);
      },
      enqueuePreAuthText: (c, sid, to, body) => {
        this.recordPreAuthText(sid, to, body);
        return this.preAuthDelivery.enqueuePreAuthText(c, sid, to, body);
      },
      hashNormalizedPhone: fakeHashNormalizedPhone,
      tosUrl: 'https://jale.example/tos',
      privacyUrl: 'https://jale.example/privacy',
      requiredLegalVersion: '1.0',
      recordLegalAcceptance: async (_client, input) => {
        this.canonicalLegalConsents.push(input);
      },
      workflowVersion: 1,
    };

    // Wrap enqueueWorkerMessage so every allowed send is also mirrored into
    // the harness's unified `sent` reader (bound-phase sends).
    const rawEnqueue = this.deps.enqueueWorkerMessage;
    this.deps.enqueueWorkerMessage = async (c, input, now) => {
      const result = await rawEnqueue(c, input, now);
      if ((result.decision as DeliveryDecision).action === 'allow') {
        const payload = input.payload as Record<string, unknown>;
        this.sent.push({
          phase: 'bound',
          lang: payload.lang as string | undefined,
          templateName: payload.templateName as string | undefined,
          fallbackBody: payload.fallbackBody as string | undefined,
          body: payload.body as string | undefined,
          sourceType: input.sourceType,
          category: input.category,
          ownerService: input.ownerService,
        });
      }
      return result;
    };
  }

  private recordPreAuthPrompt(_sid: string, to: string, prompt: RecordedPreAuthPrompt['prompt']): void {
    this.sent.push({
      phase: 'pre_auth_prompt',
      to,
      templateName: prompt.templateName,
      fallbackBody: prompt.fallbackBody,
    });
  }

  private recordPreAuthText(_sid: string, to: string, body: string): void {
    this.sent.push({ phase: 'pre_auth_text', to, body });
  }

  // ── Clock ──────────────────────────────────────────────────────────

  advanceTime(ms: number): void {
    this.clockRef.now = new Date(this.clockRef.now.getTime() + ms);
  }

  now(): Date {
    return this.clockRef.now;
  }

  // ── Adapter failure injection ────────────────────────────────────────

  failAdapter(name: 'trustQuestions' | 'location'): void {
    if (name === 'trustQuestions') this.trustQuestionsFake._fail();
    if (name === 'location') this.locationFailing = true;
  }

  recoverAdapter(name: 'trustQuestions' | 'location'): void {
    if (name === 'trustQuestions') this.trustQuestionsFake._succeed();
    if (name === 'location') this.locationFailing = false;
  }

  // ── Pre-seeding for the "existing candidate" scenario ───────────────

  seedExistingWorker(workerId: string): void {
    this.identityFake._seedExistingWorker(this.phone, workerId);
    const phoneHash = fakeHashNormalizedPhone(this.phone);
    this.preAuthRepo._seedCandidate(phoneHash, workerId);
    // A pre-existing account whose phone matches, with NO gate/run yet —
    // conv.user_id is already populated the way a web-signup-linked phone
    // would be, but there is no workflow run until OTP completes.
    this.conversations.bindUserId(this.conversationId, workerId);
  }

  // ── Core turn driver ─────────────────────────────────────────────────

  private async routeTurn(msg: OnboardingV2InboundMessage): Promise<RouteResult> {
    const cached = this.processedSids.get(msg.messageSid);
    if (cached) return cached;

    const row = this.conversations.ensure(this.conversationId, this.phone);
    const session: OnboardingV2Session = {
      id: row.id,
      user_id: row.user_id,
      whatsapp_number: row.whatsapp_number,
      language: row.language,
      conversation_state: row.conversation_state,
      // Round trip mirrors the DB JSONB read: the router must not depend on
      // in-memory object identity surviving between messages.
      state_context: roundTrip(row.state_context),
    };

    const result = await routeOnboardingV2(HARNESS_CLIENT, session, msg, this.deps);

    // Mirrors processor.ts's post-route write-back (Task 6): persist the
    // router's state_context mutations, round-tripped, in the SAME "turn".
    row.state_context = roundTrip(session.state_context);
    // conversation_state / language are left untouched by v2's own
    // bookkeeping, exactly as Task 6 documents; user_id may have been
    // rebound by bindVerifiedIdentityAndStartWorkflow already.
    row.user_id = this.conversations._byId.get(row.id)?.user_id ?? row.user_id;

    this.processedSids.set(msg.messageSid, result);
    return result;
  }

  async sendText(body: string, opts: { messageSid?: string } = {}): Promise<RouteResult> {
    return this.routeTurn({
      from: this.phone,
      body,
      messageSid: opts.messageSid ?? nextSid('sid'),
    });
  }

  async pressButton(
    payload: string,
    opts: { messageSid?: string; body?: string } = {},
  ): Promise<RouteResult> {
    return this.routeTurn({
      from: this.phone,
      body: opts.body ?? '',
      messageSid: opts.messageSid ?? nextSid('sid'),
      interactivePayload: payload,
    });
  }

  // ── Business-message deferral — REAL evaluateDelivery ───────────────

  private currentWorkerId(): string | null {
    return this.conversations._byId.get(this.conversationId)?.user_id ?? null;
  }

  async injectEmployerMessage(opts: InjectOptions = {}): Promise<DeliveryDecision> {
    const workerId = opts.workerId ?? this.currentWorkerId();
    if (!workerId) throw new Error('injectEmployerMessage: no bound worker yet');
    const input: WorkerMessageIntentInput = {
      workerId,
      category: 'employer_chat',
      ownerService: 'job-messaging',
      sourceType: 'employer_chat:test',
      sourceId: opts.sourceId ?? nextSid('employer-msg'),
      dedupeKey: `test:employer_chat:${workerId}:${nextSid('dk')}`,
      priority: 5,
      expiresAt: opts.expiresAt ?? null,
      payload: { companyName: 'Acme Construction', jobTitle: 'Electrician' },
    };
    const { decision } = await this.deps.enqueueWorkerMessage(HARNESS_CLIENT, input, this.clockRef.now);
    return decision as DeliveryDecision;
  }

  async injectJobAlert(opts: InjectOptions = {}): Promise<DeliveryDecision> {
    const workerId = opts.workerId ?? this.currentWorkerId();
    if (!workerId) throw new Error('injectJobAlert: no bound worker yet');
    const input: WorkerMessageIntentInput = {
      workerId,
      category: 'job_alert',
      ownerService: 'job-alert',
      sourceType: 'job_alert:test',
      sourceId: opts.sourceId ?? nextSid('job-alert'),
      dedupeKey: `test:job_alert:${workerId}:${nextSid('dk')}`,
      priority: 5,
      expiresAt: opts.expiresAt ?? null,
      payload: { jobs: [{ jobId: 'job-1', title: 'Electrician', companyName: 'Acme', score: 90 }] },
    };
    const { decision } = await this.deps.enqueueWorkerMessage(HARNESS_CLIENT, input, this.clockRef.now);
    return decision as DeliveryDecision;
  }

  // ── Convenience: fast-forward to a target step ──────────────────────

  /**
   * Drives canned, valid answers until the conversation reaches `target`.
   * Stops right after the action that ARRIVES at `target` (never performs
   * the action that would leave it), so a test may keep driving forward
   * from there with its own inputs.
   */
  async driveToStep(target: WorkflowStepKey, opts: DriveOptions = {}): Promise<void> {
    const lang = opts.lang ?? 'en';
    // A target of profile.custom_trade unambiguously implies the 'other'
    // branch was taken, regardless of what a caller passed (or omitted).
    const trade = target === 'profile.custom_trade' ? 'other' : (opts.trade ?? 'electrician');
    const order: WorkflowStepKey[] = [
      'start.choose_language',
      'identity.verify_otp',
      'legal.review',
      'profile.name',
      'profile.location',
      'profile.trade',
      ...(trade === 'other' ? (['profile.custom_trade'] as WorkflowStepKey[]) : []),
      'profile.experience',
      'profile.transportation',
      'profile.availability',
      'trust.question.1',
      'trust.question.2',
      'trust.question.3',
    ];
    const targetIdx = order.indexOf(target);
    if (targetIdx === -1) throw new Error(`driveToStep: unknown target ${target}`);

    // Each order[i]'s canned action is the input that LEAVES step i and
    // ARRIVES at step i+1 — so reaching `target` means performing every
    // action strictly BEFORE it, never target's own action (that would
    // overshoot past it, e.g. answering trust.question.3 while trying to
    // arrive there).
    for (let i = 0; i < targetIdx; i++) {
      const step = order[i];
      switch (step) {
        case 'start.choose_language':
          await this.sendText(lang === 'en' ? 'START' : 'EMPEZAR');
          break;
        case 'identity.verify_otp': {
          const code = this.lastIssuedOtpCode();
          await this.sendText(code);
          break;
        }
        case 'legal.review':
          await this.sendText('ACCEPT');
          break;
        case 'profile.name':
          await this.sendText('Jose Martinez');
          break;
        case 'profile.location':
          await this.sendText('78701');
          break;
        case 'profile.trade':
          await this.sendText(trade);
          break;
        case 'profile.custom_trade':
          await this.sendText(opts.customProfession ?? 'dog groomer');
          break;
        case 'profile.experience':
        case 'profile.transportation':
        case 'profile.availability':
          await this.sendText('1');
          break;
        case 'trust.question.1':
        case 'trust.question.2':
        case 'trust.question.3':
          await this.sendText('1');
          break;
        default:
          throw new Error(`driveToStep: no canned answer for ${step}`);
      }
    }
  }

  /** The code the fake identity adapter most recently issued for this
   * phone's CURRENT pre-auth challenge — deterministic, never logged
   * beyond this in-memory test fake. Useful for tests that need to verify
   * an OTP explicitly rather than via `driveToStep`. */
  lastIssuedOtpCode(): string {
    const preAuth = this.preAuthRepo._rows.get(fakeHashNormalizedPhone(this.phone));
    const challengeId = preAuth?.providerChallengeId;
    if (!challengeId) throw new Error('lastIssuedOtpCode: no challenge issued yet');
    const code = this.identityFake._lastCodeFor(challengeId);
    if (!code) throw new Error('lastIssuedOtpCode: unknown challenge id');
    return code;
  }

  /** Deliberately sends a WRONG OTP code (does not consume the real one). */
  async sendWrongOtp(): Promise<RouteResult> {
    return this.sendText('000000');
  }

  // ── Readers ──────────────────────────────────────────────────────────

  getState(): {
    workerId: string | null;
    stateContext: Record<string, unknown>;
    gate: WorkerGate | null;
    preAuth: PreAuthState | null;
  } {
    const row = this.conversations._byId.get(this.conversationId)!;
    const workerId = row.user_id;
    return {
      workerId,
      stateContext: row.state_context,
      gate: workerId ? this.gateRepo._gates.get(workerId) ?? null : null,
      preAuth: this.preAuthRepo._rows.get(fakeHashNormalizedPhone(this.phone)) ?? null,
    };
  }

  getSentMessages(): SentMessage[] {
    return [...this.sent];
  }

  getIntents(): RecordedIntent[] {
    return [...this.gateway.intents];
  }

  getTransitions(): TransitionRecord[] {
    return [...this.gateRepo._transitions];
  }

  getCompletions(): CompletionRecord[] {
    return [...this.gateRepo._completions];
  }

  getCompletionClients(): unknown[] {
    return [...this.gateRepo._completionClients];
  }

  /** Legal consents recorded — tied to the concrete `advanceWorkflow` call
   * with `reason: 'legal_accept'` (the only place a legal Accept persists
   * anything), never inferred from a send count. */
  getLegalConsents(): TransitionRecord[] {
    return this.getTransitions().filter((t) => t.reason === 'legal_accept');
  }


  getCanonicalLegalConsents(): Array<{ workerId: string; documentVersion: string }> {
    return [...this.canonicalLegalConsents];
  }
  /** Every time the legal.review prompt itself was presented (initial
   * bind-time send, an explicit Review Terms resend, or a gate reprompt) —
   * counted from actual sends, not inferred from transitions. */
  getLegalPromptPresentations(): SentMessage[] {
    return this.getSentMessages().filter(
      (m) => m.phase === 'bound' && m.sourceType === 'onboarding_v2:legal.review',
    );
  }

  getWorkerProfile(workerId?: string): SavedProfile | null {
    const id = workerId ?? this.currentWorkerId();
    if (!id) return null;
    return this.profileFake._profiles.get(id) ?? null;
  }

  /** How many times `profile.syncProfileForTrustHandoff` has been invoked
   * (the pre-trust-handoff profile sync/gate). */
  getProfileSyncCallCount(): number {
    return this.profileFake._syncCalls.length;
  }

  /** Makes the next `syncProfileForTrustHandoff` call(s) report these fields
   * as missing (fail-closed gate testing). Pass `null` to reset to "always
   * ready". */
  setProfileSyncMissingFields(missing: string[] | null): void {
    this.profileFake.setMissingFields(missing);
  }
}
