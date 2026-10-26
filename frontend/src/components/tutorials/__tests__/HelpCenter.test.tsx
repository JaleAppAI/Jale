import type { ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialRole, TutorialSettings } from '@/lib/api/tutorials';
import { ToastProvider } from '@/components/ui/toast';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { apiFetch, record, resetHarness, route, signIn } from '@/lib/tutorials/__tests__/harness';
import {
    recordPosts,
    serveTutorialsWithSettings,
    settingsPatches,
    type PatchAnswer,
} from '@/lib/tutorials/__tests__/settings-harness';
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
 * The Help center (K1-v2), one page per role inside the role's shell: the
 * "every time" switch, the app tour again, every guide with a Play button,
 * and the guides the person turned off, each with "Show again".
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

const PAGES = { employer: EmployerHelpPage, worker: WorkerHelpPage } as const;

const GUIDES = {
    employer: [
        ['How Jale works', 'From posting a job to hiring, in five steps.'],
        ['Posting a job', 'The three steps and what you must fill in.'],
        ['Your applicants', 'Trust scores, statuses and how to hire.'],
        ['Messages', 'How your messages reach workers on WhatsApp.'],
    ],
    worker: [
        ['Before you start', 'The 7 short steps and the three questions.'],
        ['How applying works', 'Applying, documents and what happens next.'],
        ['Details requested', 'What to do when an employer wants to hire you.'],
        ['Your profile', 'What employers see, and your documents.'],
    ],
} as const;

const SWITCH = 'Show guides every time I start a task';
const HELPER_ON = 'On: each guide opens every time you start its task. You can turn one off from inside it.';
const HELPER_OFF = 'Off: each guide shows only the first time.';

type OpenOptions = {
    settings?: TutorialSettings;
    patch?: PatchAnswer;
    locale?: 'en' | 'es';
};

async function openHelp(role: TutorialRole, { settings = { always_show: false, muted: [] }, patch, locale = 'en' }: OpenOptions = {}) {
    route.path = `/${role}/help`;
    signIn(role);
    const server = serveTutorialsWithSettings({ settings, patch });
    const Page = PAGES[role];
    render(<Page />, { wrapper: providers(locale) });
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    return server;
}

describe.each(['employer', 'worker'] as const)('the %s Help center', (role) => {
    it('is the role’s shell page, titled Help, with the subtitle', async () => {
        await openHelp(role);

        expect(screen.getByRole('heading', { level: 1, name: 'Help' })).toBeInTheDocument();
        expect(screen.getByText('Short guides for each part of Jale.')).toBeInTheDocument();
    });

    it('lists the role’s guides in order, each with its description, length and Play button', async () => {
        await openHelp(role);

        const list = screen.getByRole('list', { name: 'Guides' });
        const items = within(list).getAllByRole('listitem');
        expect(items).toHaveLength(4);
        GUIDES[role].forEach(([title, description], index) => {
            const item = items[index];
            expect(item).toHaveTextContent(title);
            expect(item).toHaveTextContent(description);
            expect(item).toHaveTextContent('1 min');
            expect(within(item).getByRole('button', { name: `Play: ${title}` })).toBeInTheDocument();
        });
    });

    it('turns "every time" on at once, saves it, and changes the helper text', async () => {
        const server = await openHelp(role);
        const toggle = screen.getByRole('switch', { name: SWITCH });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(HELPER_OFF)).toBeInTheDocument();

        act(() => toggle.click());

        expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText(HELPER_ON)).toBeInTheDocument();
        await settle();
        expect(settingsPatches()).toEqual([{ always_show: true }]);
        expect(server.stored().always_show).toBe(true);
        expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('turns "every time" off', async () => {
        await openHelp(role, { settings: { always_show: true, muted: [] } });
        const toggle = screen.getByRole('switch', { name: SWITCH });
        expect(toggle).toHaveAttribute('aria-checked', 'true');

        act(() => toggle.click());
        await settle();

        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(settingsPatches()).toEqual([{ always_show: false }]);
    });

    it('flips the switch back and says so when the save fails', async () => {
        await openHelp(role, { patch: { status: 500 } });
        const toggle = screen.getByRole('switch', { name: SWITCH });

        act(() => toggle.click());
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        await settle();

        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(HELPER_OFF)).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save that. Try again.');
    });

    it('waits for the settings before the switch can be used', async () => {
        route.path = `/${role}/help`;
        signIn(role);
        apiFetch.mockReturnValue(new Promise(() => {}));
        const Page = PAGES[role];
        render(<Page />, { wrapper: providers() });
        await settle();

        expect(screen.getByRole('switch', { name: SWITCH })).toBeDisabled();
    });

    it('replays a guide from its Play button, recording nothing', async () => {
        await openHelp(role, { settings: { always_show: true, muted: [] } });
        const [title] = GUIDES[role][1];

        const play = screen.getByRole('button', { name: `Play: ${title}` });
        act(() => play.click());

        const dialog = await screen.findByRole('dialog', { name: title });
        // A replay never offers "Don't show this again", even with the setting on.
        expect(within(dialog).queryByRole('button', { name: 'Don’t show this again' })).toBeNull();
        act(() => within(dialog).getByRole('button', { name: 'Skip' }).click());
        await settle();
        expect(recordPosts()).toEqual([]);
        expect(document.activeElement).toBe(play);
    });

    it('plays the role’s app tour again as a replay', async () => {
        await openHelp(role);

        act(() => screen.getByRole('button', { name: /Take the app tour again/ }).click());

        const tour = await screen.findByRole('dialog', { name: `Tour ${role}_app_tour` });
        act(() => within(tour).getByRole('button', { name: 'End tour' }).click());
        await settle();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(recordPosts()).toEqual([]);
    });

    it('shows a guide that was turned off, tags it Off, and shows it again', async () => {
        const [mutedTitle] = GUIDES[role][3];
        const mutedId = role === 'employer' ? 'employer_messages' : 'worker_profile';
        await openHelp(role, { settings: { always_show: true, muted: [mutedId] } });

        const guides = within(screen.getByRole('list', { name: 'Guides' })).getAllByRole('listitem');
        expect(guides[3]).toHaveTextContent('Off');
        expect(guides[0]).not.toHaveTextContent('Off');
        const turnedOff = screen.getByRole('list', { name: 'Guides you turned off' });
        expect(within(turnedOff).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            expect.stringContaining(mutedTitle),
        ]);

        act(() => within(turnedOff).getByRole('button', { name: `Show again: ${mutedTitle}` }).click());
        await settle();

        expect(settingsPatches()).toEqual([{ muted: [] }]);
        expect(screen.queryByRole('list', { name: 'Guides you turned off' })).toBeNull();
        expect(screen.getByText('None yet. A guide you turn off shows up here.')).toBeInTheDocument();
        expect(within(screen.getByRole('list', { name: 'Guides' })).getAllByRole('listitem')[3]).not.toHaveTextContent('Off');
    });

    it('says when no guide is turned off', async () => {
        await openHelp(role);

        expect(screen.getByRole('heading', { name: 'Guides you turned off' })).toBeInTheDocument();
        expect(screen.getByText('None yet. A guide you turn off shows up here.')).toBeInTheDocument();
    });

    it('links Help in the header to this page, for the app tour to point at', async () => {
        await openHelp(role);

        const help = screen.getByRole('link', { name: 'Help' });
        expect(help).toHaveAttribute('href', `/${role}/help`);
        expect(help).toHaveAttribute('data-tour', 'help');
    });
});

