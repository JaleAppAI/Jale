// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { EmployerJobDetail } from '@/lib/api/employer';
import { renderIntl, message, expectNoRawMessageKeys } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The employer's half of lane D2. The employer now reads the SAME card the
 * worker and a public visitor read -- same sections, same eight tiles, same
 * order -- so a posting cannot look like two different jobs depending on who
 * opened it. That is the whole point of the lane, and a shared component alone
 * does not prove it: each page still builds its own labels out of its own
 * namespace, which is what these assertions pin.
 *
 * Everything below the job panel (candidates, ranking, filters, the edit
 * modal) is stubbed: it is a large amount of unrelated machinery whose own
 * "Required"/"Optional" vocabulary would make the chip assertions ambiguous.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));

/*
 * Every hook fake below returns a STABLE identity, and that is load-bearing
 * rather than tidiness: the page's candidate-ranking effect lists
 * `handleLegalWall` in its dep array, so a fake that minted a fresh function
 * per render re-fired the effect, which `setRanking`s, which re-renders --
 * an unbounded loop that ends in a heap-exhaustion crash, not a test failure.
 */
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => router,
}));

const auth = { idToken: 'test-token' };
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => auth,
}));

const requireAuth = {
    handleLegalWall: (err: unknown) => {
        throw err;
    },
};
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => requireAuth,
}));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/employer/EditJobModal', () => ({
    EditJobModal: () => null,
}));

vi.mock('@/components/employer/PublicListingCard', () => ({
    PublicListingCard: () => <div data-testid="public-listing" />,
}));

vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => <div data-testid="filters" />,
    EMPTY_APPLICANT_FILTERS: {},
    hasActiveApplicantFilters: () => false,
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJob: vi.fn(),
    getJobApplicants: vi.fn(async () => ({ applicants: [] })),
    getJobCandidates: vi.fn(async () => []),
    getJobs: vi.fn(async () => []),
    deleteJob: vi.fn(),
    startConversation: vi.fn(),
    updateApplicantStatus: vi.fn(),
    updateJobStatus: vi.fn(),
}));

/**
 * Assigned by each test before rendering. `setSeed` rebuilds the page-data
 * object ONCE per test rather than per render, for the same stability reason
 * as the hooks above.
 */
let pageData: { job: EmployerJobDetail; applicants: never[]; appliedFilters: object };

function setSeed(job: EmployerJobDetail) {
    pageData = { job, applicants: [], appliedFilters: {} };
}

const noop = vi.fn();

vi.mock('@/hooks/usePageData', () => ({
    usePageData: () => ({
        phase: 'ready' as const,
        data: pageData,
        errorKind: null,
        refreshing: false,
        refreshError: false,
        retry: noop,
        refresh: noop,
        setData: noop,
    }),
}));

// Below every `vi.mock` on purpose (they hoist).
import EmployerJobDetailPage from '../page';

function fullJob(over: Partial<EmployerJobDetail> = {}): EmployerJobDetail {
    return {
        id: '11111111-2222-4333-8444-555555555555',
        title: 'Drywall Finisher',
        location: 'Austin, TX',
        pay: '$22-$26/hr',
        job_type: 'full-time',
        status: 'active',
        applicant_count: 4,
        hired_count: 1,
        open_count: 2,
        pay_min: 22,
        pay_max: 26,
        pay_interval: 'hourly',
        start_date: '2026-06-15',
        expected_duration: null,
        expected_duration_bucket: '1_3m',
        shift_schedule: null,
        work_days: ['mon', 'tue', 'wed'],
        shift_start: '07:00',
        shift_end: '16:00',
        transportation_required: true,
        work_authorization_required: true,
        language_preference: ['es'],
        number_of_workers_needed: 3,
        trade_category: 'drywall',
        required_experience_years: 3,
        required_experience_months: null,
        certifications: [],
        certification_requirements: [
            { name: 'OSHA 10', tier: 'required', proof_required: false },
            { name: 'Scaffold', tier: 'optional', proof_required: false },
        ],
        created_at: '2026-06-01T15:00:00.000Z',
        description: 'Framing and drywall on a new build.',
        required_docs: ['resume'],
        public_code: 'ABC123',
        public_listing_enabled: false,
        ...over,
    };
}

