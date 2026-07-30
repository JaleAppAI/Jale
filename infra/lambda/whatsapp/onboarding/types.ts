/**
 * WhatsApp v2 onboarding router — shared session/message/deps types.
 * Moved verbatim out of `../onboarding-v2.ts` (pure move, no behavior
 * change).
 */

import type { PoolClient } from 'pg';
import type {
  MessageCategory,
  OwnerService,
  PreferredLanguage,
  WorkerMessageIntentInput,
  WorkflowStepKey,
} from '../lib/onboarding-types';
import type { PreAuthState, WorkerGate } from '../lib/onboarding-repository';
import type { OnboardingV2Adapters } from '../lib/onboarding-adapters';
import type { InteractivePrompt } from '../lib/interactive-templates';
import type { VoiceEventV2 } from '../lib/voice-events';

// ── Session / message shapes the router is handed ──────────────────────

export interface OnboardingV2Session {
  id: string;
  user_id: string | null;
  whatsapp_number: string;
  language: PreferredLanguage;
  conversation_state: string;
  /** Mutable scratch bag this router reads/writes reprompt-cooldown
   * bookkeeping into. Callers persist whatever mutations land here. */
  state_context: Record<string, unknown>;
}

export interface OnboardingV2InboundMessage {
  from: string;
  body: string;
  messageSid: string;
  interactivePayload?: string;
  /** Twilio media fields (mirrors legacy IncomingMessage) — undefined/0 for
   * a plain text or interactive-payload message. */
  numMedia?: number;
  mediaUrl?: string;
  mediaSid?: string;
  mediaContentType?: string;
  /** Present only on a synthetic voice-pipeline completion re-entry (see
   * lib/voice-events.ts) — never set on a real inbound Twilio message. */
  voiceEvent?: VoiceEventV2;
}

export type RouteResult =
  | { handled: true; workerId: string | null; stepKey: string }
  | {
      handled: false;
      handoff: 'ready';
      workerId: string;
      stepKey: 'ready';
    };

// ── Locally-composed deps (no canonical types redeclared here) ─────────

