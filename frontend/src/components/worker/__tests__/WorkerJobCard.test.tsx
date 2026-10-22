// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { Job } from '@/lib/api/worker';
import { WorkerJobCard } from '@/components/worker/WorkerJobCard';
import { expectNoRawMessageKeys, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * Decided 2026-10-01: a referred job sits at the top of the worker's feed with
 * NO special tag. The backend still prepends the `referred_job` match reason
 * to such a job, so hiding it is this card's job -- and it has
 * to happen BEFORE the three-reason cut, or the hidden reason would still
 * spend one of the three slots on nothing.
 *
 * Dropping the key from the translated set alone would not do it either: an
 * unknown code falls through to `humanizeReasonCode` and renders as
 * "Referred Job".
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

function job(over: Partial<Job> = {}): Job {
    return {
        id: 'job-1',
        title: 'Concrete Finisher',
        location: 'San Antonio, TX',
        job_type: 'full-time',
        company_name: 'NB Construction',
        pay_min: 22,
        pay_max: 26,
        pay_interval: 'hourly',
        required_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        ...over,
    };
}

/** The chips' text, in order: each one is a badge with a `title` carrying its full reason. */
function chipTexts(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('span[title]')).map((chip) => chip.textContent ?? '');
}

describe('WorkerJobCard — a referred job carries no tag', () => {
    it('shows no referral chip for a job the backend marks referred_job', () => {
        const { container } = renderIntl(
            <WorkerJobCard job={job({ match_reasons: ['referred_job', 'trade_match'] })} href="/worker/jobs/job-1" />,
        );

        expect(screen.queryByText(/referred/i)).not.toBeInTheDocument();
        // The other reason still shows -- the filter takes out one code, not the row.
        expect(chipTexts(container)).toEqual(['Trade Match']);
    });

    it('gives the slot it held to the next real reason', () => {
        const { container } = renderIntl(
            <WorkerJobCard
                job={job({ match_reasons: ['referred_job', 'profession_exact_or_alias', 'zip_exact', 'fresh_posting'] })}
                href="/worker/jobs/job-1"
            />,
        );

        expect(chipTexts(container)).toEqual([
            message('match.reasons.profession_exact_or_alias'),
            message('match.reasons.zip_exact'),
            message('match.reasons.fresh_posting'),
        ]);
    });

    it('draws no chip row at all when the referral was the only reason', () => {
        const { container } = renderIntl(
            <WorkerJobCard job={job({ match_reasons: ['referred_job'] })} href="/worker/jobs/job-1" />,
        );

        expect(chipTexts(container)).toEqual([]);
        expect(screen.queryByText(/referred/i)).not.toBeInTheDocument();
    });

    it('says nothing about a referral in Spanish either', () => {
        const { container } = renderIntl(
            <WorkerJobCard job={job({ match_reasons: ['referred_job', 'zip_exact'] })} href="/worker/jobs/job-1" />,
            'es',
        );

        expect(screen.queryByText(/recomend|referred/i)).not.toBeInTheDocument();
        expect(chipTexts(container)).toEqual([message('match.reasons.zip_exact', 'es')]);
        expectNoRawMessageKeys();
    });

    it('has no catalogue entry left for the tag in either language', () => {
        expect(() => message('match.reasons.referred_job')).toThrow();
        expect(() => message('match.reasons.referred_job', 'es')).toThrow();
    });
});

/*
 * Openings read as words: "2/5 open" made workers ask whether two people were
 * hired or two spots were left. The board copy says which.
 */
describe('WorkerJobCard — spots open', () => {
    it('says how many of the spots are still open', () => {
        renderIntl(<WorkerJobCard job={job({ open_count: 2, number_of_workers_needed: 5 })} href="/worker/jobs/job-1" />);
        expect(screen.getByText('2 of 5 spots open')).toBeInTheDocument();
    });

    it('says it in Spanish', () => {
        renderIntl(
            <WorkerJobCard job={job({ open_count: 2, number_of_workers_needed: 5 })} href="/worker/jobs/job-1" />,
            'es',
        );
        expect(screen.getByText('2 de 5 lugares disponibles')).toBeInTheDocument();
    });

    it('says nothing about spots when the job does not carry the counts', () => {
        renderIntl(<WorkerJobCard job={job({ open_count: null, number_of_workers_needed: 5 })} href="/worker/jobs/job-1" />);
        expect(screen.queryByText(/spots open/)).not.toBeInTheDocument();
    });
});
