import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { EMPLOYER_TUTORIAL_IDS, WORKER_TUTORIAL_IDS, type TutorialId } from '@/lib/api/tutorials';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import {
    record,
    resetHarness,
    route,
    serveTutorials,
    signIn,
    tutorialCalls,
} from '@/lib/tutorials/__tests__/harness';
import { ReportProblemContext } from '@/components/report/report-problem-context';
import { AppShell } from '@/components/layout/AppShell';
import { HelpEntryButton } from '../HelpMenu';
import { FIXTURE_MESSAGES, titleOf } from './fixtures';

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
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
vi.mock('@/lib/tutorials/registry', async () => {
    const { FIXTURE_REGISTRY } = await import('./fixtures');
    const { EMPLOYER_TUTORIAL_IDS: employer, WORKER_TUTORIAL_IDS: worker } = await import('@/lib/api/tutorials');
    return {
        TUTORIALS: FIXTURE_REGISTRY,
        getTutorial: (id: TutorialId) => FIXTURE_REGISTRY[id],
        tutorialsForRole: (role: string) => (role === 'employer' ? employer : worker).map((id) => FIXTURE_REGISTRY[id]),
    };
});
vi.mock('@/contexts/SidebarProfileContext', () => ({ useSidebarProfile: () => ({ status: 'loading' }) }));
vi.mock('next/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('next/navigation')>()),
    useSearchParams: () => new URLSearchParams(),
}));

/*
 * Help (ruling R10): a "Help" button in the signed-in headers that opens
 * "How Jale works", the role's tutorials. Choosing one closes Help and then
 * replays the tutorial, through the same post-commit path as "before the host"
 * (R4), so there is never more than one dialog. A replay records nothing.
 */

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
});

function providers(locale: 'en' | 'es' = 'en') {
    const messages = { ...(locale === 'en' ? en : es), ...FIXTURE_MESSAGES[locale] };
    return function Providers({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
                <OverlayPresenceProvider>
                    <TutorialProgressProvider>{children}</TutorialProgressProvider>
                </OverlayPresenceProvider>
            </NextIntlClientProvider>
        );
    };
}

async function settle() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const dialogs = () => document.querySelectorAll('[role="dialog"]').length;

