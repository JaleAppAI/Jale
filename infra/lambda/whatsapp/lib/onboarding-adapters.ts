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
import { ensureWorkerCognitoAccount } from '../../auth/lib/worker-cognito-reconciliation';
import {
  loadOrGenerateQuestions,
  normalizeProfession,
  type TrustQuestion,
} from '../handlers/custom-trust';
import { upsertWorkerProfileFromUsers } from './profile-flow';
import { slugCityKey } from '../../lib/city-fields';
import { UNAMBIGUOUS_CITY_TO_STATE } from './city-state-data';
// L6 (saveCustomTrade only): the canonicalising trade write plus the
// fire-and-forget alias-cache growth the repository deliberately leaves to its
// caller. `trade-alias-request` was already in this module's import graph via
// `../handlers/custom-trust` above.
import { saveCanonicalCustomTrade } from './onboarding-repository';
import { requestTradeAliasGeneration } from '../../lib/trade-alias-request';

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
  /**
   * `rotatedChallengeId` is REQUIRED (not optional) on purpose: Cognito
   * rotates the CUSTOM_CHALLENGE Session on every wrong answer, and the
   * NEXT submission is only valid against the rotated session. An optional
   * field would let every test fake omit it and silently re-mask the very
   * regression this fixes (v1 solved it in processor.ts's recordWrongOtp;
   * the v2 rewrite dropped it). `null` means the provider gave us no new
   * session (the SDK call threw a non-session error) — keep the old one.
   */
  | { status: 'invalid'; attemptsRemaining: number; attempts: number; rotatedChallengeId: string | null }
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
   *
   * The same contract covers the rotated session: on an 'invalid' result
   * the caller MUST persist `rotatedChallengeId` (when non-null) into
   * `providerChallengeId`, or the worker's second submission fails against
   * the stale Cognito session even when the code is correct.
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
        await ensureWorkerCognitoAccount({
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
        // resp === undefined also means there is NO rotated session below:
        // the caller keeps its stored one, and the next attempt lands on
        // the /session/i branch above → 'expired' → RESEND, which is the
        // correct recovery because that session genuinely cannot continue
        // (mirrors v1's recordWrongOtp(..., undefined) at processor.ts).
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
        // Cognito answered 200-with-new-Session for a wrong-but-retryable
        // answer (define-auth-challenge allows 3 in-session attempts, and
        // create-auth-challenge reuses the SAME code on retry). The caller
        // must persist this into providerChallengeId or the next
        // submission — even the correct code — dies on the stale session.
        rotatedChallengeId: resp?.Session ?? null,
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
const CITY_PART_RE = /^\p{L}[\p{L} .'-]*$/u;
const TWO_LETTER_CODE_RE = /^[A-Za-z]{2}$/;

// Full US state (+ DC, PR) names, in English and Spanish, mapped to their
// 2-letter USPS abbreviation. Keys MUST be pre-normalized: lowercase, no
// diacritics, single spaces (see `normalizeStateName`) — Spanish entries are
// therefore written WITHOUT accents (e.g. "nuevo mexico", not "nuevo méxico").
const STATE_NAME_TO_ABBREV: Record<string, string> = {
  // English
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
  'puerto rico': 'PR',
  // Colloquial alias
  tejas: 'TX',
  // Spanish (unaccented keys only — differing from English above)
  'nuevo hampshire': 'NH',
  'nueva jersey': 'NJ',
  'nuevo mexico': 'NM',
  'nueva york': 'NY',
  'carolina del norte': 'NC',
  'dakota del norte': 'ND',
  'carolina del sur': 'SC',
  'dakota del sur': 'SD',
  'virginia occidental': 'WV',
  'distrito de columbia': 'DC',
  dc: 'DC',
  // Spanish transliterations that differ from the English name by more than
  // accents (so they do NOT collapse onto the English key after
  // `normalizeStateName`'s diacritic strip — verified individually):
  hawai: 'HI',
  luisiana: 'LA',
  misuri: 'MO',
  misisipi: 'MS',
  pensilvania: 'PA',
};

function normalizeStateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createLocationResolver(): LocationResolver {
  return {
    resolve(raw: string): ResolvedLocation | null {
      const trimmed = (raw ?? '').trim();
      if (ZIP_RE.test(trimmed)) {
        return { city: null, state: null, postalCode: trimmed, source: 'zip' };
      }

      const lastComma = trimmed.lastIndexOf(',');
      if (lastComma === -1) return null;

      const cityPart = trimmed.slice(0, lastComma).trim();
      const statePart = trimmed.slice(lastComma + 1).trim();
      if (!CITY_PART_RE.test(cityPart)) return null;

      let stateAbbrev: string | null = null;
      if (TWO_LETTER_CODE_RE.test(statePart)) {
        stateAbbrev = statePart.toUpperCase();
      } else {
        const normalized = normalizeStateName(statePart);
        stateAbbrev = STATE_NAME_TO_ABBREV[normalized] ?? null;
      }
      if (!stateAbbrev) return null;

      return {
        city: cityPart,
        state: stateAbbrev,
        postalCode: null,
        source: 'city_state',
      };
    },
  };
}

/**
 * Bare-city inference: "El Paso" → { city: 'El Paso', state: 'TX' } when the
 * name maps to exactly one US state in the generated dataset. Strictly a
 * fallback for input the comma-requiring resolver rejects — never called
 * for input containing a comma or digits, and the result is only applied
 * after the worker confirms (1/2) in handleProfileLocation.
 */
export function inferCityState(raw: string): { city: string; state: string } | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.includes(',') || /\d/.test(trimmed)) return null;
  const state = UNAMBIGUOUS_CITY_TO_STATE[normalizeStateName(trimmed)];
  return state ? { city: trimmed, state } : null;
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
  /**
   * Defect 1 fix: persists the worker's raw, un-normalized typed profession
   * (e.g. "welder") into `users.main_trade_other` alongside
   * `main_trade = 'other'`. V1 already does this; V2's `handleCustomTrade`
   * previously normalized the text and threw the raw value away, which also
   * starved `upsertWorkerProfileFromUsers`'s starter-skill seed (it refuses
   * to seed the literal string 'other' and needs `main_trade_other` to seed
   * anything meaningful for a custom trade).
   */
  saveCustomTrade(client: PoolClient, workerId: string, rawProfession: string): Promise<void>;
  saveExperience(client: PoolClient, workerId: string, yearsExperience: string): Promise<void>;
  saveTransportation(client: PoolClient, workerId: string, hasTransportation: boolean): Promise<void>;
  saveAvailability(client: PoolClient, workerId: string, availability: string): Promise<void>;
  saveTrustAnswer(client: PoolClient, input: TrustAnswerInput): Promise<void>;
  /**
   * Defect 2 fix: the canonical "profile complete -> about to hand off to
   * trust" sync point. Calls the canonical `upsertWorkerProfileFromUsers`
   * projection (never re-implements it) and then reports whether the
   * resulting `worker_profiles`/`worker_skills` state has everything the
   * product needs (name, a skill, availability, location) so the caller can
   * fail closed rather than advance a worker into `trust.question.1` — and
   * eventually `ready` — with a profile the web app / matching engine will
   * reject.
   */
  syncProfileForTrustHandoff(client: PoolClient, workerId: string): Promise<ProfileSyncResult>;
}

/** Result of the pre-trust `syncProfileForTrustHandoff` gate. `missing` lists
 * which required fields are still absent after the sync ran, for structured
 * logging by the caller. */
export interface ProfileSyncResult {
  ready: boolean;
  missing: string[];
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
/**
 * Defect 3 fix: 'voice' is reserved for a later chunk (voice-answered trust
 * questions) — not implemented here. Typing the field as a union now, rather
 * than a bare 'text' literal, means that later addition only needs a new
 * caller value, not a widened type.
 */
export type TrustAnswerSource = 'text' | 'voice';

export interface TrustAnswerInput {
  workerId: string;
  professionKey: string;
  questionIndex: number;
  /** Bilingual question text, threaded through so `trust-scorer.ts`'s
   * `{ q_en, answer_text }` read (trust-scorer.ts:~154) resolves to real
   * text instead of `undefined`. */
  qEn: string;
  qEs: string;
  answerText: string;
  answerSource: TrustAnswerSource;
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
      // Defect 2 fix: a worker who hasn't hit the trust-handoff sync point
      // yet (or any earlier profile step) may have NO `worker_profiles` row
      // at all. The UPDATE below silently touches zero rows in that case.
      // Guaranteeing the row via the canonical projection first makes this
      // UPDATE meaningful for every worker, not just ones lucky enough to
      // already have a row.
      await upsertWorkerProfileFromUsers(client, workerId);

      const locationText =
        location.source === 'city_state' && location.city && location.state
          ? `${location.city}, ${location.state}`
          : location.postalCode;

      // `users.city` feeds profile-builder display; `worker_profiles.location`
      // (plain TEXT, 003_jobs_and_applications.sql) feeds the trust-handoff
      // readiness check.
      //
      // 2026-07-26 incident fix: this UPDATE must NEVER touch the five
      // coordinate columns (latitude, longitude, location_source,
      // location_confidence, location_updated_at). They are bound together by
      // the all-or-nothing CHECK `worker_profiles_location_complete`
      // (009_location_foundation.sql), and this adapter has no coordinates —
      // `ResolvedLocation` is regex-parsed text, not geocoded. Writing
      // location_source/location_updated_at alone violated the CHECK and
      // wedged every worker at profile.location. The only writer allowed to
      // touch that column group is lambda/lib/location.ts's
      // setWorkerCoordinates, which sets all five atomically.
      await client.query(
        `UPDATE users SET city = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, location.city ?? locationText],
      );
      await client.query(
        `UPDATE worker_profiles
            SET location = $2
          WHERE user_id = $1`,
        [workerId, locationText],
      );

      // Seed the worker's first preferred city so the web job feed is
      // city-filtered from day one. INSERT-only + ON CONFLICT DO NOTHING:
      // re-running onboarding never clobbers a list the worker curated in the
      // web app. ZIP-only answers carry no city (city is null) and seed nothing.
      if (location.source === 'city_state' && location.city && location.state) {
        await client.query(
          `INSERT INTO worker_preferred_cities (user_id, city_key, city, state)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, city_key) DO NOTHING`,
          [workerId, slugCityKey(location.city, location.state), location.city, location.state],
        );
      }
    },

    async saveTrade(client, workerId, trade) {
      await client.query(
        `UPDATE users SET main_trade = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, trade],
      );
    },

    async saveCustomTrade(client, workerId, rawProfession) {
      // Sprint 24 L6: the typed profession is canonicalised through the
      // bilingual `trade_aliases` cache before it is stored, so "soldador",
      // "Soldadura" and "welder" all become one trade (decision D4) instead of
      // three. `saveCanonicalCustomTrade` owns the SQL and reads the run's
      // preferred language itself — this adapter has no gate to pass through.
      // It writes nothing for blank input, and never a pair `chk_trade_other`
      // would reject.
      const written = await saveCanonicalCustomTrade(client, workerId, rawProfession);

      // The repository is DB-only by contract, so growing the cache is this
      // caller's job: ask the generator to learn any trade the cache did not
      // know, so the NEXT write canonicalises. `requestTradeAliasGeneration`
      // is fire-and-forget and never throws by contract; the try/catch is
      // defence in depth so learning a trade can never fail the worker's turn.
      if (written && !written.resolved && written.main_trade_other) {
        try {
          await requestTradeAliasGeneration(written.main_trade_other);
        } catch {
          // Swallowed intentionally -- see comment above.
        }
      }
    },

    async syncProfileForTrustHandoff(client, workerId) {
      // Reuse the canonical projection — never re-implement its SQL here.
      // This also (re-)seeds `worker_skills` from `main_trade_other`/
      // `main_trade`, which only works once `saveCustomTrade` has actually
      // written the raw profession text (Defect 1 fix).
      await upsertWorkerProfileFromUsers(client, workerId);

      const profileResult = await client.query<{
        full_name: string | null;
        availability: string | null;
        location: string | null;
      }>(
        `SELECT full_name, availability, location FROM worker_profiles WHERE user_id = $1`,
        [workerId],
      );
      const skillResult = await client.query<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM worker_skills WHERE worker_id = $1`,
        [workerId],
      );

      const profile = profileResult.rows[0] ?? null;
      const skillCount = Number(skillResult.rows[0]?.count ?? 0);

      const missing: string[] = [];
      if (!profile || !profile.full_name) missing.push('full_name');
      if (skillCount === 0) missing.push('skill');
      if (!profile || !profile.availability) missing.push('availability');
      if (!profile || !profile.location) missing.push('location');

      return { ready: missing.length === 0, missing };
    },

    async saveExperience(client, workerId, yearsExperience) {
      await client.query(
        `UPDATE users SET years_experience = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, yearsExperience],
      );
    },

    async saveTransportation(client, workerId, hasTransportation) {
      await client.query(
        `UPDATE users SET has_transportation = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, hasTransportation],
      );
    },

    async saveAvailability(client, workerId, availability) {
      await client.query(
        `UPDATE users SET availability = $2 WHERE id = $1 AND user_type = 'worker'`,
        [workerId, availability],
      );
    },

    async saveTrustAnswer(client, input) {
      const { workerId, professionKey, questionIndex, qEn, qEs, answerText, answerSource, provenance } = input;

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
        q_en: qEn,
        q_es: qEs,
        answer_text: answerText,
        answer_source: answerSource,
        answered_at: clock.now().toISOString(),
      };

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const priorAnswers = (Array.isArray(row.answers) ? row.answers : []) as Array<{
          question_index: number;
          [key: string]: unknown;
        }>;
        // Defect 4a fix: a worker who goes BACK and re-answers a question
        // must have the corrected answer REPLACE the old one, not accumulate
        // alongside it — the trust scorer (ai/trust-scorer.ts) sends every
        // element of this array to the model, so a stale duplicate would be
        // scored as if the worker gave two different answers to the same
        // question. Filter-then-append (never map-in-place) so a row that
        // ALREADY holds duplicates for this index — data written while the
        // old append behavior was live — collapses to a single entry here
        // instead of becoming N identical copies of the new answer. Kept
        // ordered by `question_index` so it never depends on insertion
        // order.
        const mergedAnswers = [
          ...priorAnswers.filter((a) => a.question_index !== questionIndex),
          newAnswer,
        ].sort((a, b) => a.question_index - b.question_index);
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