function sparseJob(over: Partial<EmployerJobDetail> = {}): EmployerJobDetail {
    return {
        id: '11111111-2222-4333-8444-555555555555',
        title: 'Helper',
        location: 'Austin, TX',
        pay: null,
        job_type: 'full-time',
        status: 'active',
        applicant_count: 0,
        hired_count: 0,
        open_count: 0,
        pay_min: null,
        pay_max: null,
        pay_interval: null,
        start_date: null,
        expected_duration: null,
        shift_schedule: null,
        transportation_required: false,
        work_authorization_required: false,
        language_preference: [],
        number_of_workers_needed: 1,
        trade_category: null,
        required_experience_years: null,
        required_experience_months: null,
        certifications: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: null,
        required_docs: [],
        public_code: 'ABC123',
        public_listing_enabled: false,
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

const t = (key: string) => message(`employer_job_listing.${key}`);
const shared = (key: string) => message(`employer_dashboard.${key}`);

describe('employer job detail — the facts card', () => {
    it('sets pay as the one headline figure, not a fact row', () => {
        setSeed(fullJob());
        const { container } = renderIntl(<EmployerJobDetailPage />);

        expect(screen.getAllByText('$22-$26/hr')).toHaveLength(1);
        expect(tiles(container).map(([label]) => label)).not.toContain(t('job.pay_range'));
    });

    it('renders the eight facts as dt/dd tiles in the same locked order the worker sees', () => {
        setSeed(fullJob());
        const { container } = renderIntl(<EmployerJobDetailPage />);

        expect(tiles(container)).toEqual([
            [shared('modal.shift_schedule'), 'Mon, Tue, Wed · 7:00 AM – 4:00 PM'],
            [shared('modal.expected_duration'), message('common.duration_bucket.1_3m')],
            [shared('modal.start_date'), 'June 15, 2026'],
            [t('job.hiring_progress'), '1/3 hired, 2 open'],
            [shared('modal.location'), 'Austin, TX'],
            [shared('modal.trade_category'), shared('modal.trade.drywall')],
            [shared('modal.required_experience_years'), '3'],
            [shared('modal.language_preference'), shared('modal.language.es')],
        ]);
    });

    it('renders the section labels as h3s under the panel title', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        expect(screen.getByRole('heading', { level: 2, name: t('job.panel_title') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.schedule') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.where') })).toBeInTheDocument();
    });

    it('states requirements, certifications and required documents as chips with a readable state', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        const chips = screen.getByRole('heading', { level: 3, name: t('job.facts.requirements') })
            .parentElement!.querySelectorAll('li');
        const required = message('common.requirement_state.required');
        expect(Array.from(chips).map((chip) => chip.textContent)).toEqual([
            `${t('job.facts.transportation')}, ${required}`,
            `${t('job.facts.work_authorization')}, ${required}`,
            `OSHA 10, ${required}`,
            `Scaffold, ${message('common.requirement_state.optional')}`,
            `${message('doc_types.resume')}, ${required}`,
        ]);
    });

    it('falls back to the legacy certification names when the job has no structured tiers', () => {
        setSeed(fullJob({ certification_requirements: null, certifications: ['Forklift'] }));
        renderIntl(<EmployerJobDetailPage />);

        const chips = screen.getByRole('heading', { level: 3, name: t('job.facts.requirements') })
            .parentElement!.querySelectorAll('li');
        expect(Array.from(chips).map((chip) => chip.textContent)).toContain(
            `Forklift, ${message('common.requirement_state.required')}`,
        );
    });

    it('renders the description under an About label carrying the posted date', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        expect(screen.getByText('Framing and drywall on a new build.')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', { level: 3, name: /About the job · posted Jun 1, 2026/ }),
        ).toBeInTheDocument();
    });

    it('renders no raw message key anywhere on the loaded page', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);
        expectNoRawMessageKeys();
    });

    describe('a sparse job', () => {
        it('omits the pay headline, the requirement chips and the About section', () => {
            setSeed(sparseJob());
            renderIntl(<EmployerJobDetailPage />);

            expect(screen.queryByText(t('job.pay_range'))).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('job.facts.requirements') })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: /About the job/ })).toBeNull();
        });

        it('still shows the start tile, muted, saying the date is unconfirmed', () => {
            setSeed(sparseJob());
            const { container } = renderIntl(<EmployerJobDetailPage />);

            const start = Array.from(container.querySelectorAll('dl > div')).find(
                (tile) => tile.querySelector('dt')?.textContent === shared('modal.start_date'),
            );
            expect(start).toBeDefined();
            expect(start!.querySelector('dd')?.textContent).toBe(t('job.facts.start_unknown'));
            expect(start!.querySelector('dd')?.className).toContain('--jale-ink-2');
        });

        it('renders no raw message key', () => {
            setSeed(sparseJob());
            renderIntl(<EmployerJobDetailPage />);
            expectNoRawMessageKeys();
        });
    });
});
