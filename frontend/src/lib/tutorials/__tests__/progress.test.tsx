import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TutorialProgressProvider, useTutorialProgress, type TutorialProgressValue } from '../progress';
import {
    apiFetch,
    auth,
    clearSession,
    fakeIdToken,
    jsonResponse,
    record,
    renderWithIntl,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    signOut,
    tutorialCalls,
    tutorialTokens,
} from './harness';

vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
vi.mock('@/i18n/navigation', async () => ({ usePathname: (await import('./harness')).usePathnameMock }));
vi.mock('@/lib/api', async () => {
    const harness = await import('./harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});

/*
 * The progress store (K1): one read of this account's tutorial records per
 * session, on a signed-in shell route only, and a record of how an
 * auto-opened tutorial was dismissed. Nothing is written on render.
 */

let latest: TutorialProgressValue | null = null;

function keep(value: TutorialProgressValue | null) {
    latest = value;
}

function Probe({ onValue = keep }: { onValue?: (value: TutorialProgressValue | null) => void }) {
    const value = useTutorialProgress();
    onValue(value);
    return <p data-testid="status">{value?.status ?? 'none'}</p>;
}

function renderProvider() {
    return renderWithIntl(
        <TutorialProgressProvider>
            <Probe />
        </TutorialProgressProvider>,
    );
}

function current(): TutorialProgressValue {
    if (!latest) throw new Error('no provider value');
    return latest;
}

/** Lets pending promise callbacks and the effects they trigger run. */
async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    resetHarness();
    latest = null;
    window.sessionStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('reading progress', () => {
    it('renders its children', async () => {
        renderProvider();
        await settle();

        expect(document.body).toHaveTextContent('idle');
    });

    it('reads this account’s records once, with its id token, on a signed-in employer route', async () => {
        signIn('employer');
        serveTutorials([record('employer_welcome')]);

        renderProvider();

        await waitFor(() => expect(current().status).toBe('ready'));
        expect(tutorialCalls()).toEqual([['GET', '/employer/tutorials', undefined]]);
        expect(tutorialTokens()).toEqual([auth.state.idToken]);
        expect(current().hasRecord('employer_welcome')).toBe(true);
        expect(current().hasRecord('employer_post_job')).toBe(false);
        expect(current().role).toBe('employer');
    });

    it('reads the worker path on a worker route, onboarding included', async () => {
        route.path = '/worker/onboarding';
        signIn('worker');
        serveTutorials([]);

        renderProvider();

        await waitFor(() => expect(current().status).toBe('ready'));
        expect(tutorialCalls()).toEqual([['GET', '/worker/tutorials', undefined]]);
    });

    it('is loading until the read answers', async () => {
        signIn('employer');
        const answer = deferred<Response>();
        apiFetch.mockReturnValue(answer.promise);

        renderProvider();
        await settle();
        expect(current().status).toBe('loading');

        answer.resolve(jsonResponse(200, { tutorials: [] }));
        await waitFor(() => expect(current().status).toBe('ready'));
    });

    it('is loading, and asks nothing yet, while the session is being restored on a shell route', async () => {
        auth.state = { ...auth.state, isLoading: true };

        renderProvider();
        await settle();

        expect(current().status).toBe('loading');
        expect(tutorialCalls()).toEqual([]);
    });

    it.each(['/', '/j/AB12CD', '/auth/employer', '/auth/worker', '/employer/dashboard', '/worker/home', '/legal/accept'])(
        'makes no tutorial request for a signed-out visitor on %s',
        async (path) => {
            route.path = path;
            signOut();
            serveTutorials([]);

            renderProvider();
            await settle();

            expect(tutorialCalls()).toEqual([]);
            expect(current().status).toBe('idle');
        },
    );

    it.each(['/', '/j/AB12CD', '/auth/employer', '/legal/accept', '/upload/sample-token', '/digest-unsubscribe'])(
        'makes no tutorial request on the public page %s, even when signed in',
        async (path) => {
            route.path = path;
            signIn('employer');
            serveTutorials([]);

            renderProvider();
            await settle();

            expect(tutorialCalls()).toEqual([]);
            expect(current().status).toBe('idle');
            expect(current().shellRole).toBeNull();
        },
    );

    it('makes no request on a shell route of the other role', async () => {
        route.path = '/employer/dashboard';
        signIn('worker');
        serveTutorials([]);

        renderProvider();
        await settle();

        expect(tutorialCalls()).toEqual([]);
        expect(current().status).toBe('idle');
        expect(current().shellRole).toBe('employer');
        expect(current().role).toBeNull();
    });

    it('does not read again when the id token is renewed for the same account', async () => {
        signIn('employer', 'account-one', 1);
        serveTutorials([record('employer_welcome')]);
        const view = renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        signIn('employer', 'account-one', 2);
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await settle();

        expect(tutorialCalls()).toHaveLength(1);
        expect(current().hasRecord('employer_welcome')).toBe(true);
    });

    it('reads again, and forgets the first account’s records, when another account signs in', async () => {
        signIn('employer', 'account-one');
        serveTutorials([record('employer_welcome')]);
        const view = renderProvider();
        await waitFor(() => expect(current().hasRecord('employer_welcome')).toBe(true));

        signIn('employer', 'account-two');
        serveTutorials([]);
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );

        expect(current().hasRecord('employer_welcome')).toBe(false);
        await waitFor(() => expect(current().status).toBe('ready'));
        expect(tutorialCalls()).toHaveLength(2);
        expect(tutorialTokens()[1]).toBe(fakeIdToken('account-two'));
        expect(current().hasRecord('employer_welcome')).toBe(false);
    });

    it('drops what it read when the session ends, and reads again after the next sign-in', async () => {
        signIn('employer');
        serveTutorials([record('employer_welcome')]);
        const view = renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        clearSession('employer');
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await settle();
        expect(current().status).toBe('idle');
        expect(current().hasRecord('employer_welcome')).toBe(false);

        signIn('employer');
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await waitFor(() => expect(current().status).toBe('ready'));
        expect(tutorialCalls()).toHaveLength(2);
    });

    it('cancels the read in flight when it unmounts', async () => {
        signIn('employer');
        apiFetch.mockReturnValue(new Promise(() => {}));
        const view = renderProvider();
        await settle();

        view.unmount();

        const init = apiFetch.mock.calls[0][1] as RequestInit;
        expect(init.signal?.aborted).toBe(true);
    });

    it.each([
        ['a server error', { status: 500, body: { error: 'internal' } }],
        ['a missing account row', { status: 404, body: { error: 'not_found' } }],
        ['a 200 with no records array', { status: 200, body: { ok: true } }],
    ])('reports a failed read on %s', async (_label, answer) => {
        signIn('employer');
        serveTutorials(answer);

        renderProvider();

        await waitFor(() => expect(current().status).toBe('failed'));
        expect(tutorialCalls()).toHaveLength(1);
    });

    it('reports the shell role of the route before anyone signs in', async () => {
        route.path = '/worker/home';

        renderProvider();
        await settle();

        expect(current().shellRole).toBe('worker');
        expect(current().role).toBeNull();
    });
});

describe('recording an outcome', () => {
    it('never posts on render', async () => {
        signIn('employer');
        serveTutorials([]);

        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));
        await settle();

        expect(tutorialCalls().filter(([method]) => method === 'POST')).toEqual([]);
    });

    it('posts the outcome once and counts it as recorded at once', async () => {
        signIn('employer');
        serveTutorials([]);
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        act(() => current().recordOutcome('employer_welcome', 'skipped'));

        expect(current().hasRecord('employer_welcome')).toBe(true);
        await settle();
        expect(tutorialCalls().filter(([method]) => method === 'POST')).toEqual([
            ['POST', '/employer/tutorials', { tutorial_id: 'employer_welcome', outcome: 'skipped' }],
        ]);
        expect(current().isFlagged('employer_welcome')).toBe(false);
    });

    it('flags a tutorial whose outcome did not save, for the rest of the browser session', async () => {
        signIn('employer');
        serveTutorials([], { status: 500, body: { error: 'internal' } });
        const view = renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        act(() => current().recordOutcome('employer_post_job', 'completed'));
        await settle();

        expect(current().isFlagged('employer_post_job')).toBe(true);
        expect(current().isFlagged('employer_welcome')).toBe(false);
        expect(tutorialCalls().filter(([method]) => method === 'POST')).toHaveLength(1);

        // A new page load in the same browser session still knows.
        view.unmount();
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));
        expect(current().isFlagged('employer_post_job')).toBe(true);
    });

    it('keeps the flag in memory when session storage is unavailable', async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        signIn('employer');
        serveTutorials([], { status: 503 });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        act(() => current().recordOutcome('employer_welcome', 'skipped'));
        await settle();

        expect(current().isFlagged('employer_welcome')).toBe(true);
    });

    it('keeps the flag in memory only, and stores nothing, when the account cannot be read from the token', async () => {
        signIn('employer', '');
        serveTutorials([], { status: 500 });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        act(() => current().recordOutcome('employer_welcome', 'skipped'));
        await settle();

        expect(current().isFlagged('employer_welcome')).toBe(true);
        expect(window.sessionStorage.length).toBe(0);
    });

    it('forgets the flags when the session ends', async () => {
        signIn('employer');
        serveTutorials([], { status: 500 });
        const view = renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));
        act(() => current().recordOutcome('employer_welcome', 'skipped'));
        await settle();
        expect(current().isFlagged('employer_welcome')).toBe(true);

        clearSession('employer');
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await settle();
        signIn('employer');
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await waitFor(() => expect(current().status).toBe('ready'));

        expect(current().isFlagged('employer_welcome')).toBe(false);
    });
});