export interface OnboardingV2RepoDeps {
  setInternalUserRlsContext: (client: PoolClient, workerId: string) => Promise<void>;
  loadPreAuthStateForUpdate: (
    client: PoolClient,
    phoneHash: string,
  ) => Promise<PreAuthState | null>;
  savePreAuthState: (
    client: PoolClient,
    phoneHash: string,
    patch: Partial<PreAuthState>,
  ) => Promise<PreAuthState>;
  bindVerifiedIdentityAndStartWorkflow: (
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
  ) => Promise<WorkerGate>;
  loadWorkerGate: (client: PoolClient, workerId: string) => Promise<WorkerGate | null>;
  advanceWorkflow: (
    client: PoolClient,
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
  ) => Promise<WorkerGate>;
  setRunPreferredLanguage: (client: PoolClient, input: { runId: string; expectedLockVersion: number; preferredLanguage: PreferredLanguage }) => Promise<WorkerGate>;
  reactivateDeclinedLegalRun: (
    client: PoolClient,
    input: { runId: string; expectedLockVersion: number },
  ) => Promise<WorkerGate>;
  appendTransition: (
    client: PoolClient,
    input: {
      runId: string;
      fromStepKey: WorkflowStepKey | null;
      toStepKey: WorkflowStepKey;
      inboundMessageSid: string | null;
      reason: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<{ transitionId: string }>;
  /**
   * RESTART/REINICIAR (`onboarding/gate.ts`): clears exactly the seven
   * profile-answer fields (+ their `worker_profiles` mirrors) — never legal/
   * consent/OTP/lifecycle/trust_signals state, never a row delete.
   */
  clearProfileAnswers: (client: PoolClient, workerId: string) => Promise<void>;
  /**
   * RESTART/REINICIAR (`onboarding/gate.ts`): resets the worker's pending
   * trust-assessment answers to `[]` (never a scored/completed assessment)
   * and clears their `worker_skills` rows, so a restart with a different
   * trade never leaves the abandoned trade's skill or trust answers behind.
   */
  resetPendingTrustAssessmentAndSkills: (client: PoolClient, workerId: string) => Promise<void>;
  /**
   * BACK/ATRAS (`onboarding/gate.ts`): the step a run was on immediately
   * before its current step, per the transition history. Null when there is
   * nothing to go back to.
   */
  findPreviousStepKey: (
    client: PoolClient,
    runId: string,
    currentStepKey: WorkflowStepKey,
  ) => Promise<WorkflowStepKey | null>;
  /**
   * Task 5's sole call site: fired exactly once, on the SAME client/
   * transaction as the answer-three persistence that precedes it, with the
   * locked gate's `expectedLockVersion`. Never awaited for external work —
   * the two domain events it enqueues are drained by other lanes.
   */
  completeOnboarding: (
    client: PoolClient,
    input: {
      workerId: string;
      runId: string;
      expectedLockVersion: number;
      assessmentProvenance: Record<string, unknown>;
      /**
       * Job referrals (migration 055): required at THIS injection-contract
       * level — every router-owned call site (today, only `trust.ts`) must
       * supply it, so a future step handler that forgets it is a compile
       * error, not a silent no-op referral claim. Derived via
       * `hashNormalizedPhone` from whatever phone value is already in scope
       * (`trust.ts` uses `session.whatsapp_number`) — see
       * onboarding-repository.ts's `completeOnboarding` for why the
       * lower-level function itself keeps this optional (its other caller,
       * the DB integration suite, predates this feature and is out of
       * scope to touch).
       */
      workerPhoneHash: string;
      now: Date;
    },
  ) => Promise<{ assessmentEventId: string; workerReadyEventId: string }>;
}

export interface OnboardingV2Deps {
  adapters: OnboardingV2Adapters;
  repo: OnboardingV2RepoDeps;
  enqueueWorkerMessage: (
    client: PoolClient,
    input: WorkerMessageIntentInput,
    now?: Date,
  ) => Promise<{ intentId: string; decision: unknown; outboxMaterialized: boolean }>;
  /**
   * Pre-auth delivery gateway (Design A). Pre-OTP steps
   * (start.choose_language, identity.verify_otp) have no bound `user_id`
   * — a net-new worker has no `users` row at all, and `worker_message_intents.user_id`
   * is a NOT NULL FK — so their prompts CANNOT go through `enqueueWorkerMessage`.
   * They travel the phone/inbound-message-keyed `whatsapp_outbox` reply origin
   * instead (`inbound_message_sid IS NOT NULL AND source_type IS NULL`), which
   * needs no identity, is durable, and is drained post-commit by the existing
   * sweeper — never a direct Twilio send. In production these are the legacy
   * `queueInteractivePrompt` / `queueOutboxText` writers; tests inject fakes.
   */
  enqueuePreAuthPrompt: (
    client: PoolClient,
    inboundMessageSid: string,
    to: string,
    prompt: InteractivePrompt,
  ) => Promise<void>;
  enqueuePreAuthText: (
    client: PoolClient,
    inboundMessageSid: string,
    to: string,
    body: string,
  ) => Promise<void>;
  hashNormalizedPhone: (phone: string) => string;
  tosUrl: string;
  privacyUrl: string;
  workflowVersion: number;
  requiredLegalVersion: string;
  recordLegalAcceptance: (
    client: PoolClient,
    input: { workerId: string; documentVersion: string },
  ) => Promise<void>;
  /**
   * Gated by the `voice_intake_enabled` runtime control (fail-closed,
   * allowlist-then-global-rollout pattern) — the only phone-scoped runtime
   * control remaining now that onboarding v2 is hardwired on for everyone.
   * `startTrustTranscription` kicks off the Twilio-download -> S3 ->
   * Transcribe pipeline for a voice note recorded at a `trust.question.*`
   * step; it never advances the step or touches the run lock — that only
   * happens when the transcript comes back (or a typed answer wins the
   * race first). A second method for full voice profile intake
   * (`ingestProfileVoiceNote`) lands in a later task — this surface is
   * shaped to add it without another cross-cutting deps change.
   */
  voiceIntake: {
    enabled: boolean;
    startTrustTranscription(input: {
      workerId: string;
      phone: string;
      runId: string;
      stepKey: string;
      questionIndex: number;
      language: PreferredLanguage;
      mediaUrl: string;
      mediaContentType: string;
      inboundMessageSid: string;
    }): Promise<{ started: boolean; reason?: string; executionArn?: string }>;
    /**
     * Stream B: full voice profile intake at `profile.voice_choice`. Kicks
     * off the SAME Twilio-download -> S3 -> Transcribe -> Bedrock pipeline
     * `AI_PIPELINE_STATE_MACHINE_ARN` already runs for v1's media flow, but
     * tagged with a `v2` marker so `ai-profile-writer`'s completion branch
     * re-enters this lane (via a `#vp`-suffixed synthetic event) instead of
     * writing `users`/outbox directly. Returns the deterministic execution
     * ARN synchronously so the caller can stash it in `state_context` as the
     * staleness anchor `handleVoiceIntakeResult` checks against — never
     * throws for an expected failure (oversized file, download error,
     * pipeline unavailable); those return `{ started: false, reason }`.
     */
    ingestProfileVoiceNote(input: {
      workerId: string;
      phone: string;
      runId: string;
      stepKey: string;
      language: PreferredLanguage;
      mediaUrl: string;
      mediaContentType: string;
      inboundMessageSid: string;
    }): Promise<{ started: boolean; reason?: string; executionArn?: string }>;
  };
}
