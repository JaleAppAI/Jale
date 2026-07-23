/**
 * Task 2: Workflow Adapters — external adapter surfaces for the WhatsApp v2
 * onboarding lane.
 *
 * This module wraps every external dependency the v2 onboarding workflow
 * needs (Cognito CUSTOM_AUTH, worker-location parsing, trust-question
 * generation, and profile persistence) behind small, typed, NEVER-throwing
 * (for expected failure modes) interfaces so the workflow engine that will
 * be built on top of this in a later task can be tested without touching
 * AWS or Postgres.
 *
 * Canonical cross-lane types (`WorkerLifecycle`, `WorkflowStepKey`,
 * `MessageCategory`, `OwnerService`, `PreferredLanguage`,
 * `DeliveryDecision`, `WorkerMessageIntentInput`, ...) live in
 * `./onboarding-types.ts` and are imported, never redeclared, here. The
 * only interface this module owns is `OnboardingV2Adapters` and the
 * adapter-specific request/result shapes below it.
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AuthFlowType,
  ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PreferredLanguage } from './onboarding-types';
import { decodeIdTokenSub } from './jwt';
import { reconcileWorkerCognitoAccount } from '../../auth/lib/worker-cognito-reconciliation';
import {
  loadOrGenerateQuestions,
  normalizeProfession,
  type TrustQuestion,
} from '../handlers/custom-trust';
import type { WorkerLocationSource } from '../../lib/location';
import {
  TRUST_QUESTIONS,
  TRUST_STEPS,
  SENIORITY_OPTIONS,
  getTrustOptions,
  buildTrustQuestion,
} from './flows';

// ── Local constants ────────────────────────────────────────────────────
//
// onboarding-types.ts does not (yet) export OTP timing/attempt constants,
// so they are declared once, here, and nowhere else in this lane.
const OTP_TTL_MS = 5 * 60 * 1000; // 5-minute challenge TTL (v2; legacy was 10 min).
const OTP_LOCK_MS = 15 * 60 * 1000; // Lockout duration after exhausting attempts.
const OTP_MAX_ATTEMPTS = 3; // Total wrong codes allowed before lockout.
const THROTTLE_RETRY_SECONDS = 30; // Cognito doesn't give us a Retry-After; a fixed backoff.

// ── OnboardingV2Adapters — the lane's only local interface ─────────────

export interface OnboardingV2Adapters {
  clock: { now(): Date };
  identity: IdentityAdapter;
  location: LocationResolver;
  trustQuestions: TrustQuestionGenerator;
  profile: ProfilePersistenceAdapter;
}

// ── IdentityAdapter ───────────────────────────────────────────────────

export type IssueChallengeResult =
  | { status: 'sent'; challengeId: string; expiresAt: Date }
  | { status: 'throttled'; retryAfterSeconds: number };

export type VerifyChallengeResult =
  | { status: 'verified'; workerId: string }
  | { status: 'invalid'; attemptsRemaining: number; attempts: number }
  | { status: 'expired' }
  | { status: 'locked'; lockedUntil: Date };

/**
 * The processor's `reconcileUserRow` (lambda/whatsapp/processor.ts:1474) is
 * not exported and this module must not export it or edit processor.ts.
 * `IdentityAdapter.verifyChallenge` instead accepts it as an INJECTED
 * dependency, typed structurally here so this module has zero import
 * coupling to processor.ts. The task that owns processor.ts wires the real
 * implementation in later; tests inject a stub/mock.
 */
export type ReconcileUserRowFn = (
  client: PoolClient,
  cognitoSub: string,
  whatsappNumber: string,
) => Promise<{ userId: string; tosVersion: string | null }>;

export interface IdentityAdapter {
  issueChallenge(input: {
    whatsappNumber: string;
    lang: PreferredLanguage;
  }): Promise<IssueChallengeResult>;

  /**
   * Takes the CALLER's PoolClient as its first argument (mirrors the
   * ProfilePersistenceAdapter convention below) because a correct code
   * must reconcile the `users` row via the injected `reconcileUserRow`,
   * which itself requires a client. This adapter never opens its own
   * connection or transaction.
   *
   * STATELESS by design: `attempts` and `lockedUntil` are passed in from
   * the caller's durable `PreAuthState` (lib/onboarding-repository.ts,
   * backed by `worker_identity_challenges.attempts` / `.locked_until`,
   * migration 042) and the new attempt count is returned, never stored on
   * this adapter. Each inbound WhatsApp message is a separate Lambda
   * invocation with a freshly constructed adapter, so any state kept on
   * the adapter instance itself would silently reset every call — the
   * three-strike lockout only works if the caller persists what this
   * method returns through `savePreAuthState` between calls.
   */
  verifyChallenge(
    client: PoolClient,
    input: {
      challengeId: string;
      whatsappNumber: string;
      code: string;
      attempts: number;
      lockedUntil: Date | null;
    },
  ): Promise<VerifyChallengeResult>;
}

