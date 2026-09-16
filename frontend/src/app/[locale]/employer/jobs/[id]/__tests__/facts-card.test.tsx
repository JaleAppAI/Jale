// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmployerJobDetail } from '@/lib/api/employer';
import { JobDetailSkeleton } from '@/components/ui/page-skeletons';
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

/** The chips in one labelled row, as their full accessible text. */
function chipsUnder(label: string): string[] {
    const row = screen.getByRole('heading', { level: 3, name: label }).parentElement!;
    return Array.from(row.querySelectorAll('li')).map((chip) => chip.textContent ?? '');
}

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
            [shared('modal.required_experience_years'), '3 years'],
            [shared('modal.language_preference'), shared('modal.language.es')],
        ]);
    });

    /*
     * A bare "3" under "Experience" is a number, not a requirement -- it reads
     * as a score as readily as a duration. The unit comes from the same shared
     * formatter the worker and public pages use, so the three surfaces cannot
     * describe the same column differently.
     */
    it('carries the unit for months, and for a years/months pair', () => {
        setSeed(fullJob({ required_experience_years: null, required_experience_months: 6 }));
        const { container: monthsOnly } = renderIntl(<EmployerJobDetailPage />);
        expect(tiles(monthsOnly)).toContainEqual([
            shared('modal.required_experience_years'), '6 months',
        ]);

        setSeed(fullJob({ required_experience_years: 2, required_experience_months: 6 }));
        const { container: both } = renderIntl(<EmployerJobDetailPage />);
        expect(tiles(both)).toContainEqual([
            shared('modal.required_experience_years'), '2 years 6 months',
        ]);
    });

    /*
     * Zero is a STATED requirement, and the tile is rendered for it (the guard
     * is on null, not on falsiness) -- so it has to say what zero means rather
     * than print the digit.
     */
    it('says no experience is required for a stated zero', () => {
        setSeed(fullJob({ required_experience_years: 0, required_experience_months: 0 }));
        const { container } = renderIntl(<EmployerJobDetailPage />);

        expect(tiles(container)).toContainEqual([
            shared('modal.required_experience_years'), message('common.experience_none'),
        ]);
    });

    it('renders the section labels as h3s under the panel title', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        expect(screen.getByRole('heading', { level: 2, name: t('job.panel_title') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.schedule') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.where') })).toBeInTheDocument();
    });

    /*
     * Three LABELLED rows, not one flat strip (owner ruling, fix round 1): a
     * policy, a credential and a file cost an applicant three different things,
     * and an employer proofreading their own posting has to tell them apart.
     */
    it('splits the chips into policy, certification and document rows', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        const required = message('job_requirements.states.required');
        expect(chipsUnder(t('job.facts.requirements'))).toEqual([
            `${t('job.facts.transportation')}, ${required}`,
            `${t('job.facts.work_authorization')}, ${required}`,
        ]);
        expect(chipsUnder(t('job.certifications_title'))).toEqual([
            `OSHA 10, ${required}`,
            `Scaffold, ${message('job_requirements.states.optional')}`,
        ]);
        expect(chipsUnder(t('job.required_documents_title'))).toEqual([
            `${message('doc_types.resume')}, ${required}`,
        ]);
    });

    it('falls back to the legacy certification names when the job has no structured tiers', () => {
        setSeed(fullJob({ certification_requirements: null, certifications: ['Forklift'] }));
        renderIntl(<EmployerJobDetailPage />);

        expect(chipsUnder(t('job.certifications_title'))).toEqual([
            `Forklift, ${message('job_requirements.states.required')}`,
        ]);
    });

    it('renders the description under a plain About label, the date in the header', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);

        expect(screen.getByText('Framing and drywall on a new build.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.about') })).toBeInTheDocument();
        expect(
            screen.getByText(shared('panels.posted_on').replace('{date}', 'Jun 1, 2026')),
        ).toBeInTheDocument();
    });

    it('renders no raw message key anywhere on the loaded page', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />);
        expectNoRawMessageKeys();
    });

    it('renders the same card in Spanish without falling back to a key path', () => {
        setSeed(fullJob());
        renderIntl(<EmployerJobDetailPage />, 'es');
        expect(
            screen.getByRole('heading', { level: 3, name: message('employer_job_listing.job.facts.schedule', 'es') }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('heading', { level: 3, name: message('employer_job_listing.job.facts.where', 'es') }),
        ).toBeInTheDocument();
        expectNoRawMessageKeys();
    });

    /*
     * Same contract as the worker page's test: the skeleton is traced from THIS
     * card, so it is compared with the loaded card block for block. The
     * employer card has four blocks (there is no document block -- the
     * documents are the third chip row inside "where"), and the skeleton drew
     * five until the 2026-09-08 cross-lane review caught it.
     */
    describe('the loading skeleton', () => {
        const realShape = (section: Element) => ({
            tiles: section.querySelector('dl')?.children.length ?? 0,
            chipRows: section.querySelectorAll('ul[role="list"]').length,
        });
        const skeletonShape = (block: Element) => ({
            tiles: block.querySelector('[data-skeleton="tiles"]')?.children.length ?? 0,
            chipRows: block.querySelectorAll('[data-skeleton="requirements"]').length,
        });

        it('has the same block structure as the loaded card', () => {
            setSeed(fullJob());
            const page = renderIntl(<EmployerJobDetailPage />);
            const real = Array.from(page.container.querySelectorAll('[data-section]'));
            page.unmount();

            const skeleton = renderIntl(<JobDetailSkeleton variant="employer" />);
            const blocks = Array.from(skeleton.container.querySelectorAll('[data-skeleton-section]'));

            expect(real.length).toBeGreaterThan(0);
            expect(blocks.map(skeletonShape)).toEqual(real.map(realShape));
            expect(blocks[0].querySelector('[data-skeleton="headline"]')).not.toBeNull();
            expect(skeleton.container.querySelector('[data-skeleton="documents"]')).toBeNull();
            expect(blocks[3].querySelector('[data-skeleton="text"]')).not.toBeNull();
        });

        it('is the variant both the page and its route skeleton mount', () => {
            const dir = path.dirname(fileURLToPath(import.meta.url));
            for (const file of ['../page.tsx', '../loading.tsx']) {
                const source = fs.readFileSync(path.resolve(dir, file), 'utf8');
                expect(source, file).toMatch(/<JobDetailSkeleton\s[^>]*variant="employer"/);
                expect(source, file).not.toContain('variant="worker"');
            }
        });
    });

    /*
     * Owner ruling, fix round 1: the posted date is a header badge, not part of
     * the About label, so an employer who never wrote a description still sees
     * how old their own posting is -- the number that explains a quiet
     * applicant list.
     */
    it('states when the job was posted even with no description written', () => {
        setSeed(sparseJob());
        renderIntl(<EmployerJobDetailPage />);

        // `message` returns the raw ICU template, so the date is substituted
        // here rather than hardcoding the English sentence around it.
        expect(
            screen.getByText(shared('panels.posted_on').replace('{date}', 'Jun 1, 2026')),
        ).toBeInTheDocument();
        // The employer's own card keeps the About section either way: an empty
        // description is a prompt to write one, not a section to hide.
        expect(screen.getByRole('heading', { level: 3, name: t('job.facts.about') })).toBeInTheDocument();
        expect(screen.getByText(t('job.no_description'))).toBeInTheDocument();
    });

    describe('a sparse job', () => {
        it('omits the pay headline and the requirement chips', () => {
            setSeed(sparseJob());
            renderIntl(<EmployerJobDetailPage />);

            expect(screen.queryByText(t('job.pay_range'))).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('job.facts.requirements') })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('job.certifications_title') })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('job.required_documents_title') })).toBeNull();
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
