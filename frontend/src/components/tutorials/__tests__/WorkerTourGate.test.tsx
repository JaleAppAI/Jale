import { useState } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
    catalogues,
    record,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    tutorialCalls,
} from '@/lib/tutorials/__tests__/harness';

/*
 * The worker app tour's gate, with the real progress store, overlay
 * coordinator and tour overlay, over a stand-in worker shell (its tabs and
 * Help button). The rules:
 *  - it plays only when onboarding left the marker for this account;
 *  - once, at the first worker shell page where the tour may auto-open and
 *    nothing else is up, and the marker goes once the tour has shown;
 *  - it waits while an overlay is open (the hire celebration, the profile
 *    gate, the in-page apply flow) and while `?apply=1` is still in the
 *    address bar, and checks again when an overlay closes or the page
 *    changes;
 *  - never on the onboarding page itself.
 */

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));

vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
}));

vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (...args: unknown[]) => harness.apiFetch(...args),
    };
});

import { OverlayPresenceProvider, useOverlayPresence } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { isWorkerTourDue, markWorkerTourDue } from '@/lib/tutorials/tour-marker';
import { WorkerTourGate } from '../WorkerTourGate';

const ACCOUNT = 'worker-account-one';

/** Something else on screen that counts as an overlay, opened and closed from the test. */
let setOverlayOpen: (open: boolean) => void = () => {};
function OtherOverlay({ initiallyOpen }: { initiallyOpen: boolean }) {
    const [open, setOpen] = useState(initiallyOpen);
    setOverlayOpen = setOpen;
    useOverlayPresence(open);
    return open ? <div data-testid="other-overlay" /> : null;
}

function WorkerShell() {
    return (
        <>
            <header>
                <button type="button" data-tour="help">
                    Help
                </button>
            </header>
            <nav aria-label="Mobile navigation">
                <a href="#jobs" data-nav-key="find_jobs">Jobs</a>
                <a href="#applications" data-nav-key="applications">My Applications</a>
                <a href="#profile" data-nav-key="profile">Profile</a>
            </nav>
        </>
    );
}

function App({ overlay = false }: { overlay?: boolean }) {
    return (
        <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <WorkerShell />
                    <OtherOverlay initiallyOpen={overlay} />
                    <WorkerTourGate />
                </TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>
    );
}

async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
    }
}

const tourTitle = () => catalogues.en.tutorial.tour.worker.welcome_title;
const tourDialog = () => screen.queryByRole('dialog', { name: tourTitle() });
const posts = () => tutorialCalls().filter(([method]) => method === 'POST').map(([, , body]) => body);

beforeAll(async () => {
    // The tour's lazy chunk, fetched once up front: a cold first import
    // would otherwise spend the first test's wait on module transforms.
    await import('@/components/tutorials/AppTourHost');
});

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    sessionStorage.clear();
    document.body.style.overflow = '';
    window.history.replaceState(null, '', '/en/worker/home');
    route.path = '/worker/home';
    signIn('worker', ACCOUNT);
    serveTutorials([]);
});

describe('worker tour gate', () => {
    it('plays the tour once after onboarding, records it, and clears the marker', async () => {
        markWorkerTourDue(ACCOUNT);
        const view = render(<App />);

        expect(await screen.findByRole('dialog', { name: tourTitle() })).toBeTruthy();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: catalogues.en.tutorial.tour.worker.not_now }));
        });
        await settle();

        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([{ tutorial_id: 'worker_app_tour', outcome: 'skipped' }]);
        expect(isWorkerTourDue(ACCOUNT)).toBe(false);

        // The next page view does not bring it back.
        route.path = '/worker/applications';
        view.rerender(<App />);
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('never plays without the marker', async () => {
        render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('never plays the marker of another account', async () => {
        markWorkerTourDue('worker-account-two');
        render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('waits while another overlay is open, and plays once it closes', async () => {
        markWorkerTourDue(ACCOUNT);
        render(<App overlay />);
        await settle();
        expect(screen.getByTestId('other-overlay')).toBeTruthy();
        expect(tourDialog()).toBeNull();
        expect(isWorkerTourDue(ACCOUNT)).toBe(true);

        act(() => setOverlayOpen(false));
        expect(await screen.findByRole('dialog', { name: tourTitle() })).toBeTruthy();
    });

    it('waits on the onboarding page, and plays on the first worker page after it', async () => {
        markWorkerTourDue(ACCOUNT);
        route.path = '/worker/onboarding';
        window.history.replaceState(null, '', '/en/worker/onboarding');
        const view = render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();

        route.path = '/worker/home';
        window.history.replaceState(null, '', '/en/worker/home');
        view.rerender(<App />);
        expect(await screen.findByRole('dialog', { name: tourTitle() })).toBeTruthy();
    });

    it('waits out an arrival into the apply flow, and plays when the flow closes', async () => {
        markWorkerTourDue(ACCOUNT);
        route.path = '/worker/jobs/job-1';
        window.history.replaceState(null, '', '/en/worker/jobs/job-1?apply=1');
        render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();

        // The job page takes the param out and opens the flow, which counts
        // as an overlay until it closes.
        act(() => {
            window.history.replaceState(null, '', '/en/worker/jobs/job-1');
            setOverlayOpen(true);
        });
        await settle();
        expect(tourDialog()).toBeNull();

        act(() => setOverlayOpen(false));
        expect(await screen.findByRole('dialog', { name: tourTitle() })).toBeTruthy();
    });

    it('does not play for a worker who already has a tour outcome', async () => {
        markWorkerTourDue(ACCOUNT);
        serveTutorials([record('worker_app_tour', 'completed')]);
        render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('does not play for an employer session', async () => {
        markWorkerTourDue(ACCOUNT);
        signIn('employer', ACCOUNT);
        route.path = '/employer/dashboard';
        render(<App />);
        await settle();
        expect(tourDialog()).toBeNull();
    });
});
