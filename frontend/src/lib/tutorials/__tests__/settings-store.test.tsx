import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TUTORIAL_SETTINGS } from '@/lib/api/tutorials';
import { TutorialProgressProvider, useTutorialProgress, type TutorialProgressValue } from '../progress';
import { apiFetch, clearSession, jsonResponse, renderWithIntl, resetHarness, route, signIn } from './harness';
import { serveTutorialsWithSettings, settingsPatches } from './settings-harness';

vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
vi.mock('@/i18n/navigation', async () => ({ usePathname: (await import('./harness')).usePathnameMock }));
vi.mock('@/lib/api', async () => {
    const harness = await import('./harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});

/*
 * The guide settings in the progress store (K1-v2): read with the progress,
 * kept with this account's records, and saved optimistically. A failed save
 * puts back what the server last confirmed, and says so.
 */

let latest: TutorialProgressValue | null = null;

function keep(value: TutorialProgressValue | null) {
    latest = value;
}

function Probe() {
    keep(useTutorialProgress());
    return null;
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

describe('reading the settings', () => {
    it('keeps the settings the read answered with', async () => {
        signIn('employer');
        serveTutorialsWithSettings({ settings: { always_show: true, muted: ['employer_messages'] } });

        renderProvider();

        await waitFor(() => expect(current().status).toBe('ready'));
        expect(current().settings).toEqual({ always_show: true, muted: ['employer_messages'] });
    });

    it('has the defaults while the read is in flight', async () => {
        signIn('employer');
        const answer = deferred<Response>();
        apiFetch.mockReturnValue(answer.promise);

        renderProvider();
        await settle();

        expect(current().status).toBe('loading');
        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);

        answer.resolve(jsonResponse(200, { tutorials: [], settings: { always_show: true, muted: [] } }));
        await waitFor(() => expect(current().settings.always_show).toBe(true));
    });

    it('has the defaults when the read failed', async () => {
        signIn('worker');
        route.path = '/worker/home';
        serveTutorialsWithSettings({ read: { status: 500 } });

        renderProvider();

        await waitFor(() => expect(current().status).toBe('failed'));
        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
    });

    it('has the defaults on a page with no read', async () => {
        route.path = '/j/AB12CD';
        renderProvider();
        await settle();
        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
    });

    it('reads an answer with no settings as the defaults, and still reads the records', async () => {
        signIn('employer');
        serveTutorialsWithSettings({ settings: null, records: [{ tutorial_id: 'employer_welcome', outcome: 'completed', recorded_at: '2026-10-01T15:00:00.000Z' }] });

        renderProvider();

        await waitFor(() => expect(current().status).toBe('ready'));
        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
        expect(current().hasRecord('employer_welcome')).toBe(true);
    });

    it('drops the settings with the records when the session ends', async () => {
        signIn('employer');
        serveTutorialsWithSettings({ settings: { always_show: true, muted: [] } });
        const view = renderProvider();
        await waitFor(() => expect(current().settings.always_show).toBe(true));

        clearSession('employer');
        view.rerender(
            <TutorialProgressProvider>
                <Probe />
            </TutorialProgressProvider>,
        );
        await settle();

        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
    });
});

describe('saving the settings', () => {
    it('shows the change at once, sends the patch, and resolves true once saved', async () => {
        signIn('employer');
        const server = serveTutorialsWithSettings();
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        let saved: Promise<boolean> | undefined;
        act(() => {
            saved = current().updateSettings({ always_show: true });
        });

        expect(current().settings.always_show).toBe(true);
        await expect(saved).resolves.toBe(true);
        await settle();
        expect(settingsPatches()).toEqual([{ always_show: true }]);
        expect(server.stored().always_show).toBe(true);
        expect(current().settings).toEqual({ always_show: true, muted: [] });
    });

    it('takes the stored settings the server answers with', async () => {
        signIn('worker');
        route.path = '/worker/home';
        serveTutorialsWithSettings({
            settings: { always_show: false, muted: [] },
            patch: async () => jsonResponse(200, { settings: { always_show: false, muted: ['worker_apply', 'worker_details'] } }),
        });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        await act(async () => {
            await current().updateSettings({ muted: ['worker_apply'] });
        });

        expect(current().settings).toEqual({ always_show: false, muted: ['worker_apply', 'worker_details'] });
    });

    it('puts the settings back, and resolves false, when the save fails', async () => {
        signIn('employer');
        serveTutorialsWithSettings({
            settings: { always_show: false, muted: ['employer_messages'] },
            patch: { status: 500, body: { error: 'internal' } },
        });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        let saved: Promise<boolean> | undefined;
        act(() => {
            saved = current().updateSettings({ always_show: true, muted: [] });
        });
        expect(current().settings).toEqual({ always_show: true, muted: [] });

        await expect(saved).resolves.toBe(false);
        await settle();
        expect(current().settings).toEqual({ always_show: false, muted: ['employer_messages'] });
    });

    it('puts back what the server last confirmed when two overlapping saves both fail', async () => {
        signIn('employer');
        const answers = [deferred<Response>(), deferred<Response>()];
        let call = 0;
        serveTutorialsWithSettings({ patch: () => answers[call++].promise });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        let first: Promise<boolean> | undefined;
        let second: Promise<boolean> | undefined;
        act(() => {
            first = current().updateSettings({ always_show: true });
        });
        act(() => {
            second = current().updateSettings({ muted: ['employer_welcome'] });
        });
        expect(current().settings).toEqual({ always_show: true, muted: ['employer_welcome'] });

        answers[1].resolve(jsonResponse(500, {}));
        await expect(second).resolves.toBe(false);
        answers[0].resolve(jsonResponse(500, {}));
        await expect(first).resolves.toBe(false);
        await settle();

        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
    });

    it('keeps a save that succeeded when a later one fails', async () => {
        signIn('employer');
        const answers = [deferred<Response>(), deferred<Response>()];
        let call = 0;
        serveTutorialsWithSettings({ patch: () => answers[call++].promise });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        let first: Promise<boolean> | undefined;
        let second: Promise<boolean> | undefined;
        act(() => {
            first = current().updateSettings({ always_show: true });
        });
        act(() => {
            second = current().updateSettings({ muted: ['employer_welcome'] });
        });

        answers[1].resolve(jsonResponse(500, {}));
        await expect(second).resolves.toBe(false);
        answers[0].resolve(jsonResponse(200, { settings: { always_show: true, muted: [] } }));
        await expect(first).resolves.toBe(true);
        await settle();

        expect(current().settings).toEqual({ always_show: true, muted: [] });
    });

    it.each([
        ['while the read is in flight', 'loading'],
        ['after the read failed', 'failed'],
    ] as const)('sends nothing, and resolves false, %s', async (_label, state) => {
        signIn('employer');
        if (state === 'loading') apiFetch.mockReturnValue(new Promise(() => {}));
        else serveTutorialsWithSettings({ read: { status: 503 } });
        renderProvider();
        await settle();
        expect(current().status).toBe(state);

        let saved: Promise<boolean> | undefined;
        act(() => {
            saved = current().updateSettings({ always_show: true });
        });

        await expect(saved).resolves.toBe(false);
        expect(current().settings).toEqual(DEFAULT_TUTORIAL_SETTINGS);
        expect(settingsPatches()).toEqual([]);
    });

    it('keeps the settings when an outcome is recorded', async () => {
        signIn('employer');
        serveTutorialsWithSettings({ settings: { always_show: true, muted: ['employer_messages'] } });
        renderProvider();
        await waitFor(() => expect(current().status).toBe('ready'));

        act(() => current().recordOutcome('employer_welcome', 'completed'));
        await settle();

        expect(current().hasRecord('employer_welcome')).toBe(true);
        expect(current().settings).toEqual({ always_show: true, muted: ['employer_messages'] });
    });
});
