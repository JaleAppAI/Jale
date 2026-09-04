import { describe, expect, it } from 'vitest';
import {
    SELECTABLE_APPLICATION_STATUSES,
    canRequestDetails,
    canResendDetails,
    detailsRequestFeedbackKey,
    hireBlockReason,
    hireBlocked,
    remainingCount,
} from '@/lib/hire-gate';
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

    it('KEEPS offering it once details are outstanding or in -- the button becomes the resend', () => {
        // Sprint 24 (B7) inverts the sprint-23 rule. `details_requested` is no
        // longer selectable in the status dropdown, so the button is the ONLY
        // control that sends the notification -- hiding it once details were
        // requested left an employer with no way to nudge a worker who never
        // answered. `details_status` no longer participates at all.
        expect(canRequestDetails({ status: 'details_requested', details_status: 'requested' })).toBe(true);
        expect(canRequestDetails({ status: 'talking', details_status: 'complete' })).toBe(true);
    });

    it('withdraws it on a terminal application, whatever the details say', () => {
        // Both directions: a hire is done, and a rejection is not reopened by
        // asking the worker for paperwork.
        expect(canRequestDetails({ status: 'hired', details_status: 'complete' })).toBe(false);
        expect(canRequestDetails({ status: 'not_interested', details_status: 'not_requested' })).toBe(false);
    });

    it('keeps offering it while the employer moves a requested applicant along', () => {
        // `status` and `details_status` legitimately disagree, and neither
        // disagreement withdraws the control any more -- only a TERMINAL
        // status does.
        expect(canRequestDetails({ status: 'contacted', details_status: 'requested' })).toBe(true);
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

describe('SELECTABLE_APPLICATION_STATUSES', () => {
    it('omits details_requested -- the button owns that move, not the dropdown', () => {
        // Owner ruling (B7): the status select could reach `details_requested`
        // WITHOUT sending the notification whenever Save was pressed on an
        // already-requested row, so the employer had two controls that looked
        // identical and behaved differently. The dropdown loses the option.
        expect(SELECTABLE_APPLICATION_STATUSES).not.toContain('details_requested');
    });

    it('keeps every other status, in the API order', () => {
        expect(SELECTABLE_APPLICATION_STATUSES).toEqual([
            'pending', 'contacted', 'talking', 'hired', 'not_interested',
        ]);
    });
});

describe('canResendDetails', () => {
    it('is true only while the application actually sits at details_requested', () => {
        expect(canResendDetails('details_requested')).toBe(true);
    });

    it('is false for every other status, including the terminal ones', () => {
        for (const status of ['pending', 'contacted', 'talking', 'hired', 'not_interested'] as const) {
            expect(canResendDetails(status)).toBe(false);
        }
    });

    it('is false when the status is unknown', () => {
        expect(canResendDetails(undefined)).toBe(false);
    });
});

describe('detailsRequestFeedbackKey', () => {
    it('claims the WhatsApp message only when the backend says it went out', () => {
        expect(detailsRequestFeedbackKey({ notified: true })).toBe('request_details_notified');
    });

    it('says no message was sent when the worker has no WhatsApp on file', () => {
        expect(detailsRequestFeedbackKey({ notified: false, notify_reason: 'renderer_unavailable' }))
            .toBe('request_details_no_whatsapp');
    });

    it('says it was already requested when nothing changed and no resend was asked for', () => {
        expect(detailsRequestFeedbackKey({ notified: false, notify_reason: 'unchanged' }))
            .toBe('request_details_unchanged');
    });

    it('FAILS OPEN to the neutral line when the API publishes no outcome', () => {
        // Same rule the rest of this module follows: an API that has not
        // shipped `notified` is not evidence that nothing was sent. The
        // neutral copy promises a future notification rather than asserting a
        // past one, so it is honest either way.
        expect(detailsRequestFeedbackKey({})).toBe('request_details_sent');
        expect(detailsRequestFeedbackKey(undefined)).toBe('request_details_sent');
    });

    it('degrades to the neutral line for a reason this build has no sentence for', () => {
        expect(detailsRequestFeedbackKey({ notified: false, notify_reason: 'not_notifiable_status' }))
            .toBe('request_details_sent');
        expect(detailsRequestFeedbackKey({ notified: false })).toBe('request_details_sent');
    });
});
