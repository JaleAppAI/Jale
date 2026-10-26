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
 * coordinator, the lazily loaded guides chunk, the real post-job guide and
 * the spotlight engine, in front of the real "Post a job" button and the real
 * plan gate. Only the wizard's body is a stand-in: a dialog with the guide's
 * first field (`post.title`), noting where focus was when it opened.
 *
 *  - From a page that does not hold the jobs (Q3), the first press reads
 *    them and opens the wizard at once, with focus on the button as it opens;
 *    for an employer with no job, the guide then starts INSIDE the wizard. One
 *    dialog on screen throughout: the guide is drawn in the wizard's panel.
 *  - Ending the guide never closes the wizard, and Escape ends the guide only.
 *  - The plan gate comes first: when it refuses, the limit dialog shows and
 *    the guide never does, then or after.
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
                <Modal open={open} onClose={onClose} title="Job form" data-guide="post.wizard">
                    <div data-guide="post.title">
                        <label htmlFor="stand-in-title">Job title</label>
                        <input id="stand-in-title" />
                    </div>
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

const guideIntro = () =>
    screen.queryByRole('dialog', { name: message('tutorial.employer_post_job.guide.intro_title') });
const guideLayer = () => document.querySelector('[data-spotlight]');
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

describe('"Post a job" with the real post-job guide', () => {
    it('from a page that holds no jobs, the first press reads them, opens the wizard, then starts the guide inside it', async () => {
        const snapshot = serveSnapshot([], plan(3));
        renderPage();
        await settle();
        const dialogs = watchDialogs();

        const button = press();
        expect(wizardDialog()).toBeNull();

        await snapshot.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        // The wizard opened first, from the press, with focus on the button and nothing else up.
        expect(wizard.opens).toHaveLength(1);
        expect(wizard.opens[0].active).toBe(button);
        expect(wizard.opens[0].dialogs).toBe(0);

        const intro = await screen.findByRole('dialog', {
            name: message('tutorial.employer_post_job.guide.intro_title'),
        });
        expect(wizardDialog()?.contains(intro)).toBe(true);
        expect(within(intro).getByRole('button', { name: message('tutorial.common.guide.employer.start') })).toBe(
            document.activeElement,
        );

        act(() => {
            fireEvent.click(within(intro).getByRole('button', { name: message('tutorial.common.guide.self') }));
        });
        await settle();
        expect(guideLayer()).toBeNull();
        expect(wizardDialog()).not.toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);

        // Closing the wizard hands focus back to the button that opened it.
        act(() => {
            fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
        });
        await settle();
        expect(wizardDialog()).toBeNull();
        expect(document.activeElement).toBe(button);

        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });

    it('Escape during the guide ends the guide only; the next press opens the wizard with no guide', async () => {
        const first = serveSnapshot([], plan(3));
        renderPage();
        await settle();

        press();
        await first.answer();
        const intro = await screen.findByRole('dialog', {
            name: message('tutorial.employer_post_job.guide.intro_title'),
        });
        act(() => {
            fireEvent.click(within(intro).getByRole('button', { name: message('tutorial.common.guide.employer.start') }));
        });
        await settle();
        expect(document.querySelector('[data-spotlight] [data-step="title"]')).not.toBeNull();

        act(() => {
            fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
        });
        await settle();
        expect(guideLayer()).toBeNull();
        expect(wizardDialog()).not.toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);

        act(() => {
            fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
        });
        await settle();
        expect(wizardDialog()).toBeNull();

        const again = serveSnapshot([], plan(3));
        press();
        await again.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        await settle();
        expect(guideIntro()).toBeNull();
        expect(posts()).toHaveLength(1);
    });

    it('closing the wizard mid-guide ends the guide as skipped; reopening the wizard does not bring it back', async () => {
        const first = serveSnapshot([], plan(3));
        renderPage();
        await settle();

        press();
        await first.answer();
        const intro = await screen.findByRole('dialog', {
            name: message('tutorial.employer_post_job.guide.intro_title'),
        });
        act(() => {
            fireEvent.click(within(intro).getByRole('button', { name: message('tutorial.common.guide.employer.start') }));
        });
        await settle();
        expect(document.querySelector('[data-spotlight] [data-step="title"]')).not.toBeNull();

        // The wizard's own close, with the guide on its first step.
        const wizardBox = wizardDialog() as HTMLElement;
        act(() => {
            fireEvent.click(within(wizardBox).getByRole('button', { name: message('common.feedback.dismiss') }));
        });
        await settle();
        expect(wizardDialog()).toBeNull();
        expect(guideLayer()).toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);

        const again = serveSnapshot([], plan(3));
        press();
        await again.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        await settle();
        expect(guideIntro()).toBeNull();
        expect(guideLayer()).toBeNull();
        expect(posts()).toHaveLength(1);
    });

    it('never plays for an employer who already has a job', async () => {
        const snapshot = serveSnapshot([activeJob], plan(3));
        renderPage();
        await settle();

        press();
        await snapshot.answer();
        await waitFor(() => expect(wizardDialog()).not.toBeNull());
        await settle();
        expect(guideIntro()).toBeNull();
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
        await settle();
        expect(guideIntro()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('never plays with the limit dialog: the gate refuses first, and the guide stays shut after it closes', async () => {
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
        expect(guideIntro()).toBeNull();
        expect(wizardDialog()).toBeNull();

        act(() => {
            fireEvent.keyDown(document, { key: 'Escape' });
        });
        await settle();

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(guideIntro()).toBeNull();
        expect(wizard.opens).toEqual([]);
        expect(posts()).toEqual([]);
        // The limit dialog hands focus back on the next frame (see `handlePlanLimitClose`).
        await waitFor(() => expect(document.activeElement).toBe(button));
        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });
});
