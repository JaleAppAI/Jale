// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { EmployerBilling, Job } from '@/lib/api/employer';
import { message } from '@/components/worker/onboarding/__tests__/render-intl';
import {
    catalogues,
    record,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    tutorialCalls,
    watchDialogs,
} from '@/lib/tutorials/__tests__/harness';

/*
 * E2 with the real tutorial machinery: the progress store, the overlay
 * coordinator, the lazily loaded player and the real posting tour, in front
 * of the real "Post a job" button and the real plan gate. Only the wizard's
 * body is a stand-in: a plain dialog that notes where focus was when it
 * opened.
 *
 *  - From a page that does not hold the jobs (Q3), the first press reads
 *    them, plays the tour for an employer with none, and only then opens the
 *    wizard, with focus back on the button and one dialog at a time.
 *  - The plan gate comes first: when it refuses, the limit dialog shows and
 *    the tour never does, then or after.
 */

const wizard = vi.hoisted(() => ({
    /** Where focus was, and how many dialogs were up, each time the wizard opened. */
    opens: [] as Array<{ active: Element | null; dialogs: number }>,
}));

vi.mock('@/components/employer/PostJobModal', async () => {
    const { Modal } = await import('@/components/ui/modal');
    const react = await import('react');
    return {
        PostJobModal: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
            const wasOpen = react.useRef(false);
            // Noted while rendering the open: before the wizard's own Modal moves focus in.
            if (open && !wasOpen.current) {
                wizard.opens.push({
                    active: document.activeElement,
                    dialogs: document.querySelectorAll('[role="dialog"]').length,
                });
            }
            wasOpen.current = open;
            return (
                <Modal open={open} onClose={onClose} title="Job form">
                    <button type="button">Job title</button>
                </Modal>
            );
        },
    };
});

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));

vi.mock('@/i18n/navigation', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
            <a href={href} {...rest}>{children}</a>
        ),
        usePathname: harness.usePathnameMock,
        useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    };
});

vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getJobs: vi.fn(),
    getBilling: vi.fn(),
}));

import { getBilling, getJobs } from '@/lib/api/employer';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { PostJobButton } from '@/components/employer/PostJobButton';
import { PostJobProvider } from '../PostJobContext';

function renderPage() {
    return render(
        <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <PostJobProvider>
                        <main>
                            <h1>Applicants</h1>
                            <PostJobButton />
                        </main>
                    </PostJobProvider>
                </TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
}

async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

const plan = (activeJobLimit: number): EmployerBilling => ({
    planCode: 'employer_free',
    activeJobLimit,
    templateLimit: 1,
    activeJobUsage: 0,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
});

const activeJob = {
    id: 'job-1',
    title: 'Concrete Finisher',
    location: 'El Paso, TX',
    status: 'active',
    applicant_count: 0,
    hired_count: 0,
    open_count: 1,
    created_at: '2026-08-01T00:00:00Z',
} as unknown as Job;

const tourTitle = () => message('tutorial.employer_post_job.title');
const tourDialog = () => screen.queryByRole('dialog', { name: tourTitle() });
const wizardDialog = () => screen.queryByRole('dialog', { name: 'Job form' });
const postButton = () => screen.getByRole('button', { name: message('employer_dashboard.jobs.post_job') });
const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

/**
 * The plan and the jobs, answered when the test says. Reading them turns the
 * button busy, and a browser drops focus from a focused button that turns
 * disabled; the read blurs it the same way.
 */
function serveSnapshot(jobs: Job[], billing: EmployerBilling | null) {
    let release: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
        release = resolve;
    });
    vi.mocked(getJobs).mockImplementation(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        await answered;
        return jobs;
    });
    vi.mocked(getBilling).mockImplementation(async () => {
        await answered;
        if (!billing) throw new Error('billing unavailable');
        return billing;
    });
    return { answer: () => act(async () => release()) };
}

