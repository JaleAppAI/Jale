import { describe, expect, it } from 'vitest';
import {
    applicantsTutorialDone,
    hasJobsDone,
    messagesTutorialDone,
    type InboxSignal,
} from '@/lib/employer-tutorial-done';

/*
 * K1.5: an employer tutorial auto-opens only for an account that has not yet
 * done the task it explains. `undefined` means "not known yet", and a host
 * waits for a boolean before it asks.
 */

const inbox = (over: Partial<InboxSignal> = {}): InboxSignal => ({
    loading: false,
    errorKind: null,
    items: [],
    ...over,
});
const row = (application_status: InboxSignal['items'][number]['application_status'], conversation_id: string | null = null) => ({
    application_status,
    conversation_id,
});

describe('hasJobsDone (welcome and post a job)', () => {
    it('is unknown until the jobs are loaded', () => {
        expect(hasJobsDone(null)).toBeUndefined();
        expect(hasJobsDone(undefined)).toBeUndefined();
    });

    it('is done once the employer has any job, and not before', () => {
        expect(hasJobsDone([])).toBe(false);
        expect(hasJobsDone([{ status: 'closed' }])).toBe(true);
    });
});

describe('applicantsTutorialDone', () => {
    it('is unknown while the page data is loading', () => {
        expect(applicantsTutorialDone(null, inbox())).toBeUndefined();
    });

    it('is unknown while the inbox is loading and the page shows nothing past applied', () => {
        expect(applicantsTutorialDone(['pending', 'contacted'], inbox({ loading: true }))).toBeUndefined();
    });

    it('is done when the page shows a status past applied', () => {
        for (const status of ['details_requested', 'hired', 'not_interested', 'rejected'] as const) {
            expect(applicantsTutorialDone(['pending', status], inbox())).toBe(true);
        }
    });

    it('does not count contacted or talking', () => {
        expect(applicantsTutorialDone(['contacted', 'talking', 'reviewed'], inbox())).toBe(false);
    });

    it('is done when the inbox shows a status past applied on another job', () => {
        expect(applicantsTutorialDone(['pending'], inbox({ items: [row('talking'), row('hired')] }))).toBe(true);
    });

    it('uses the page data alone when the inbox read failed', () => {
        expect(applicantsTutorialDone(['pending'], inbox({ errorKind: 'network' }))).toBe(false);
        expect(applicantsTutorialDone(['hired'], inbox({ errorKind: 'network' }))).toBe(true);
    });
});

describe('messagesTutorialDone', () => {
    it('is unknown while the inbox is loading or failed', () => {
        expect(messagesTutorialDone(inbox({ loading: true }))).toBeUndefined();
        expect(messagesTutorialDone(inbox({ errorKind: 'server' }))).toBeUndefined();
    });

    it('is done once any row has a conversation', () => {
        expect(messagesTutorialDone(inbox({ items: [row('pending'), row('contacted', 'conv-1')] }))).toBe(true);
    });

    it('is not done when no row has a conversation', () => {
        expect(messagesTutorialDone(inbox({ items: [row('pending'), row('hired')] }))).toBe(false);
        expect(messagesTutorialDone(inbox())).toBe(false);
    });
});
