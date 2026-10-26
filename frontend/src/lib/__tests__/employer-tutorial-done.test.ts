import { describe, expect, it } from 'vitest';
import {
    applicantsTutorialDone,
    createdSinceAppTour,
    EMPLOYER_APP_TOUR_RELEASED_AT,
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

    it('is unknown while the inbox is loading, whatever the page shows', () => {
        expect(applicantsTutorialDone(['pending', 'contacted'], inbox({ loading: true }))).toBeUndefined();
        expect(applicantsTutorialDone(['hired'], inbox({ loading: true }))).toBeUndefined();
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

    it('is unknown while the inbox retries after a failure', () => {
        expect(applicantsTutorialDone(['pending'], inbox({ loading: true, errorKind: 'network' }))).toBeUndefined();
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

describe('createdSinceAppTour (the app tour is for accounts created since its release)', () => {
    it('starts at midnight Mountain time on the release day', () => {
        expect(EMPLOYER_APP_TOUR_RELEASED_AT).toBe('2026-10-25T00:00:00-06:00');
        expect(createdSinceAppTour('2026-10-25T06:00:00.000Z')).toBe(true);
        expect(createdSinceAppTour('2026-10-25T05:59:59.999Z')).toBe(false);
    });
    it('is true after the release and false before it', () => {
        expect(createdSinceAppTour('2026-11-02T18:30:00Z')).toBe(true);
        expect(createdSinceAppTour('2026-08-01T00:00:00Z')).toBe(false);
    });
    it('is false for a missing or unreadable date', () => {
        expect(createdSinceAppTour(null)).toBe(false);
        expect(createdSinceAppTour(undefined)).toBe(false);
        expect(createdSinceAppTour('')).toBe(false);
        expect(createdSinceAppTour('not a date')).toBe(false);
    });
});
