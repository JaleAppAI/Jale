import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialId, TutorialRecord, TutorialSettings } from '@/lib/api/tutorials';
import { Modal } from '@/components/ui/modal';
import { ToastProvider } from '@/components/ui/toast';
import { FIXTURE_MESSAGES, titleOf } from '@/components/tutorials/__tests__/fixtures';
import { OverlayPresenceProvider, useOverlayPresence } from '../overlay';
import { TutorialProgressProvider, useTutorialProgress, type TutorialProgressValue } from '../progress';
import { autoPlayMode, useTutorial } from '../use-tutorial';
import { record, resetHarness, route, signIn } from './harness';
import { recordPosts, serveTutorialsWithSettings, settingsPatches } from './settings-harness';

vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
vi.mock('@/i18n/navigation', async () => ({ usePathname: (await import('./harness')).usePathnameMock }));
vi.mock('@/lib/api', async () => {
    const harness = await import('./harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});
vi.mock('@/lib/tutorials/registry', async () => {
    const { FIXTURE_REGISTRY } = await import('@/components/tutorials/__tests__/fixtures');
    return {
        TUTORIALS: FIXTURE_REGISTRY,
        getTutorial: (id: TutorialId) => FIXTURE_REGISTRY[id],
        tutorialsForRole: (role: string) => Object.values(FIXTURE_REGISTRY).filter((item) => item.role === role),
    };
});

/*
 * "Show guides every time" and "Don't show this again" (K1-v2). With the
 * setting on, a guide opens every time its task starts whatever was recorded
 * before, and offers a way to turn it off; a guide turned off never opens by
 * itself again, setting or not. Everything else about when a guide may open
 * (the read, the role, one dialog at a time) is unchanged.
 */

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeAll(async () => {
    await import('@/components/tutorials/TutorialHost');
});

beforeEach(() => {
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
});

afterEach(() => {
    vi.restoreAllMocks();
});

const MUTE = 'Don’t show this again';

function providers(locale: 'en' | 'es' = 'en') {
    const messages = { ...(locale === 'en' ? en : es), ...FIXTURE_MESSAGES[locale] };
    return function Providers({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
                <OverlayPresenceProvider>
                    <ToastProvider>
                        <TutorialProgressProvider>{children}</TutorialProgressProvider>
                    </ToastProvider>
                </OverlayPresenceProvider>
            </NextIntlClientProvider>
        );
    };
}

async function settle() {
    for (let turn = 0; turn < 2; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const tutorialDialog = (id: TutorialId, locale: 'en' | 'es' = 'en') =>
    screen.queryByRole('dialog', { name: titleOf(id, locale) });

function AutoPage({ id = 'employer_welcome', done }: { id?: TutorialId; done: boolean | undefined }) {
    const tutorial = useTutorial(id, { done });
    useEffect(() => {
        tutorial.maybeAutoOpen();
    }, [tutorial, done]);
    return <p>page</p>;
}

function OtherOverlay({ open }: { open: boolean }) {
    useOverlayPresence(open);
    return open ? <div role="dialog" aria-label="Other dialog" /> : null;
}

function HostPage({ done = false, onHostOpen = () => {} }: { done?: boolean; onHostOpen?: () => void }) {
    const tutorial = useTutorial('employer_post_job', { done });
    const [hostOpen, setHostOpen] = useState(false);
    return (
        <>
            <button
                type="button"
                onClick={() =>
                    tutorial.runBeforeHost(() => {
                        onHostOpen();
                        setHostOpen(true);
                    })
                }
            >
                Post a job
            </button>
            <Modal open={hostOpen} onClose={() => setHostOpen(false)} title="Job form">
                <button type="button">Job title</button>
            </Modal>
        </>
    );
}

let progress: TutorialProgressValue | null = null;
function keep(value: TutorialProgressValue | null) {
    progress = value;
}
function Grab() {
    keep(useTutorialProgress());
    return null;
}

function readyEmployer(settings: TutorialSettings, records: TutorialRecord[] = []) {
    route.path = '/employer/dashboard';
    signIn('employer');
    return serveTutorialsWithSettings({ settings, records });
}

const ALWAYS: TutorialSettings = { always_show: true, muted: [] };
const FIRST_TIME: TutorialSettings = { always_show: false, muted: [] };

describe('autoPlayMode: the eligibility matrix', () => {
    function fakeProgress({
        always = false,
        muted = [] as TutorialId[],
        recorded = false,
        flagged = false,
        busy = false,
        status = 'ready' as TutorialProgressValue['status'],
        role = 'employer' as TutorialProgressValue['role'],
    } = {}): TutorialProgressValue {
        return {
            status,
            role,
            shellRole: role,
            settings: { always_show: always, muted },
            hasRecord: () => recorded,
            isFlagged: () => flagged,
            isBusy: () => busy,
        } as unknown as TutorialProgressValue;
    }

    it.each([
        ['nothing recorded, not done', {}, false],
        ['a record', { recorded: true }, false],
        ['a failed-save flag', { flagged: true }, false],
        ['the task done', {}, true],
        ['the task not known yet', {}, undefined],
    ] as const)('plays "always" with the setting on, whatever the history: %s', (_label, history, done) => {
        expect(autoPlayMode(fakeProgress({ always: true, ...history }), 'employer_welcome', done)).toBe('always');
    });

    it('plays "auto" with the setting off, for a first time', () => {
        expect(autoPlayMode(fakeProgress(), 'employer_welcome', false)).toBe('auto');
    });

    it.each([
        ['a record', { recorded: true }, false],
        ['a failed-save flag', { flagged: true }, false],
        ['the task done', {}, true],
        ['the task not known yet', {}, undefined],
    ] as const)('keeps today’s rule with the setting off: %s never plays', (_label, history, done) => {
        expect(autoPlayMode(fakeProgress(history), 'employer_welcome', done)).toBeNull();
    });

    it.each([true, false])('never plays a muted guide (setting %s)', (always) => {
        expect(autoPlayMode(fakeProgress({ always, muted: ['employer_welcome'] }), 'employer_welcome', false)).toBeNull();
    });

    it('mutes only the guide that was turned off', () => {
        expect(autoPlayMode(fakeProgress({ always: true, muted: ['employer_post_job'] }), 'employer_welcome', true)).toBe('always');
    });

    it.each([
        ['another play is pending or up', { busy: true }],
        ['the read has not answered', { status: 'loading' }],
        ['the read failed', { status: 'failed' }],
        ['the route is the other role’s', { role: 'worker' }],
    ] as const)('never plays when %s, setting on or off', (_label, state) => {
        expect(autoPlayMode(fakeProgress({ always: true, ...state }), 'employer_welcome', false)).toBeNull();
        expect(autoPlayMode(fakeProgress({ ...state }), 'employer_welcome', false)).toBeNull();
    });
});

describe('page guides with the setting on', () => {
    it('opens on a page view even with a record and the task done, and offers to turn it off', async () => {
        readyEmployer(ALWAYS, [record('employer_welcome')]);

        render(<AutoPage done={true} />, { wrapper: providers() });

        const dialog = await waitFor(() => {
            const found = tutorialDialog('employer_welcome');
            expect(found).toBeInTheDocument();
            return found as HTMLElement;
        });
        expect(within(dialog).getByRole('button', { name: MUTE })).toBeInTheDocument();
    });

    it('opens again on the next page view after it was dismissed, without recording twice', async () => {
        readyEmployer(ALWAYS);
        function Shell({ page }: { page: number }) {
            return <AutoPage key={page} done={false} />;
        }
        const view = render(<Shell page={1} />, { wrapper: providers() });
        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        expect(dialogs()).toBe(0);

        view.rerender(<Shell page={2} />);

        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        // The first outcome ever recorded is the only one.
        expect(recordPosts()).toEqual([{ tutorial_id: 'employer_welcome', outcome: 'skipped' }]);
    });

    it('never opens a muted guide', async () => {
        readyEmployer({ always_show: true, muted: ['employer_welcome'] });

        render(<AutoPage done={false} />, { wrapper: providers() });
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('still gives way to another overlay', async () => {
        readyEmployer(ALWAYS);

        render(
            <>
                <OtherOverlay open />
                <AutoPage done={false} />
            </>,
            { wrapper: providers() },
        );
        await settle();

        expect(tutorialDialog('employer_welcome')).toBeNull();
        expect(dialogs()).toBe(1);
    });

    it('still opens one guide at a time', async () => {
        readyEmployer(ALWAYS);

        render(
            <>
                <AutoPage id="employer_welcome" done={true} />
                <AutoPage id="employer_applicants" done={true} />
            </>,
            { wrapper: providers() },
        );
        await settle();

        expect(dialogs()).toBe(1);
    });
});

describe('page guides with the setting off', () => {
    it('opens a first-time guide with no way to turn it off', async () => {
        readyEmployer(FIRST_TIME);

        render(<AutoPage done={false} />, { wrapper: providers() });

        await waitFor(() => expect(tutorialDialog('employer_welcome')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: MUTE })).toBeNull();
    });

    it('keeps a guide with a record closed', async () => {
        readyEmployer(FIRST_TIME, [record('employer_welcome')]);

        render(<AutoPage done={false} />, { wrapper: providers() });
        await settle();

        expect(dialogs()).toBe(0);
    });

    it('never opens a muted guide, even the first time', async () => {
        readyEmployer({ always_show: false, muted: ['employer_welcome'] });

        render(<AutoPage done={false} />, { wrapper: providers() });
        await settle();

        expect(dialogs()).toBe(0);
    });
});

describe('guides before a host with the setting on', () => {
    it('plays on every press, then opens the host each time', async () => {
        readyEmployer(ALWAYS, [record('employer_post_job')]);
        const onHostOpen = vi.fn();
        render(<HostPage done={true} onHostOpen={onHostOpen} />, { wrapper: providers() });
        await settle();

        for (let press = 1; press <= 2; press += 1) {
            act(() => screen.getByRole('button', { name: 'Post a job' }).click());
            await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
            expect(onHostOpen).toHaveBeenCalledTimes(press - 1);
            act(() => screen.getByRole('button', { name: 'Skip' }).click());
            await settle();
            expect(onHostOpen).toHaveBeenCalledTimes(press);
            fireEvent.keyDown(document, { key: 'Escape' });
            await settle();
        }
        expect(recordPosts()).toEqual([]);
    });

    it('opens the host at once for a muted guide', async () => {
        readyEmployer({ always_show: true, muted: ['employer_post_job'] });
        const onHostOpen = vi.fn();
        render(<HostPage onHostOpen={onHostOpen} />, { wrapper: providers() });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());

        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(tutorialDialog('employer_post_job')).toBeNull();
    });
});

describe('"Don’t show this again"', () => {
    it('turns the guide off, closes it as skipped, and lets the task go on', async () => {
        const server = readyEmployer(ALWAYS);
        const onHostOpen = vi.fn();
        render(<HostPage onHostOpen={onHostOpen} />, { wrapper: providers() });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: MUTE }).click());
        await settle();

        expect(settingsPatches()).toEqual([{ muted: ['employer_post_job'] }]);
        expect(server.stored().muted).toEqual(['employer_post_job']);
        expect(tutorialDialog('employer_post_job')).toBeNull();
        expect(onHostOpen).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('dialog', { name: 'Job form' })).toBeInTheDocument();
        // No outcome yet for this account: the skip is its first.
        expect(recordPosts()).toEqual([{ tutorial_id: 'employer_post_job', outcome: 'skipped' }]);
        expect(screen.getByText('Turned off. You can turn it back on in Help.')).toBeInTheDocument();
    });

    it('records nothing when the account already has an outcome', async () => {
        readyEmployer(ALWAYS, [record('employer_post_job')]);
        render(<HostPage />, { wrapper: providers() });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: MUTE }).click());
        await settle();

        expect(settingsPatches()).toEqual([{ muted: ['employer_post_job'] }]);
        expect(recordPosts()).toEqual([]);
    });

    it('keeps the other guides it had turned off', async () => {
        readyEmployer({ always_show: true, muted: ['employer_messages'] });
        render(<HostPage />, { wrapper: providers() });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: MUTE }).click());
        await settle();

        expect(settingsPatches()).toEqual([{ muted: ['employer_messages', 'employer_post_job'] }]);
    });

    it('opens the host at once on the next press', async () => {
        readyEmployer(ALWAYS);
        const onHostOpen = vi.fn();
        render(<HostPage onHostOpen={onHostOpen} />, { wrapper: providers() });
        await settle();
        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: MUTE }).click());
        await settle();
        fireEvent.keyDown(document, { key: 'Escape' });
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());

        expect(onHostOpen).toHaveBeenCalledTimes(2);
        expect(tutorialDialog('employer_post_job')).toBeNull();
    });

    it('says so when the change could not be saved, and the guide comes back', async () => {
        route.path = '/employer/dashboard';
        signIn('employer');
        serveTutorialsWithSettings({ settings: ALWAYS, patch: { status: 500 } });
        render(
            <>
                <Grab />
                <HostPage />
            </>,
            { wrapper: providers() },
        );
        await settle();

        act(() => screen.getByRole('button', { name: 'Post a job' }).click());
        await waitFor(() => expect(tutorialDialog('employer_post_job')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: MUTE }).click());
        await settle();

        expect(await screen.findByText('Couldn’t save that. Try again.')).toBeInTheDocument();
        expect(progress?.settings.muted).toEqual([]);
    });

    it('speaks each role’s Spanish', async () => {
        route.path = '/worker/home';
        signIn('worker');
        serveTutorialsWithSettings({ settings: ALWAYS });
        render(<AutoPage id="worker_apply" done={false} />, { wrapper: providers('es') });

        await waitFor(() => expect(tutorialDialog('worker_apply', 'es')).toBeInTheDocument());
        act(() => screen.getByRole('button', { name: 'No volver a mostrar' }).click());
        await settle();

        expect(screen.getByText('Guía apagada. Puedes volver a activarla en Ayuda.')).toBeInTheDocument();
        expect(settingsPatches()).toEqual([{ muted: ['worker_apply'] }]);
    });

    it('is not offered in a replay', async () => {
        readyEmployer(ALWAYS);
        render(
            <>
                <Grab />
                <p>page</p>
            </>,
            { wrapper: providers() },
        );
        await waitFor(() => expect(progress?.status).toBe('ready'));

        act(() => {
            progress?.play({ id: 'employer_messages', mode: 'replay' });
        });

        await waitFor(() => expect(tutorialDialog('employer_messages')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: MUTE })).toBeNull();
    });
});