describe('the Help center in Spanish', () => {
    it('speaks usted to an employer', async () => {
        await openHelp('employer', { locale: 'es', settings: { always_show: true, muted: [] } });

        expect(screen.getByRole('heading', { level: 1, name: 'Ayuda' })).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Mostrar las guías cada vez que empiece una tarea' })).toBeInTheDocument();
        expect(screen.getByText('Encendido: cada guía se abre cada vez que empieza su tarea. Puede apagar una desde la misma guía.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Guías que apagó' })).toBeInTheDocument();
        expect(screen.getByText('Ninguna por ahora. Una guía que apague aparecerá aquí.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Ver: Cómo funciona Jale' })).toBeInTheDocument();
        expect(screen.getByText('De publicar un empleo a contratar, en cinco pasos.')).toBeInTheDocument();
    });

    it('speaks tú to a worker', async () => {
        await openHelp('worker', { locale: 'es', settings: { always_show: true, muted: ['worker_apply'] } });

        expect(screen.getByRole('switch', { name: 'Mostrar las guías cada vez que empieces una tarea' })).toBeInTheDocument();
        expect(screen.getByText('Encendido: cada guía se abre cada vez que empiezas su tarea. Puedes apagar una desde la misma guía.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Guías que apagaste' })).toBeInTheDocument();
        expect(screen.getByText('Apagada')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Volver a mostrar: Cómo postularte' })).toBeInTheDocument();
        expect(screen.getByText('Cómo postularte, los documentos y qué sigue.')).toBeInTheDocument();
    });

    it('says a failed save in the role’s Spanish', async () => {
        await openHelp('worker', { locale: 'es', patch: { status: 500 } });

        act(() => screen.getByRole('switch').click());
        await settle();

        expect(screen.getByRole('alert')).toHaveTextContent('No se pudo guardar. Inténtalo de nuevo.');
    });
});

// Outcomes are recorded only for plays that open by themselves.
describe('a guide with a record', () => {
    it('still replays from Help', async () => {
        route.path = '/employer/help';
        signIn('employer');
        serveTutorialsWithSettings({ records: [record('employer_welcome')] });
        render(<EmployerHelpPage />, { wrapper: providers() });
        await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());

        act(() => screen.getByRole('button', { name: 'Play: How Jale works' }).click());

        expect(await screen.findByRole('dialog', { name: 'How Jale works' })).toBeInTheDocument();
    });
});
