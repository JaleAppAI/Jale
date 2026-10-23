// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { Applicant, EmployerJobDetail, InboxItem } from '@/lib/api/employer';
import { message } from '@/components/worker/onboarding/__tests__/render-intl';
import { catalogues, record, resetHarness, route, serveTutorials, signIn, tutorialCalls } from '@/lib/tutorials/__tests__/harness';

/*
 * E3 with the real tutorial machinery: the progress store, the overlay
 * coordinator, the lazily loaded player and the real applicants tour, on the
 * real job page. The page's data and the inbox are driven from the test.
 *
 * It auto-opens once the page and the inbox have both answered, on a job with
 * applicants, for an employer who has moved nobody past applied and has no
 * outcome on record (K1.5). Otherwise it stays shut.
 */

vi.mock('next/navigation', () => ({
    useParams: () => ({ id: '11111111-2222-4333-8444-555555555555', locale: 'en' }),
}));

// Stable identities: the page's effects list these in their deps.
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('@/i18n/navigation', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
            <a href={href} {...rest}>{children}</a>
        ),
        useRouter: () => router,
        usePathname: harness.usePathnameMock,
    };
});

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));

vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});

const requireAuth = {
    handleLegalWall: (err: unknown) => {
        throw err;
    },
};
vi.mock('@/hooks/useRequireAuth', () => ({ useRequireAuth: () => requireAuth }));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/AppShellSkeleton', () => ({
    AppShellSkeleton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/employer/EditJobModal', () => ({ EditJobModal: () => null }));
vi.mock('@/components/employer/PublicListingCard', () => ({ PublicListingCard: () => null }));
vi.mock('@/components/employer/ApplicantFilterPanel', () => ({
    ApplicantFilterPanel: () => null,
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

/** The session-wide inbox, driven from the test. */
const inbox = vi.hoisted(() => {
    let state: { loading: boolean; errorKind: string | null; items: unknown[] } = { loading: true, errorKind: null, items: [] };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const inboxActions = { retry: vi.fn(), refresh: vi.fn(), markRead: vi.fn() };
vi.mock('@/contexts/UnreadMessagesContext', async () => {
    const react = await import('react');
    return {
        useUnreadMessages: () => {
            const state = react.useSyncExternalStore(inbox.subscribe, inbox.get, inbox.get);
            return { ...state, unreadCount: 0, unreadByConversation: {}, ...inboxActions };
        },
        useUnreadCount: () => 0,
    };
});

/** The page's own load, driven from the test. */
const page = vi.hoisted(() => {
    let state: { phase: 'loading' | 'ready'; data: unknown } = { phase: 'loading', data: null };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const noop = vi.fn();
vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const state = react.useSyncExternalStore(page.subscribe, page.get, page.get);
            return {
                phase: state.phase,
                data: state.data,
                errorKind: null,
                refreshing: false,
                refreshError: false,
                retry: noop,
                refresh: noop,
                setData: noop,
            };
        },
    };
});

// Below every `vi.mock` on purpose (they hoist).
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import EmployerJobDetailPage from '../page';

const job = {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Drywall Finisher',
    location: 'Austin, TX',
    pay: null,
    job_type: 'full-time',
    status: 'active',
    applicant_count: 1,
    hired_count: 0,
    open_count: 1,
    hire_details_needed_count: 0,
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
} as unknown as EmployerJobDetail;

function applicant(status: Applicant['status'], n = 1): Applicant {
    return {
        application_id: `app-${n}`,
        worker_id: `00000000-0000-4000-8000-00000000000${n}`,
        full_name: 'Test Worker',
        phone: null,
        status,
        applied_at: '2026-06-02T15:00:00.000Z',
        skills: [],
        availability: null,
        years_experience: null,
        location: null,
        hire_details: null,
        hire_details_needed: false,
    };
}

const inboxRow = (application_status: InboxItem['application_status']) =>
    ({ application_id: 'app-other', application_status, conversation_id: null }) as unknown as InboxItem;

const ready = (applicants: Applicant[]) =>
    page.set({ phase: 'ready', data: { job, applicants, appliedFilters: {} } });

function renderPage() {
    return render(
        <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <EmployerJobDetailPage />
                </TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
}

/**
 * Several separate acts, each a short real wait: long enough for the lazily
 * loaded player to arrive, so "stays shut" means it was never asked for.
 */
async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
    }
}

const tourTitle = () => message('tutorial.employer_applicants.title');
const tourDialog = () => screen.queryByRole('dialog', { name: tourTitle() });
const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    vi.clearAllMocks();
    resetHarness();
    sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = `/employer/jobs/${job.id}`;
    signIn('employer');
    serveTutorials([]);
    page.set({ phase: 'loading', data: null });
    inbox.set({ loading: true, errorKind: null, items: [] });
});

describe('job page: the real applicants tour', () => {
    it('opens once the page and the inbox have answered, on a job with applicants, and records a skip', async () => {
        renderPage();
        act(() => ready([applicant('pending')]));
        await settle();
        // The inbox has not answered: whether anyone is past applied is unknown.
        expect(tourDialog()).toBeNull();

        act(() => inbox.set({ loading: false, errorKind: null, items: [inboxRow('contacted')] }));
        const tour = await screen.findByRole('dialog', { name: tourTitle() });
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        expect(within(tour).getByRole('heading', { level: 2 }).textContent).toBe(
            message('tutorial.employer_applicants.slides.first_look.title'),
        );

        act(() => {
            fireEvent.click(within(tour).getByRole('button', { name: message('tutorial.common.skip') }));
        });
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_applicants', outcome: 'skipped' }]);
    });

    it('stays shut on a job with no applicants', async () => {
        renderPage();
        act(() => {
            ready([]);
            inbox.set({ loading: false, errorKind: null, items: [] });
        });
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('stays shut when someone on this page is already past applied', async () => {
        renderPage();
        act(() => {
            ready([applicant('pending', 1), applicant('hired', 2)]);
            inbox.set({ loading: false, errorKind: null, items: [] });
        });
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('stays shut when the inbox shows details requested on another job', async () => {
        renderPage();
        act(() => {
            ready([applicant('pending')]);
            inbox.set({ loading: false, errorKind: null, items: [inboxRow('details_requested')] });
        });
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('stays shut once it was finished or skipped before', async () => {
        serveTutorials([record('employer_applicants', 'completed')]);
        renderPage();
        act(() => {
            ready([applicant('pending')]);
            inbox.set({ loading: false, errorKind: null, items: [] });
        });
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });
});