/** Focus the button and press it, the way a keyboard or a tap does. */
function press() {
    const button = postButton();
    button.focus();
    act(() => {
        fireEvent.click(button);
    });
    return button;
}

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    vi.mocked(getJobs).mockReset();
    vi.mocked(getBilling).mockReset();
    wizard.opens.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/employer/applicants';
    signIn('employer');
    serveTutorials([]);
});

describe('"Post a job" with the real posting tour', () => {
    it('from a page that holds no jobs, the first press reads them, plays the tour, then opens the wizard with focus on the button', async () => {
        const snapshot = serveSnapshot([], plan(3));
        renderPage();
        await settle();
        const dialogs = watchDialogs();

        const button = press();
        expect(tourDialog()).toBeNull();
        expect(wizardDialog()).toBeNull();

        await snapshot.answer();
        const tour = await screen.findByRole('dialog', { name: tourTitle() });
        expect(wizardDialog()).toBeNull();
        expect(wizard.opens).toEqual([]);
        expect(within(tour).getByRole('heading', { level: 2 }).textContent).toBe(
            message('tutorial.employer_post_job.slides.steps.title'),
        );

        for (let turn = 0; turn < 3; turn += 1) {
            act(() => {
                fireEvent.click(within(tour).getByRole('button', { name: message('tutorial.common.next') }));
            });
        }
        act(() => {
            fireEvent.click(within(tour).getByRole('button', { name: message('tutorial.common.got_it') }));
        });

        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        expect(tourDialog()).toBeNull();
        expect(wizard.opens).toHaveLength(1);
        expect(wizard.opens[0].active).toBe(button);
        expect(wizard.opens[0].dialogs).toBe(0);
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'completed' }]);

        // Closing the wizard hands focus back to the button that opened it.
        act(() => {
            fireEvent.keyDown(document, { key: 'Escape' });
        });
        await settle();
        expect(wizardDialog()).toBeNull();
        expect(document.activeElement).toBe(button);

        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });

    it('skipping the tour still opens the wizard, and the next press goes straight to it', async () => {
        const first = serveSnapshot([], plan(3));
        renderPage();
        await settle();

        const button = press();
        await first.answer();
        const tour = await screen.findByRole('dialog', { name: tourTitle() });
        act(() => {
            fireEvent.click(within(tour).getByRole('button', { name: message('tutorial.common.skip') }));
        });
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        expect(wizard.opens[0].active).toBe(button);
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);

        act(() => {
            fireEvent.keyDown(document, { key: 'Escape' });
        });
        await settle();

        const again = serveSnapshot([], plan(3));
        press();
        await again.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        expect(tourDialog()).toBeNull();
        expect(posts()).toHaveLength(1);
    });

    it('never plays for an employer who already has a job', async () => {
        const snapshot = serveSnapshot([activeJob], plan(3));
        renderPage();
        await settle();

        press();
        await snapshot.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('never plays once it was finished or skipped before', async () => {
        serveTutorials([record('employer_post_job', 'completed')]);
        const snapshot = serveSnapshot([], plan(3));
        renderPage();
        await settle();

        press();
        await snapshot.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('never plays with the limit dialog: the gate refuses first, and the tour stays shut after it closes', async () => {
        // A plan with no posting slot at all: the gate refuses an employer with no job.
        const snapshot = serveSnapshot([], plan(0));
        renderPage();
        await settle();
        const dialogs = watchDialogs();

        const button = press();
        await snapshot.answer();
        await settle();

        const limit = screen.getByRole('dialog');
        expect(limit).toBeTruthy();
        expect(tourDialog()).toBeNull();
        expect(wizardDialog()).toBeNull();

        act(() => {
            fireEvent.keyDown(document, { key: 'Escape' });
        });
        await settle();

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(tourDialog()).toBeNull();
        expect(wizard.opens).toEqual([]);
        expect(posts()).toEqual([]);
        // The limit dialog hands focus back on the next frame (see `handlePlanLimitClose`).
        await waitFor(() => expect(document.activeElement).toBe(button));
        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });
});
