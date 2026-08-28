/**
 * The web door's read model: one `OnboardingState` document, assembled from
 * the same tables the engine writes, under the same `jale_whatsapp` grants.
 *
 * Every endpoint on this door answers with the WHOLE document, so the browser
 * never has to guess what a mutation changed — it re-hydrates and re-renders.
 *
 * WHAT IS DELIBERATELY ABSENT. `worker_trust_assessments` also holds
 * `competency_score`, `score_components` and `score_rationale`. Workers must
 * never see their own score: it is an employer-facing signal, and a worker who
 * can read it can optimise against it. `jale_whatsapp` has no SELECT grant on
 * those columns at all (012:117 is column-scoped), so this is enforced by the
 * database, not just by the shape of the query — but the query names its
 * columns anyway, because `SELECT *` here is a hard 42501.
 */

import type { PoolClient } from 'pg';

import { loadRunContext } from '../onboarding/durable-context';
import type { WorkerGate } from '../lib/onboarding-repository';
import type { BilingualQuestion } from '../onboarding/constants';

export interface OnboardingLocationDto {
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface OnboardingStateDto {
  lifecycle: string;
  run: {
    id: string;
    stepKey: string;
    lockVersion: number;
    preferredLanguage: string;
    workflowVersion: number;
  };
  profile: {
    fullName: string | null;
    location: OnboardingLocationDto | null;
    trade: { key: string; other: string | null } | null;
    yearsExperience: string | null;
    hasTransportation: boolean | null;
    availability: string | null;
  };
  trust: {
    questions: Array<{ index: number; q_en: string; q_es: string }>;
    answers: Array<{ index: number; text: string; source: string }>;
  };
  pendingLocationConfirm: { city: string; state: string } | null;
  extraction: {
    status: string;
    extracted: Record<string, unknown> | null;
    summary_en: string | null;
    summary_es: string | null;
  } | null;
}

const ZIP = /^\d{5}$/;

interface UserProfileRow {
  full_name: string | null;
  city: string | null;
  main_trade: string | null;
  main_trade_other: string | null;
  years_experience: string | null;
  has_transportation: boolean | null;
  availability: string | null;
}

interface StoredAnswer {
  question_index?: unknown;
  answer_text?: unknown;
  answer_source?: unknown;
}

/**
 * `users.city` is the only place a ZIP-only answer lands: `saveLocation`
 * writes `location.city ?? locationText`, and a ZIP carries no city. A
 * city+state answer additionally seeds `worker_preferred_cities`, which is
 * the only place the STATE survives — `users` has no state column. So the
 * preferred city is the richer source when it exists, and `users.city` is the
 * fallback, read as a ZIP when it looks like one.
 */
function buildLocation(
  user: UserProfileRow | undefined,
  preferred: { city: string; state: string } | undefined,
): OnboardingLocationDto | null {
  if (preferred) return { city: preferred.city, state: preferred.state, zip: null };
  const raw = user?.city?.trim();
  if (!raw) return null;
  if (ZIP.test(raw)) return { city: null, state: null, zip: raw };
  return { city: raw, state: null, zip: null };
}

function buildQuestions(runContext: Record<string, unknown>): Array<{ index: number; q_en: string; q_es: string }> {
  const questions = runContext.v2TrustQuestions;
  if (!Array.isArray(questions)) return [];
  return (questions as BilingualQuestion[])
    .filter((q) => q && typeof q.en === 'string' && typeof q.es === 'string')
    // 1-BASED on the wire. The engine stores `question_index` 0-based
    // (`trust.question.N` -> N-1) but the browser addresses questions by the
    // screen number the worker sees, and the two must not be allowed to drift
    // silently: `trust.answers[i].index` below is offset the same way.
    .map((q, i) => ({ index: i + 1, q_en: q.en, q_es: q.es }))
    .slice(0, 3);
}

function buildAnswers(raw: unknown): Array<{ index: number; text: string; source: string }> {
  if (!Array.isArray(raw)) return [];
  return (raw as StoredAnswer[])
    .filter((a) => a && typeof a.answer_text === 'string' && Number.isInteger(a.question_index))
    .map((a) => ({
      index: (a.question_index as number) + 1,
      text: a.answer_text as string,
      source: typeof a.answer_source === 'string' ? a.answer_source : 'text',
    }))
    .sort((a, b) => a.index - b.index);
}

export async function buildOnboardingState(
  client: PoolClient,
  input: { workerId: string; gate: WorkerGate },
): Promise<OnboardingStateDto> {
  const { workerId, gate } = input;
  const runId = gate.runId as string;

  const runContext = await loadRunContext(client, runId);

  const user = await client.query<UserProfileRow>(
    `SELECT full_name, city, main_trade, main_trade_other,
            years_experience, has_transportation, availability
       FROM users WHERE id = $1`,
    [workerId],
  );

  // The FIRST preferred city is the one onboarding seeded; anything after it
  // the worker added themselves on the web profile, and re-rendering the
  // onboarding form around a later addition would be wrong.
  const preferred = await client.query<{ city: string; state: string }>(
    `SELECT city, state FROM worker_preferred_cities
      WHERE user_id = $1
      ORDER BY created_at, city_key
      LIMIT 1`,
    [workerId],
  );

  // Column-scoped: `answers` and `status` are granted (012:117 + 049), the
  // score columns are not.
  //
  // Scoped to the run's CURRENT trade, not merely to the newest row. A
  // cross-door RESTART that lands the worker on a different trade leaves the
  // abandoned profession's assessment as the newest row for this user, and
  // rendering its answers underneath the new trade's questions (which come
  // from `v2ProfileTrade`) would show the worker text they wrote about a
  // different job. `profession_key` is SELECT-granted (012:115) and the bag
  // already holds the NORMALIZED key — `profile.ts` writes
  // `v2ProfileTrade = normalizeTrade(professionRaw)`, the same value
  // `trust.ts` inserts — so this is an equality match, not a re-derivation.
  const professionKey = typeof runContext.v2ProfileTrade === 'string'
    ? runContext.v2ProfileTrade
    : null;
  const assessment = await client.query<{ id: string; answers: unknown }>(
    `SELECT id, answers FROM worker_trust_assessments
      WHERE user_id = $1
        AND ($2::text IS NULL OR profession_key = $2::text)
      ORDER BY created_at DESC
      LIMIT 1`,
    [workerId, professionKey],
  );

  // 086's column-scoped reader grant, under `wte_worker_own_internal`.
  const extraction = await client.query<{
    status: string;
    extracted: Record<string, unknown> | null;
    summary_en: string | null;
    summary_es: string | null;
  }>(
    `SELECT status, extracted, summary_en, summary_es
       FROM worker_trust_extractions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [workerId],
  );

  const userRow = user.rows[0];
  const mainTrade = userRow?.main_trade ?? null;
  const pending = runContext.v2LocationPendingConfirm as { city: string; state: string } | null | undefined;

  return {
    lifecycle: gate.lifecycle,
    run: {
      id: runId,
      stepKey: gate.currentStepKey as string,
      lockVersion: gate.lockVersion as number,
      preferredLanguage: gate.preferredLanguage,
      workflowVersion: gate.workflowVersion as number,
    },
    profile: {
      fullName: userRow?.full_name ?? null,
      location: buildLocation(userRow, preferred.rows[0]),
      trade: mainTrade ? { key: mainTrade, other: userRow?.main_trade_other ?? null } : null,
      yearsExperience: userRow?.years_experience ?? null,
      hasTransportation: userRow?.has_transportation ?? null,
      availability: userRow?.availability ?? null,
    },
    trust: {
      questions: buildQuestions(runContext),
      answers: buildAnswers(assessment.rows[0]?.answers),
    },
    pendingLocationConfirm: pending ?? null,
    extraction: extraction.rows[0]
      ? {
        status: extraction.rows[0].status,
        extracted: extraction.rows[0].extracted ?? null,
        summary_en: extraction.rows[0].summary_en,
        summary_es: extraction.rows[0].summary_es,
      }
      : null,
  };
}
