// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { JobDetail } from '@/lib/api/worker';
import { renderIntl, message, expectNoRawMessageKeys } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The worker's half of lane D2: the job's facts are ONE card -- a pay
 * headline, eight tiles, requirement chips, the vault document rows and the
 * description -- in the order locked for all three job pages.
 *
 * Rendered against the REAL catalogues through the real provider (see
 * `render-intl`), because half of what this defends is copy: a section label
 * asked of the wrong namespace prints its own key path, and
 * `expectNoRawMessageKeys` is what catches that.
 *
 * The panels that are NOT the facts card are stubbed out -- `WhatYouNeedPanel`
 * renders certifications with their own required/optional wording, so leaving
 * it in would make every chip assertion below ambiguous about which surface it
 * matched.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/PayReferenceHint', () => ({
    PayReferenceHint: () => <p>pay reference hint</p>,
}));

vi.mock('@/components/worker/WhatYouNeedPanel', () => ({
    WhatYouNeedPanel: () => <div data-testid="what-you-need" />,
}));

vi.mock('@/components/worker/ShareJobPanel', () => ({
    ShareJobPanel: () => <div data-testid="share-job" />,
}));

vi.mock('@/components/worker/ProfileCompleteModal', () => ({
    ProfileCompleteModal: () => null,
}));

vi.mock('@/components/worker/apply-flow/ApplyFlow', () => ({
    ApplyFlow: () => <div data-testid="apply-flow" />,
}));

vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: vi.fn(),
    updateWorkerProfile: vi.fn(),
    getVaultDocuments: vi.fn(async () => []),
}));

/** Assigned by each test before rendering; the fake hook serves it. */
let seed: JobDetail;

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: seed,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: vi.fn(),
        refresh: vi.fn(),
        setData: vi.fn(),
    }),
}));

// Below every `vi.mock` on purpose (they hoist), matching the sibling page
// tests: the page module is imported once the fakes are already in place.
import WorkerJobDetailPage from '../page';

/** A job with every field the card can show populated. */
function fullJob(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Drywall Finisher',
        location: 'Austin, TX',
        job_type: 'full-time',
        company_name: 'RM Construction',
        pay_min: 22,
        pay_max: 26,
        pay_interval: 'hourly',
        start_date: '2026-06-15',
        expected_duration_bucket: '1_3m',
        work_days: ['mon', 'tue', 'wed'],
        shift_start: '07:00',
        shift_end: '16:00',
        transportation_required: true,
        work_authorization_required: true,
        language_preference: ['es'],
        number_of_workers_needed: 3,
        open_count: 1,
        trade_category: 'drywall',
        required_experience_years: 3,
        certification_requirements: [
            { name: 'OSHA 10', tier: 'required', proof_required: false },
            { name: 'Scaffold', tier: 'optional', proof_required: false },
        ],
        required_docs: ['resume'],
        missing_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: 'Framing and drywall on a new build.',
        status: 'active',
        already_applied: false,
        application_status: null,
        city_key: 'austin-tx',
        ...over,
    };
}

/** A legacy job with nothing but the fields the API always sends. */
function sparseJob(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Helper',
        location: 'Austin, TX',
        job_type: 'full-time',
        company_name: 'RM Construction',
        required_docs: [],
        missing_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: null,
        status: 'active',
        already_applied: false,
        application_status: null,
        ...over,
    };
}

/** Every tile in the facts card, in DOM order, as `[label, value]`. */
function tiles(container: HTMLElement): [string, string][] {
    return Array.from(container.querySelectorAll('dl > div')).map((tile) => [
        tile.querySelector('dt')?.textContent ?? '',
        tile.querySelector('dd')?.textContent ?? '',
    ]);
}

const t = (key: string) => message(`worker_job_detail.${key}`);

