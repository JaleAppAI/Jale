import { describe, expect, it } from 'vitest';
import { buildCandidateMatchMap } from '../candidate-matches';

const candidate = (over: Partial<Parameters<typeof buildCandidateMatchMap>[0][number]> = {}) => ({
    worker_id: 'w1',
    match_score: 80,
    score_band: 'strong' as const,
    ...over,
});

describe('buildCandidateMatchMap', () => {
    it('carries the trust score through to the row', () => {
        const map = buildCandidateMatchMap([candidate({ trust_score: 78 })]);
        expect(map.get('w1')?.trust_score).toBe(78);
    });

    it('keeps a null trust score null rather than coercing it to zero', () => {
        // A worker who never took the assessment is not a worker who scored 0,
        // and `Number(null)` is 0 -- the pill must be able to tell them apart.
        expect(buildCandidateMatchMap([candidate({ trust_score: null })]).get('w1')?.trust_score).toBeNull();
        expect(buildCandidateMatchMap([candidate()]).get('w1')?.trust_score).toBeNull();
    });

    it('coerces the numeric-string form the ranking payload can carry', () => {
        // `trade_competency_score` arrives through the candidate ranking, where
        // pg can hand a NUMERIC back as a string.
        expect(
            buildCandidateMatchMap([candidate({ trust_score: '64' as unknown as number })]).get('w1')?.trust_score,
        ).toBe(64);
    });

    it('treats an unparseable trust score as absent', () => {
        expect(
            buildCandidateMatchMap([candidate({ trust_score: 'n/a' as unknown as number })]).get('w1')?.trust_score,
        ).toBeNull();
    });

    it('still indexes by application_id as well as worker_id', () => {
        const map = buildCandidateMatchMap([candidate({ application_id: 'a1', trust_score: 12 })]);
        expect(map.get('a1')?.trust_score).toBe(12);
        expect(map.get('w1')?.trust_score).toBe(12);
    });

    it('drops a candidate whose match score cannot be normalized', () => {
        const map = buildCandidateMatchMap([candidate({ match_score: Number.NaN, trust_score: 90 })]);
        expect(map.size).toBe(0);
    });

    it('keeps the existing match-reason handling', () => {
        const map = buildCandidateMatchMap([
            candidate({ match_reasons: ['one', '  ', 'two', 'three', 'four'] }),
        ]);
        expect(map.get('w1')?.match_reasons).toHaveLength(3);
    });
});
