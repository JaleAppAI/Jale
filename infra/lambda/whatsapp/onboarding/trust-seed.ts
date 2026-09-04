/**
 * WhatsApp v2 onboarding — the ONE place trust questions are seeded into
 * `session.state_context`.
 *
 * Sprint 22 R1-A: every trade — the five standard list-picker trades
 * (electrician/plumber/carpenter/concrete/painting) included — now takes the
 * same per-trade cache lane (`deps.adapters.trustQuestions.generate` ->
 * `trade_questions` row, or the Nova generator on a cache miss). The old
 * numbered-menu ("Reply with the number") question set is gone: a menu label
 * gives the AI scorer nothing to grade, so the standard trades were producing
 * un-scorable assessments.
 *
 * For a standard trade the caller passes the trade KEY (e.g. `'carpenter'`);
 * `normalizeProfession` (via `normalizeTrade`) maps it to exactly the
 * `trade_questions.profession_key` migration 012 seeds. For a custom trade the
 * caller passes the RAW typed profession, exactly as before.
 *
 * Sprint 24 L6: the key is now derived through `professionKeyForTrade`, so
 * every spelling and language of one trade shares ONE question set —
 * "soldador", "Soldadura" and "welder" all land on 'welder' instead of
 * generating three separate sets. Standard trade keys still pass through
 * untouched (that function short-circuits them without a DB round trip), which
 * is what keeps the five seeded 012 rows — `'painting'`, not the 060 alias
 * row's `'painter'` — reachable.
 */

import type { PoolClient } from 'pg';
import { professionKeyForTrade } from '../../lib/trade-canonical';
import { V2_FALLBACK_TRUST_QUESTIONS } from '../lib/interactive-templates';
import type { OnboardingV2Deps, OnboardingV2Session } from './types';
import {
  type BilingualQuestion,
  V2_TRUST_QUESTION_SET_VERSION,
  V2_TRUST_FALLBACK_VERSION,
  V2_TRUST_RUBRIC_VERSION,
} from './constants';

/** What was actually seeded — mirrored into the transition's contextPatch by
 * the callers so the workflow history records which lane a run took. */
export type TrustQuestionSource = 'generated' | 'fallback';

/**
 * Resolves the three bilingual trust questions for `professionRaw` and writes
 * them (plus their provenance versions) into `session.state_context`. Never
 * throws: the generator failing is a fallback, never a failed run.
 *
 * Deliberately does NOT set `v2ProfileTrade`/`v2CustomTradeText` — those carry
 * different values per call site (the trade key vs. the normalized custom
 * profession key) and stay the caller's business.
 */
export async function seedTrustQuestions(
  client: PoolClient,
  session: OnboardingV2Session,
  deps: OnboardingV2Deps,
  professionRaw: string,
): Promise<TrustQuestionSource> {
  // The generator never throws by contract (createTrustQuestionGenerator
  // catches internally), but an injected/production adapter failing in an
  // unexpected way must still fall back rather than fail the run.
  let generated: BilingualQuestion[] | null = null;
  try {
    // L6: canonical key, so spellings/languages of one trade share a question
    // set. `professionKeyForTrade` never throws — a `trade_aliases` miss or
    // outage degrades to `normalizeProfession(professionRaw)`, the pre-L6 key.
    const professionKey = await professionKeyForTrade(client, professionRaw);
    const result = await deps.adapters.trustQuestions.generate(client, professionKey);
    if (Array.isArray(result) && result.length === 3) {
      generated = result.map((q) => ({ en: q.q_en, es: q.q_es }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      metric: 'OnboardingTrustQuestionGenerationFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    generated = null;
  }

  const source: TrustQuestionSource = generated ? 'generated' : 'fallback';
  const questions: BilingualQuestion[] = generated ?? V2_FALLBACK_TRUST_QUESTIONS.map((q) => ({ ...q }));

  session.state_context.v2TrustQuestions = questions;
  session.state_context.v2TrustSource = source;
  session.state_context.v2QuestionSetVersion = source === 'fallback'
    ? V2_TRUST_FALLBACK_VERSION
    : V2_TRUST_QUESTION_SET_VERSION;
  session.state_context.v2RubricVersion = V2_TRUST_RUBRIC_VERSION;

  return source;
}
