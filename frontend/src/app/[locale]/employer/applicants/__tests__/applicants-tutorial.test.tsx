// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicantOverviewItem, ApplicantsOverviewResponse } from '@/lib/api/employer';

/*
 * E3 on the Applicants board: the step-by-step applicants guide is asked on
 * the page view, once, when the board has applicants and the employer has not
 * yet moved anyone past applied (K1.5), as on a job's page and the applicant
 * profile. The hook is a recording handle; the guide itself has its own suite.
 */

const tutorial = vi.hoisted(() => ({
    options: {} as Record<string, { done: boolean | undefined; walkthrough?: boolean }>,
    handle: { maybeAutoOpen: vi.fn(), runWithHost: vi.fn(), replay: vi.fn() },
}));
vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: (id: string, options: { done: boolean | undefined; walkthrough?: boolean }) => {
        tutorial.options[id] = options;
        return tutorial.handle;
    },
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/employer/PostJobButton', () => ({ PostJobButton: () => null }));
vi.mock('@/contexts/PostJobContext', () => ({ useJobCreated: () => {} }));
vi.mock('../ApplicantOverviewRow', () => ({ ApplicantOverviewRow: () => <div /> }));

const inbox = vi.hoisted(() => ({ state: { loading: false, errorKind: null as unknown, items: [] as unknown[] } }));
vi.mock('@/contexts/UnreadMessagesContext', () => ({ useUnreadMessages: () => inbox.state }));

let seed: ApplicantsOverviewResponse;
vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        empty: seed.applicants.length === 0,
        errorKind: null,
        refreshing: false,
        refreshError: null,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

import { renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerApplicantsPage from '../page';

function row(id: string, over: Partial<ApplicantOverviewItem> = {}): ApplicantOverviewItem {
    return {
        application_id: id,
        worker_id: `w-${id}`,
        worker_name: null,
        job_id: 'j-1',
        job_title: 'Roofer',
        job_city: null,
        job_status: 'active',
        application_status: 'pending',
        applied_at: '2026-09-01T00:00:00Z',
        skills: [],
        availability: null,
        years_experience: null,
        match_score: null,
        score_band: null,
        hire_details: null,
        hire_details_needed: false,
        ...over,
    };
}

const marks = (name: string) => document.querySelectorAll(`[data-guide="${name}"]`);

beforeEach(() => {
    vi.clearAllMocks();
    tutorial.options = {};
    inbox.state = { loading: false, errorKind: null, items: [] };
});

describe('applicants board: the applicants guide', () => {
    it('asks once for the step-by-step guide when the board has applicants and nobody is past applied', () => {
        seed = { applicants: [row('a')], jobs: [], total: 1 };
        const view = renderIntl(<EmployerApplicantsPage />);
        expect(tutorial.options.employer_applicants).toEqual({ done: false, walkthrough: true });
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);

        view.rerender(<EmployerApplicantsPage />);
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });

    it('does not ask on an empty board', () => {
        seed = { applicants: [], jobs: [], total: 0 };
        renderIntl(<EmployerApplicantsPage />);
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('waits for the inbox before asking', () => {
        seed = { applicants: [row('a')], jobs: [], total: 1 };
        inbox.state = { loading: true, errorKind: null, items: [] };
        renderIntl(<EmployerApplicantsPage />);
        expect(tutorial.options.employer_applicants.done).toBeUndefined();
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();
    });

    it('passes done true when someone on the board is past applied', () => {
        seed = { applicants: [row('a'), row('b', { application_status: 'hired' })], jobs: [], total: 2 };
        renderIntl(<EmployerApplicantsPage />);
        expect(tutorial.options.employer_applicants.done).toBe(true);
    });

    it('marks the list, the job chips only with several jobs, and the start-details banner only when it shows', () => {
        seed = { applicants: [row('a')], jobs: [], total: 1 };
        const view = renderIntl(<EmployerApplicantsPage />);
        expect(marks('apps.board')).toHaveLength(1);
        expect(marks('apps.board_jobs')).toHaveLength(0);
        expect(marks('apps.hire_banner')).toHaveLength(0);
        view.unmount();

        seed = {
            applicants: [row('a', { application_status: 'hired', hire_details_needed: true }), row('b', { job_id: 'j-2' })],
            jobs: [
                { job_id: 'j-1', title: 'Roofer', city: null, status: 'active' },
                { job_id: 'j-2', title: 'Painter', city: null, status: 'active' },
            ],
            total: 2,
        };
        renderIntl(<EmployerApplicantsPage />);
        expect(marks('apps.board_jobs')).toHaveLength(1);
        expect(marks('apps.hire_banner')).toHaveLength(1);
    });
});