type CognitoClient = { send(command: unknown): Promise<any> };

export interface IdentityAdapterDeps {
  /** Injected for tests; lazily constructed in createOnboardingV2Adapters otherwise. */
  cognitoClient?: CognitoClient;
  userPoolId: string;
  clientId: string;
  clock: { now(): Date };
  reconcileUserRow: ReconcileUserRowFn;
}

function isThrottleError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name ?? '';
  return name === 'TooManyRequestsException' || name === 'LimitExceededException';
}

export function createIdentityAdapter(deps: IdentityAdapterDeps): IdentityAdapter {
  // Lazy construction: the client is only created when this factory runs,
  // never at module load (Rule 4).
  const cognito: CognitoClient = deps.cognitoClient ?? new CognitoIdentityProviderClient({});

  return {
    async issueChallenge({ whatsappNumber }) {
      try {
        // Ensures the worker's Cognito account is enabled, in the Workers
        // group, and has the correct phone/user-type attributes before we
        // ask Cognito to start a CUSTOM_AUTH challenge for it. Mirrors
        // lambda/whatsapp/processor.ts:~1240.
        await reconcileWorkerCognitoAccount({
          client: cognito,
          userPoolId: deps.userPoolId,
          phone: whatsappNumber,
        });

        const init = await cognito.send(
          new InitiateAuthCommand({
            AuthFlow: AuthFlowType.CUSTOM_AUTH,
            ClientId: deps.clientId,
            AuthParameters: { USERNAME: whatsappNumber },
          }),
        );

        const now = deps.clock.now();
        return {
          status: 'sent',
          challengeId: init.Session as string,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        };
      } catch (err) {
        if (isThrottleError(err)) {
          return { status: 'throttled', retryAfterSeconds: THROTTLE_RETRY_SECONDS };
        }
        throw err;
      }
    },

    async verifyChallenge(client, { challengeId, whatsappNumber, code, attempts, lockedUntil }) {
      const now = deps.clock.now();
      if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
        return { status: 'locked', lockedUntil };
      }

      let resp: any;
      try {
        resp = await cognito.send(
          new RespondToAuthChallengeCommand({
            ClientId: deps.clientId,
            ChallengeName: ChallengeNameType.CUSTOM_CHALLENGE,
            Session: challengeId,
            ChallengeResponses: {
              USERNAME: whatsappNumber,
              ANSWER: code,
            },
          }),
        );
      } catch (err: any) {
        const name: string = err?.name ?? '';
        const detail: string = err?.message ?? '';
        // Expired Cognito session — NOT a counted attempt (mirrors
        // processor.ts's reissueOtp path).
        if (name === 'NotAuthorizedException' && /session/i.test(detail)) {
          return { status: 'expired' };
        }
        // Any other thrown error (e.g. Cognito's own max-retries fail) is
        // treated as a wrong code, falling through to attempt accounting.
        resp = undefined;
      }

      if (resp?.AuthenticationResult?.IdToken) {
        const realSub = decodeIdTokenSub(resp.AuthenticationResult.IdToken);
        const { userId } = await deps.reconcileUserRow(client, realSub, whatsappNumber);
        return { status: 'verified', workerId: userId };
      }

      // Wrong code. Caller-held count in, caller-held count out — nothing
      // is stored on this adapter (see the STATELESS note on the interface).
      const newCount = attempts + 1;
      if (newCount >= OTP_MAX_ATTEMPTS) {
        const newLockedUntil = new Date(now.getTime() + OTP_LOCK_MS);
        return { status: 'locked', lockedUntil: newLockedUntil };
      }
      return {
        status: 'invalid',
        attemptsRemaining: OTP_MAX_ATTEMPTS - newCount,
        attempts: newCount,
      };
    },
  };
}

// ── LocationResolver ──────────────────────────────────────────────────

export interface ResolvedLocation {
  city: string | null;
  state: string | null;
  postalCode: string | null;
  source: 'zip' | 'city_state';
}

