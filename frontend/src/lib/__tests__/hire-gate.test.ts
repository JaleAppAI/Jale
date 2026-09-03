import { describe, expect, it } from 'vitest';
import { canRequestDetails, hireBlockReason, hireBlocked, remainingCount } from '@/lib/hire-gate';
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

describe('canRequestDetails', () => {
    it('offers the action on a live application nobody has asked yet', () => {
        expect(canRequestDetails({ status: 'pending', details_status: 'not_requested' })).toBe(true);
        expect(canRequestDetails({ status: 'contacted', details_status: 'not_requested' })).toBe(true);
    });

    it('withdraws it once details are outstanding or in -- nothing to ask twice', () => {
        expect(canRequestDetails({ status: 'details_requested', details_status: 'requested' })).toBe(false);
        expect(canRequestDetails({ status: 'talking', details_status: 'complete' })).toBe(false);
    });

    it('withdraws it on a terminal application, whatever the details say', () => {
        // Both directions: a hire is done, and a rejection is not reopened by
        // asking the worker for paperwork.
        expect(canRequestDetails({ status: 'hired', details_status: 'complete' })).toBe(false);
        expect(canRequestDetails({ status: 'not_interested', details_status: 'not_requested' })).toBe(false);
    });

    it('keeps offering it while the employer moves a requested applicant along', () => {
        // `status` and `details_status` legitimately disagree -- but a
        // `contacted` applicant whose details are already requested must not
        // be asked again.
        expect(canRequestDetails({ status: 'contacted', details_status: 'requested' })).toBe(false);
    });

    it('FAILS OPEN when the API publishes no details_status', () => {
        expect(canRequestDetails({ status: 'pending' })).toBe(true);
        expect(canRequestDetails({})).toBe(true);
    });

    it('has nothing to offer without an application at all', () => {
        expect(canRequestDetails(null)).toBe(false);
        expect(canRequestDetails(undefined)).toBe(false);
    });
});
