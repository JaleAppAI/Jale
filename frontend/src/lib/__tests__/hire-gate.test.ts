import { describe, expect, it } from 'vitest';
import { hireBlockReason, hireBlocked, remainingCount } from '@/lib/hire-gate';
import type { RequirementsRemaining } from '@/lib/api/worker';

const remaining = (counts: Partial<RequirementsRemaining['counts']> = {}): RequirementsRemaining => ({
    prompts: [], fields: [], certifications: { unclaimed: [], unproven: [] }, docs: [],
    counts: { prompts: 0, fields: 0, certifications: 0, docs: 0, ...counts },
    complete: false,
});

describe('remainingCount', () => {
    it('sums all four blocking buckets', () => {
        expect(remainingCount(remaining({ prompts: 1, fields: 2, certifications: 3, docs: 4 }))).toBe(10);
    });

    it('separates "nothing published" from "nothing left"', () => {
        // `null` and `0` render differently -- one drops the count from the
        // badge, the other says there is genuinely nothing outstanding.
        expect(remainingCount(undefined)).toBeNull();
        expect(remainingCount(null)).toBeNull();
        expect(remainingCount(remaining())).toBe(0);
    });
});

describe('hireBlockReason', () => {
    it('blocks, and says which remedy applies, before details are requested', () => {
        expect(hireBlockReason({ details_status: 'not_requested' })).toBe('not_requested');
    });

    it('blocks while the request is outstanding', () => {
        expect(hireBlockReason({ details_status: 'requested' })).toBe('requested');
    });

    it('clears once the worker has completed their details', () => {
        expect(hireBlockReason({ details_status: 'complete' })).toBeNull();
    });

    it('FAILS OPEN when the API publishes no stage-2 vocabulary', () => {
        // Not knowing is not the same as knowing it is blocked. Blocking here
        // would make hiring impossible against the old API for the whole
        // window between the frontend and backend deploys; the 409 the page
        // already handles is the backstop.
        expect(hireBlockReason({})).toBeNull();
        expect(hireBlockReason(undefined)).toBeNull();
        expect(hireBlockReason(null)).toBeNull();
    });

    it('distinguishes its two reasons, because their hints differ', () => {
        expect(hireBlockReason({ details_status: 'not_requested' }))
            .not.toBe(hireBlockReason({ details_status: 'requested' }));
    });
});

describe('hireBlocked', () => {
    it('is the boolean shadow of hireBlockReason', () => {
        expect(hireBlocked({ details_status: 'not_requested' })).toBe(true);
        expect(hireBlocked({ details_status: 'requested' })).toBe(true);
        expect(hireBlocked({ details_status: 'complete' })).toBe(false);
        expect(hireBlocked(undefined)).toBe(false);
    });
});
