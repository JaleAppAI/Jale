import { describe, expect, it } from 'vitest';
import {
    applicationStatusBadgeTone,
    jobStatusBadgeTone,
    matchScoreBadgeTone,
    scoreBandBadgeTone,
} from '@/components/ui/badge';
import { getInitials } from '@/components/ui/initials-avatar';
import type { ApplicationStatus, JobStatus } from '@/lib/status';

/**
 * The presentation kit's pure logic. Rendering is verified by eye (vitest runs
 * in a `node` environment here, with no DOM), but these two pieces decide what
 * a user actually sees and are cheap to pin down:
 *
 *  - the status -> BadgeTone adapters, which read `lib/status.ts` at runtime
 *    rather than restating it. If someone edits a status's dot token to one the
 *    badge palette does not know, the adapter must still return a real tone
 *    instead of `undefined` (which would render a dotless badge).
 *  - getInitials, which is the one implementation left after nav-config's
 *    duplicate was deleted.
 */

describe('badge status adapters', () => {
    const jobStatuses: JobStatus[] = ['active', 'paused', 'filled', 'closed'];
    const applicationStatuses: ApplicationStatus[] = [
        'pending',
        'contacted',
        'talking',
        'details_requested',
        'hired',
        'not_interested',
    ];

    it('maps every job status to a known tone', () => {
        expect(jobStatuses.map(jobStatusBadgeTone)).toEqual([
            'success', // active
            'info', // paused
            'neutral', // filled
            'neutral', // closed
        ]);
    });

    it('maps every application status to a known tone', () => {
        expect(applicationStatuses.map(applicationStatusBadgeTone)).toEqual([
            'neutral', // pending
            'info', // contacted
            'info', // talking
            'warning', // details_requested
            'success', // hired
            'danger', // not_interested
        ]);
    });

    it('normalizes legacy application statuses before choosing a tone', () => {
        expect(applicationStatusBadgeTone('reviewed')).toBe(applicationStatusBadgeTone('contacted'));
        expect(applicationStatusBadgeTone('rejected')).toBe(
            applicationStatusBadgeTone('not_interested'),
        );
    });

    it('maps match bands and raw scores consistently', () => {
        expect(scoreBandBadgeTone('strong')).toBe('success');
        expect(scoreBandBadgeTone('good')).toBe('info');
        expect(scoreBandBadgeTone('fair')).toBe('warning');

        // Band thresholds live in lib/match.ts (>=70 strong, >=45 good).
        expect(matchScoreBadgeTone(90)).toBe('success');
        expect(matchScoreBadgeTone(50)).toBe('info');
        expect(matchScoreBadgeTone(10)).toBe('warning');
    });
});

describe('getInitials', () => {
    it('takes the first letter of the first two words, uppercased', () => {
        expect(getInitials('ada lovelace')).toBe('AL');
        expect(getInitials('Jale Construction Group')).toBe('JC');
        expect(getInitials('Prince')).toBe('P');
    });

    it('collapses irregular whitespace', () => {
        expect(getInitials('  maria   del  carmen  ')).toBe('MD');
        expect(getInitials('\tluis\ngomez')).toBe('LG');
    });

    it('falls back when there is nothing to initialise', () => {
        expect(getInitials('', 'W')).toBe('W');
        expect(getInitials('   ', 'E')).toBe('E');
        expect(getInitials('')).toBe('?');
    });

    it('keeps non-latin scripts rather than dropping them', () => {
        expect(getInitials('Ángel Núñez')).toBe('ÁN');
    });
});
