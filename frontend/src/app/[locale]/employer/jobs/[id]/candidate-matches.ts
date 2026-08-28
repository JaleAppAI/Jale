import type { ScoreBand } from '@/lib/match';
import { normalizeMatchScore, normalizeScoreBand, truncateMatchReason } from '@/lib/match';

/** Everything the applicant list needs to say about ONE candidate's ranking. */
export type ApplicantMatch = {
    match_score: number;
    score_band: ScoreBand;
    match_reasons: string[];
    /**
     * `users.trade_competency_score`, surfaced by the candidate ranking.
     * `null` means the worker never completed a trust assessment -- which is
     * NOT the same as scoring zero, and the two must stay distinguishable all
     * the way to the pill, so this is never coerced to a number.
     */
    trust_score: number | null;
};

/**
 * pg hands a NUMERIC column back as a string, and the ranking payload has
 * always typed `trust_score` as `number | string | null` because of it.
 * Anything that is not a finite number reads as "no score", never as 0.
 */
function normalizeTrustScore(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Index the ranking response by BOTH ids the applicant list might hold.
 *
 * Lives beside `page.tsx` rather than inside it because Next 14 refuses any
 * named export from a page module ("is not a valid Page export field"), and a
 * pure function that decides what an employer sees on every applicant row is
 * exactly the kind of thing that should be under test.
 */
export function buildCandidateMatchMap(
    candidates: Array<{
        application_id?: string | null;
        worker_id: string;
        match_score: number;
        score_band: ScoreBand;
        match_reasons?: string[];
        trust_score?: number | string | null;
    }>,
): Map<string, ApplicantMatch> {
    const matches = new Map<string, ApplicantMatch>();

    for (const candidate of candidates) {
        const score = normalizeMatchScore(candidate.match_score);
        if (score === null) continue;

        const match: ApplicantMatch = {
            match_score: score,
            score_band: normalizeScoreBand(candidate.score_band, score),
            match_reasons: (candidate.match_reasons ?? [])
                .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
                .slice(0, 3)
                .map((reason) => truncateMatchReason(reason)),
            trust_score: normalizeTrustScore(candidate.trust_score),
        };

        if (candidate.application_id) matches.set(candidate.application_id, match);
        matches.set(candidate.worker_id, match);
    }

    return matches;
}