describe('worker job detail — the facts card', () => {
    it('sets pay as the one headline figure, not a fact row', () => {
        seed = fullJob();
        const { container } = renderIntl(<WorkerJobDetailPage />);

        expect(screen.getAllByText('$22–$26/hr')).toHaveLength(1);
        expect(screen.getByText(t('pay_range'))).toBeInTheDocument();
        // Pay in a tile would mean it reads exactly as loud as "Shift" again.
        expect(tiles(container).map(([label]) => label)).not.toContain(t('pay_range'));
    });

    it('keeps the pay reference hint under the figure', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.getByText('pay reference hint')).toBeInTheDocument();
    });

    it('renders the eight facts as dt/dd tiles in the locked order', () => {
        seed = fullJob();
        const { container } = renderIntl(<WorkerJobDetailPage />);

        expect(tiles(container)).toEqual([
            [t('shift_schedule'), 'Mon, Tue, Wed · 7:00 AM – 4:00 PM'],
            [t('expected_duration'), message('common.duration_bucket.1_3m')],
            [t('start_date'), 'June 15, 2026'],
            [t('openings'), '1/3'],
            [t('facts.location'), 'Austin, TX'],
            [t('trade'), message('employer_dashboard.modal.trade.drywall')],
            [t('required_experience'), '3'],
            [t('language'), message('public_job.language_es')],
        ]);
    });

    it('renders the two section labels as h3s under the panel title', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);

        expect(screen.getByRole('heading', { level: 2, name: t('facts.panel_title') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('facts.schedule') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('facts.where') })).toBeInTheDocument();
    });

    it('states each requirement as a chip with its state readable, not just coloured', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);

        const chips = screen.getByRole('heading', { level: 3, name: t('facts.requirements') })
            .parentElement!.querySelectorAll('li');
        expect(Array.from(chips).map((chip) => chip.textContent)).toEqual([
            `${t('transportation')}, ${message('common.requirement_state.required')}`,
            `${t('facts.work_authorization')}, ${message('common.requirement_state.required')}`,
            `OSHA 10, ${message('common.requirement_state.required')}`,
            `Scaffold, ${message('common.requirement_state.optional')}`,
        ]);
    });

    it('keeps the vault document rows as their own section', () => {
        seed = fullJob({ required_docs: ['resume'], missing_docs: ['resume'] });
        renderIntl(<WorkerJobDetailPage />);

        expect(screen.getByRole('heading', { level: 3, name: t('facts.documents') })).toBeInTheDocument();
        expect(screen.getByText(message('doc_types.resume'))).toBeInTheDocument();
        expect(screen.getByText(t('doc_missing'))).toBeInTheDocument();
    });

    it('renders the description under an About label carrying the posted date', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);

        expect(screen.getByText('Framing and drywall on a new build.')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', { level: 3, name: /About the job · posted Jun 1, 2026/ }),
        ).toBeInTheDocument();
    });

    it('renders no raw message key anywhere on the loaded page', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);
        expectNoRawMessageKeys();
    });

    it('renders the same card in Spanish without falling back to a key path', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />, 'es');
        expect(screen.getByRole('heading', { level: 3, name: message('worker_job_detail.facts.schedule', 'es') }))
            .toBeInTheDocument();
        expectNoRawMessageKeys();
    });

    describe('a sparse job', () => {
        it('omits the pay headline, the requirement chips and the About section', () => {
            seed = sparseJob();
            renderIntl(<WorkerJobDetailPage />);

            expect(screen.queryByText(t('pay_range'))).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('facts.requirements') })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: /About the job/ })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('facts.documents') })).toBeNull();
        });

        it('still shows the start tile, muted, saying the date is unconfirmed', () => {
            seed = sparseJob();
            const { container } = renderIntl(<WorkerJobDetailPage />);

            const start = Array.from(container.querySelectorAll('dl > div')).find(
                (tile) => tile.querySelector('dt')?.textContent === t('start_date'),
            );
            expect(start).toBeDefined();
            expect(start!.querySelector('dd')?.textContent).toBe(t('facts.start_unknown'));
            expect(start!.querySelector('dd')?.className).toContain('--jale-ink-2');
        });

        it('omits every tile whose value the job genuinely does not carry', () => {
            seed = sparseJob();
            const { container } = renderIntl(<WorkerJobDetailPage />);

            expect(tiles(container)).toEqual([
                [t('start_date'), t('facts.start_unknown')],
                [t('facts.location'), 'Austin, TX'],
            ]);
        });

        it('renders no raw message key', () => {
            seed = sparseJob();
            renderIntl(<WorkerJobDetailPage />);
            expectNoRawMessageKeys();
        });
    });
});