export interface LocationResolver {
  resolve(raw: string): ResolvedLocation | null;
}

const ZIP_RE = /^\d{5}$/;
const CITY_STATE_RE = /^([A-Za-z][A-Za-z .'-]*),\s*([A-Za-z]{2})$/;

/** Maps this adapter's `source` vocabulary onto the shared worker-location vocabulary. */
export function toWorkerLocationSource(source: ResolvedLocation['source']): WorkerLocationSource {
  return source === 'zip' ? 'geocoded_zip' : 'geocoded_address';
}

export function createLocationResolver(): LocationResolver {
  return {
    resolve(raw: string): ResolvedLocation | null {
      const trimmed = (raw ?? '').trim();
      if (ZIP_RE.test(trimmed)) {
        return { city: null, state: null, postalCode: trimmed, source: 'zip' };
      }
      const match = CITY_STATE_RE.exec(trimmed);
      if (match) {
        return {
          city: match[1].trim(),
          state: match[2].toUpperCase(),
          postalCode: null,
          source: 'city_state',
        };
      }
      return null;
    },
  };
}

// ── TrustQuestionGenerator ────────────────────────────────────────────

export interface TrustQuestionGenerator {
  generate(client: PoolClient, profession: string): Promise<TrustQuestion[] | null>;
}

export function createTrustQuestionGenerator(): TrustQuestionGenerator {
  return {
    async generate(client, profession) {
      try {
        const professionKey = normalizeProfession(profession);
        const questions = await loadOrGenerateQuestions(client, professionKey, profession);
        if (!Array.isArray(questions) || questions.length < 3) return null;
        return questions.slice(0, 3);
      } catch (err) {
        // Sanitized: log only the failure reason, never the phone number,
        // OTP, or raw message body (none of which are in scope here, but
        // future callers must not thread them through professionRaw).
        console.error('[onboarding-adapters] trust question generation failed', {
          event: 'trust_question_generation_failed',
          reason: (err as { name?: string; message?: string })?.name ?? 'unknown_error',
        });
        return null;
      }
    },
  };
}

// ── ProfilePersistenceAdapter ─────────────────────────────────────────

export interface ProfilePersistenceAdapter {
  saveName(client: PoolClient, workerId: string, name: string): Promise<void>;
  saveLocation(client: PoolClient, workerId: string, location: ResolvedLocation): Promise<void>;
  saveTrade(client: PoolClient, workerId: string, trade: string): Promise<void>;
  saveTrustAnswer(client: PoolClient, input: TrustAnswerInput): Promise<void>;
}

/**
 * `worker_trust_assessments` (migration 012) is the canonical trust-answer
 * store — one row per (user, profession) accumulating answers in the
 * `answers` JSONB column, exactly as `handlers/custom-trust.ts:282` already
 * writes it. There is no per-answer table; `rubric_version` and
 * `scoring_model_id` are the canonical provenance columns a later task uses
 * to record which question set / scoring model produced the assessment —
 * route provenance through those columns rather than inventing new storage.
 */
export interface TrustAnswerInput {
  workerId: string;
  professionKey: string;
  questionIndex: number;
  answerText: string;
  provenance?: { rubricVersion?: string; scoringModelId?: string };
}

export function createProfilePersistenceAdapter(
  // The clock is injected so the deterministic conversation harness can drive
  // answer timestamps. Nothing in this module may read the wall clock directly.
  clock: { now(): Date } = { now: () => new Date() },
): ProfilePersistenceAdapter {
  return {
    async saveName(client, workerId, name) {
      // `users.full_name` is the canonical profile-builder column (see
      // lambda/whatsapp/lib/profile-flow.ts loadProfileFromDb).
      await client.query(
        `UPDATE users SET full_name = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, name],
      );
    },

    async saveLocation(client, workerId, location) {
      const source = toWorkerLocationSource(location.source);
      const locationText =
        location.source === 'city_state' && location.city && location.state
          ? `${location.city}, ${location.state}`
          : location.postalCode;

      // `users.city` feeds profile-builder display; `worker_profiles`
      // carries the matching-relevant location_source/location_updated_at
      // columns already used by lambda/lib/location.ts's setWorkerCoordinates.
      await client.query(
        `UPDATE users SET city = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, location.city ?? locationText],
      );
      await client.query(
        `UPDATE worker_profiles
            SET location = $2,
                location_source = $3,
                location_updated_at = NOW()
          WHERE user_id = $1`,
        [workerId, locationText, source],
      );
    },

    async saveTrade(client, workerId, trade) {
      await client.query(
        `UPDATE users SET main_trade = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, trade],
      );
    },

    async saveTrustAnswer(client, input) {
      const { workerId, professionKey, questionIndex, answerText, provenance } = input;

      // Mirrors handlers/custom-trust.ts:282's shape: answers accumulate in
      // the assessment row's `answers` JSONB array, one row per
      // (user_id, profession_key). Find the in-progress assessment (if any)
      // and merge; otherwise start one. No BEGIN/COMMIT/ROLLBACK — the
      // caller owns the transaction, and a later task persists answer
      // three and calls completeOnboarding on this same client/transaction.
      const existing = await client.query<{ id: string; answers: unknown }>(
        `SELECT id, answers FROM worker_trust_assessments
          WHERE user_id = $1 AND profession_key = $2
            AND status IN ('pending', 'scoring')
          ORDER BY created_at DESC
          LIMIT 1`,
        [workerId, professionKey],
      );

      const newAnswer = {
        question_index: questionIndex,
        answer_text: answerText,
        answered_at: clock.now().toISOString(),
      };

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const priorAnswers = Array.isArray(row.answers) ? row.answers : [];
        const mergedAnswers = [...priorAnswers, newAnswer];
        await client.query(
          `UPDATE worker_trust_assessments
              SET answers = $2::jsonb,
                  rubric_version = COALESCE($3, rubric_version),
                  scoring_model_id = COALESCE($4, scoring_model_id)
            WHERE id = $1`,
          [
            row.id,
            JSON.stringify(mergedAnswers),
            provenance?.rubricVersion ?? null,
            provenance?.scoringModelId ?? null,
          ],
        );
        return;
      }

      await client.query(
        `INSERT INTO worker_trust_assessments
            (id, user_id, profession_key, answers, status, rubric_version, scoring_model_id)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, $6)`,
        [
          randomUUID(),
          workerId,
          professionKey,
          JSON.stringify([newAnswer]),
          provenance?.rubricVersion ?? null,
          provenance?.scoringModelId ?? null,
        ],
      );
    },
  };
}

// ── Re-exported trade/trust vocabulary (no source-file edits) ─────────

/**
 * Delegates to `normalizeProfession` (lambda/whatsapp/handlers/custom-trust.ts:66).
 * The design doc says this lives in flows.ts — that is stale; the real
 * export is in custom-trust.ts.
 */
export function normalizeTrade(raw: string): string {
  return normalizeProfession(raw);
}

/**
 * Builds the three standard (non-custom-trade) bilingual trust questions for
 * a trade, sourced from `TRUST_QUESTIONS`/`getTrustOptions`/`buildTrustQuestion`
 * (lambda/whatsapp/lib/flows.ts:163,196,205) and `SENIORITY_OPTIONS` (:193).
 */
export function standardTrustQuestions(trade: string): TrustQuestion[] {
  return TRUST_STEPS.map((_, step) => ({
    q_en: buildTrustQuestion(step, trade, 'en'),
    q_es: buildTrustQuestion(step, trade, 'es'),
  }));
}

export { TRUST_QUESTIONS, SENIORITY_OPTIONS, getTrustOptions, buildTrustQuestion };

// ── createOnboardingV2Adapters ─────────────────────────────────────────

export interface CreateOnboardingV2AdaptersDeps {
  reconcileUserRow: ReconcileUserRowFn;
  clock?: { now(): Date };
  cognitoClient?: CognitoClient;
  userPoolId?: string;
  clientId?: string;
}

export function createOnboardingV2Adapters(
  deps: CreateOnboardingV2AdaptersDeps,
): OnboardingV2Adapters {
  const clock = deps.clock ?? { now: () => new Date() };
  const userPoolId = deps.userPoolId ?? process.env.WORKER_POOL_ID ?? '';
  const clientId = deps.clientId ?? process.env.WORKER_CLIENT_ID ?? '';

  return {
    clock,
    identity: createIdentityAdapter({
      cognitoClient: deps.cognitoClient,
      userPoolId,
      clientId,
      clock,
      reconcileUserRow: deps.reconcileUserRow,
    }),
    location: createLocationResolver(),
    trustQuestions: createTrustQuestionGenerator(),
    profile: createProfilePersistenceAdapter(clock),
  };
}
