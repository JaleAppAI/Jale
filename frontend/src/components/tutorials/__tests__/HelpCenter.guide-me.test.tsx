import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { ToastProvider } from '@/components/ui/toast';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { useRegisterGuideLauncher } from '@/lib/tutorials/launchers';
import { resetHarness, route, signIn } from '@/lib/tutorials/__tests__/harness';
import { serveTutorialsWithSettings } from '@/lib/tutorials/__tests__/settings-harness';
import EmployerHelpPage from '@/app/[locale]/employer/help/page';
import WorkerHelpPage from '@/app/[locale]/worker/help/page';

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={typeof href === 'string' ? href : '#'} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/api', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return { apiFetch: (...args: unknown[]) => harness.apiFetch(...args) };
});
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ handleLegalWall: vi.fn(), idToken: null, isAuthenticated: true, isLoading: false }),
}));
vi.mock('@/contexts/SidebarProfileContext', () => ({ useSidebarProfile: () => ({ status: 'loading' }) }));
vi.mock('next/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/navigation')>()),
    useSearchParams: () => new URLSearchParams(),
}));
// The tour overlay is another lane's. A stand-in that shows which tour played
// and lets the test end it the way the real one does.
vi.mock('@/components/tutorials/AppTourHost', () => ({
    default: ({ id, onDismiss }: { id: string; onDismiss: (outcome: 'completed' | 'skipped') => void }) => (
        <div role="dialog" aria-label={`Tour ${id}`}>
            <button type="button" onClick={() => onDismiss('completed')}>
                End tour
            </button>
        </div>
    ),
}));

/*
 * Help's "Guide me through it": a task whose host can start its step-by-step
 * guide (it registered a launcher) gets the action on its row; Play still
 * shows the slides; no other row gets one.
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

function providers(locale: 'en' | 'es' = 'en') {
    const messages = locale === 'en' ? en : es;
    return function Providers({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={messages}>
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


/** The wizard's owner, as `PostJobContext` registers it. */
function PostJobLauncher({ launch }: { launch: (() => void) | null }) {
    useRegisterGuideLauncher('employer_post_job', launch);
    return null;
}

const guideMe = (name = 'Guide me through it: Posting a job') => screen.queryByRole('button', { name });

describe('Help: "Guide me through it"', () => {
    it('is on the row of a guide whose host registered a launcher, and starts it', async () => {
        route.path = '/employer/help';
        signIn('employer');
        serveTutorialsWithSettings();
        const launch = vi.fn();
        render(
            <>
                <PostJobLauncher launch={launch} />
                <EmployerHelpPage />
            </>,
            { wrapper: providers() },
        );
        await settle();
        const button = guideMe();
        expect(button).not.toBeNull();
        expect(button?.textContent).toBe('Guide me through it');
        // Only that row: the other three guides have none.
        expect(screen.getAllByRole('button', { name: /^Guide me through it/ })).toHaveLength(1);
        // Play is still there, for the slides.
        expect(screen.getByRole('button', { name: 'Play: Posting a job' })).toBeInTheDocument();

        act(() => {
            fireEvent.click(button as HTMLElement);
        });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(button);
    });

    it('is not there while no launcher is registered, or after it goes', async () => {
        route.path = '/employer/help';
        signIn('employer');
        serveTutorialsWithSettings();
        const { rerender } = render(
            <>
                <PostJobLauncher launch={null} />
                <EmployerHelpPage />
            </>,
            { wrapper: providers() },
        );
        await settle();
        expect(guideMe()).toBeNull();

        const launch = vi.fn();
        rerender(
            <>
                <PostJobLauncher launch={launch} />
                <EmployerHelpPage />
            </>,
        );
        await settle();
        expect(guideMe()).not.toBeNull();

        rerender(<EmployerHelpPage />);
        await settle();
        expect(guideMe()).toBeNull();
    });

    it('is never on the worker’s Help: a launcher only shows on its own role’s rows', async () => {
        route.path = '/worker/help';
        signIn('worker');
        serveTutorialsWithSettings();
        render(
            <>
                <PostJobLauncher launch={vi.fn()} />
                <WorkerHelpPage />
            </>,
            { wrapper: providers() },
        );
        await settle();
        expect(screen.queryAllByRole('button', { name: /^Guide me through it/ })).toEqual([]);
    });

    it('reads "Guíeme paso a paso" for the employer in Spanish', async () => {
        route.path = '/employer/help';
        signIn('employer');
        serveTutorialsWithSettings();
        render(
            <>
                <PostJobLauncher launch={vi.fn()} />
                <EmployerHelpPage />
            </>,
            { wrapper: providers('es') },
        );
        await settle();
        const button = screen.getByRole('button', { name: `Guíeme paso a paso: ${es.tutorial.employer_post_job.title}` });
        expect(button.textContent).toBe('Guíeme paso a paso');
    });
});
