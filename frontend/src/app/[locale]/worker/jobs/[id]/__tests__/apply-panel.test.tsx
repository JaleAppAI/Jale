// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { JobDetail } from '@/lib/api/worker';
import { renderIntl, message } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The bottom of the worker job page: the Apply control before applying, and
 * the status after it. The facts card above it has its own suite
 * (`facts-card.test.tsx`), whose harness this file shares.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'job-1', locale: 'en' }),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    // "Back to jobs" may return through history; this suite is about the facts
    // card, so the router is stubbed and never asserted on.
    useRouter: () => ({ back: vi.fn() }),
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
    getVaultDocuments: vi.fn(async () => ({ documents: [] })),
    recordJobView: vi.fn(),
    getApplications: vi.fn(async () => ({
        applications: [],
        next_cursor: null,
        attention: { details_requested: [], unacknowledged_hires: [] },
    })),
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
        company_name: 'NB Construction',
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
        // The canonical total the server derives for 3 years (job-fields.ts
        // sets months = years * 12), not null: this is what the API returns.
        required_experience_months: 36,
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

const t = (key: string) => message(`worker_job_detail.${key}`);

describe('worker job page — after applying', () => {
    it('says what the status means under the status chip', () => {
        seed = fullJob({ already_applied: true, application_status: 'talking' });
        renderIntl(<WorkerJobDetailPage />);

        expect(screen.getByText(t('already_applied'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_applications.status_hint.talking'))).toBeInTheDocument();
    });

    it('reads a missing status as applied and waiting', () => {
        seed = fullJob({ already_applied: true, application_status: null });
        renderIntl(<WorkerJobDetailPage />, 'es');

        expect(screen.getByText(message('worker_applications.status_hint.pending', 'es'))).toBeInTheDocument();
    });
});

/*
 * On a phone the Apply button used to sit at the bottom of a long page. Under
 * `sm` its panel is pinned above the bottom tab bar, so Apply stays in view
 * while the worker reads; from `sm` up it is back in the flow. It is ONE Apply
 * element either way -- moved by classes, never duplicated -- and the content
 * above gets room at the bottom so the bar never covers the last block.
 */
describe('worker job page — Apply stays in view on phones', () => {
    const PINNED = 'max-sm:fixed';
    const ABOVE_TAB_BAR = 'max-sm:bottom-[calc(5rem+env(safe-area-inset-bottom))]';

    function applyPanel(): HTMLElement {
        return screen.getByRole('button', { name: t('apply') }).closest('section')!;
    }

    it('renders exactly one Apply button', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.getAllByRole('button', { name: t('apply') })).toHaveLength(1);
    });

    it('pins the Apply panel above the tab bar under sm, and leaves it in flow from sm up', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);

        const panel = applyPanel();
        expect(panel.className).toContain(PINNED);
        expect(panel.className).toContain(ABOVE_TAB_BAR);
        // Every pinning class is phone-only: nothing pins it from sm up.
        expect(panel.className.split(/\s+/).filter((c) => /^(fixed|sticky)$/.test(c))).toEqual([]);
        expect(screen.getByRole('button', { name: t('apply') }).className).toContain('max-sm:w-full');
    });

    it('gives the content room at the bottom so the bar never covers it', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);

        const content = applyPanel().parentElement!;
        expect(content.className).toContain('max-sm:pb-28');
    });

    it('does not pin anything once the worker has applied', () => {
        seed = fullJob({ already_applied: true, application_status: 'pending' });
        const { container } = renderIntl(<WorkerJobDetailPage />);
        expect(container.querySelector('[class*="max-sm:fixed"]')).toBeNull();
        expect(container.querySelector('[class*="max-sm:pb-28"]')).toBeNull();
    });

    it('does not pin a job that can no longer take an application', () => {
        seed = fullJob({ status: 'closed' });
        const { container } = renderIntl(<WorkerJobDetailPage />);
        expect(container.querySelector('[class*="max-sm:fixed"]')).toBeNull();
    });
});

describe('worker job page — documents not yet saved read as "Later"', () => {
    it('marks a document the worker has not saved as Later, in both languages', () => {
        seed = fullJob({ required_docs: ['resume'], missing_docs: ['resume'] });
        const { unmount } = renderIntl(<WorkerJobDetailPage />);
        const panel = screen.getByRole('heading', { name: t('what_you_need.title') }).closest('section')!;
        expect(within(panel).getAllByText('Later').length).toBeGreaterThan(0);
        expect(within(panel).queryByText('Not yet')).not.toBeInTheDocument();
        unmount();

        renderIntl(<WorkerJobDetailPage />, 'es');
        const panelEs = screen.getByRole('heading', { name: message('worker_job_detail.what_you_need.title', 'es') })
            .closest('section')!;
        expect(within(panelEs).getAllByText('Después').length).toBeGreaterThan(0);
    });
});

describe('worker job page — what applying costs', () => {
    it('says under Apply that it takes about 2 minutes and documents come later', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />);
        const hint = screen.getByText(t('apply_hint'));
        // In the same panel as the button, so it travels with it on a phone.
        expect(hint.closest('section')).toBe(screen.getByRole('button', { name: t('apply') }).closest('section'));
    });

    it('drops the hint once the worker has applied', () => {
        seed = fullJob({ already_applied: true, application_status: 'pending' });
        renderIntl(<WorkerJobDetailPage />);
        expect(screen.queryByText(t('apply_hint'))).not.toBeInTheDocument();
    });

    it('says it in Spanish', () => {
        seed = fullJob();
        renderIntl(<WorkerJobDetailPage />, 'es');
        expect(screen.getByText(message('worker_job_detail.apply_hint', 'es'))).toBeInTheDocument();
    });
});