function watchDialogs() {
    let most = dialogs();
    const observer = new MutationObserver(() => {
        most = Math.max(most, dialogs());
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { most: () => most, stop: () => observer.disconnect() };
}

async function openHelp() {
    const help = screen.getByRole('button', { name: 'Help' });
    help.focus();
    act(() => help.click());
    return { help, menu: await screen.findByRole('dialog', { name: 'How Jale works' }) };
}

describe('HelpEntryButton', () => {
    it('renders nothing outside the tutorial provider', () => {
        render(
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                <HelpEntryButton />
            </NextIntlClientProvider>,
        );

        expect(screen.queryByRole('button')).toBeNull();
    });

    it('renders nothing on a page outside the signed-in shells', async () => {
        route.path = '/j/AB12CD';

        render(<HelpEntryButton />, { wrapper: providers() });
        await settle();

        expect(screen.queryByRole('button')).toBeNull();
    });

    it('lists the employer’s tutorials in order under "How Jale works"', async () => {
        signIn('employer');
        serveTutorials([]);
        render(<HelpEntryButton />, { wrapper: providers() });

        const { menu } = await openHelp();

        const items = within(menu).getAllByRole('listitem').map((item) => item.textContent);
        expect(items).toEqual(EMPLOYER_TUTORIAL_IDS.map((id) => titleOf(id)));
    });

    it('lists the worker’s tutorials on a worker route, onboarding included', async () => {
        route.path = '/worker/onboarding';
        signIn('worker');
        serveTutorials([]);
        render(<HelpEntryButton />, { wrapper: providers() });

        const { menu } = await openHelp();

        const items = within(menu).getAllByRole('listitem').map((item) => item.textContent);
        expect(items).toEqual(WORKER_TUTORIAL_IDS.map((id) => titleOf(id)));
    });

    it('is there before the session has been restored: replay needs no network', async () => {
        route.path = '/employer/dashboard';

        render(<HelpEntryButton />, { wrapper: providers() });
        await settle();

        expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
        expect(tutorialCalls()).toEqual([]);
    });

    it('replays the chosen tutorial after Help closes: one dialog at a time, nothing recorded, focus back on Help', async () => {
        signIn('employer');
        serveTutorials([record('employer_applicants')]);
        render(<HelpEntryButton />, { wrapper: providers() });
        await waitFor(() => expect(tutorialCalls()).toHaveLength(1));
        await settle();
        const watch = watchDialogs();

        const { help, menu } = await openHelp();
        act(() => within(menu).getByRole('button', { name: titleOf('employer_applicants') }).click());
        const tutorial = await screen.findByRole('dialog', { name: titleOf('employer_applicants') });
        expect(screen.queryByRole('dialog', { name: 'How Jale works' })).toBeNull();
        expect(tutorial.contains(document.activeElement)).toBe(true);

        act(() => screen.getByRole('button', { name: 'Skip' }).click());
        await settle();
        watch.stop();

        expect(dialogs()).toBe(0);
        expect(watch.most()).toBe(1);
        expect(document.activeElement).toBe(help);
        expect(tutorialCalls().filter(([method]) => method === 'POST')).toEqual([]);
        expect(document.body.style.overflow).toBe('');
    });

    it('replays even when the progress read failed', async () => {
        signIn('employer');
        serveTutorials({ status: 503 });
        render(<HelpEntryButton />, { wrapper: providers() });
        await settle();

        const { menu } = await openHelp();
        act(() => within(menu).getByRole('button', { name: titleOf('employer_welcome') }).click());

        expect(await screen.findByRole('dialog', { name: titleOf('employer_welcome') })).toBeInTheDocument();
    });

    it('closes with its X or Escape and hands focus back to the Help button', async () => {
        signIn('employer');
        serveTutorials([]);
        render(<HelpEntryButton />, { wrapper: providers() });

        const first = await openHelp();
        act(() => within(first.menu).getByRole('button', { name: 'Close' }).click());
        expect(dialogs()).toBe(0);
        expect(document.activeElement).toBe(first.help);

        await openHelp();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(dialogs()).toBe(0);
        expect(document.activeElement).toBe(first.help);
        expect(tutorialCalls().filter(([method]) => method === 'POST')).toEqual([]);
    });

    it('starts the menu on its first tutorial', async () => {
        signIn('employer');
        serveTutorials([]);
        render(<HelpEntryButton />, { wrapper: providers() });

        const { menu } = await openHelp();

        expect(document.activeElement).toBe(within(menu).getByRole('button', { name: titleOf('employer_welcome') }));
    });

    it('speaks Spanish', async () => {
        signIn('employer');
        serveTutorials([]);
        render(<HelpEntryButton />, { wrapper: providers('es') });

        const help = screen.getByRole('button', { name: 'Ayuda' });
        act(() => help.click());

        const menu = await screen.findByRole('dialog', { name: 'Cómo funciona Jale' });
        expect(within(menu).getByRole('button', { name: 'Cerrar' })).toBeInTheDocument();
        expect(within(menu).getByRole('button', { name: titleOf('employer_welcome', 'es') })).toBeInTheDocument();
    });

    it('takes the report button’s tones and sizes', async () => {
        render(
            <>
                <HelpEntryButton tone="brand" size="sm" />
            </>,
            { wrapper: providers() },
        );
        await settle();

        const help = screen.getByRole('button', { name: 'Help' });
        expect(help.className).toContain('border-white/20');
        expect(help.className).toContain('h-8');
    });
});

describe('AppShell', () => {
    function shell(role: 'employer' | 'worker') {
        return (
            <ReportProblemContext value={{ openReport: vi.fn(), registerCategoryHint: () => () => {} }}>
                <AppShell role={role} title="Sample page">
                    <p>page</p>
                </AppShell>
            </ReportProblemContext>
        );
    }

    it('puts Help right after the report button, with its own name', async () => {
        signIn('employer');
        serveTutorials([]);
        render(shell('employer'), { wrapper: providers() });
        await settle();

        const report = screen.getByRole('button', { name: 'Report a problem' });
        const help = screen.getByRole('button', { name: 'Help' });
        expect(report.nextElementSibling).toBe(help);
    });

    it('renders no Help button without the tutorial provider, as before', () => {
        render(
            <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
                {shell('worker')}
            </NextIntlClientProvider>,
        );

        expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Report a problem' })).toBeInTheDocument();
    });
});
