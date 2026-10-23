// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { InboxItem } from '@/lib/api/employer';
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
 * E4 in the floating drawer, with the real tutorial machinery: the progress
 * store, the overlay coordinator, the lazily loaded player and the real
 * messages tour. The inbox is driven from the test.
 *
 * For an employer with no conversation yet (K1.5), the tour plays before the
 * drawer opens, from either way in: the launcher, or "Message" on an applicant
 * elsewhere in the app. The drawer opens once the tour has gone, with focus
 * back on what was pressed. While the inbox has not answered, the drawer
 * simply opens.
 */

vi.mock('@/i18n/navigation', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
            <a href={href} {...rest}>{children}</a>
        ),
        usePathname: harness.usePathnameMock,
        useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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

vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getConversation: vi.fn(),
    startConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    closeConversation: vi.fn(),
}));

/** The session-wide inbox, driven from the test. */
const inbox = vi.hoisted(() => ({
    state: { loading: false, errorKind: null as string | null, items: [] as unknown[] },
}));
vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        ...inbox.state,
        unreadCount: 0,
        unreadByConversation: {},
        retry: vi.fn(),
        refresh: vi.fn(async () => {}),
        markRead: vi.fn(async () => true),
    }),
    useUnreadCount: () => 0,
}));

import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import { ConversationDrawerProvider, useConversationDrawer } from '@/contexts/ConversationDrawerContext';
import type { ConversationTarget } from '@/contexts/ConversationDrawerContext';

function row(overrides: Partial<InboxItem> & { application_id: string }): InboxItem {
    return {
        worker_id: 'w-1',
        worker_name: 'Test Worker',
        job_id: 'job-1',
        job_title: 'Concrete Finisher',
        job_city: 'El Paso',
        job_state_region: 'TX',
        job_status: 'active',
        application_status: 'pending',
        applied_at: '2026-09-10T00:00:00Z',
        conversation_id: null,
        conversation_status: null,
        last_message_at: null,
        last_worker_message_at: null,
        last_message_preview: null,
        tab: 'active',
        unread: false,
        ...overrides,
    };
}

const neverMessaged = row({ application_id: 'app-1' });
const messaged = row({
    application_id: 'app-2',
    worker_id: 'w-2',
    worker_name: 'Sample Worker',
    conversation_id: 'conv-2',
    conversation_status: 'open',
    last_message_at: '2026-09-16T10:00:00Z',
});

const target: ConversationTarget = {
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: 'Test Worker',
    job_id: 'job-1',
    job_title: 'Concrete Finisher',
} as ConversationTarget;

/** A page that asks the drawer to open one applicant, as "Message" on the applicants board does. */
function OpenerPage() {
    const { openConversation } = useConversationDrawer();
    return (
        <button type="button" onClick={() => openConversation(target)}>
            Message applicant
        </button>
    );
}

function renderShell() {
    return render(
        <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <ConversationDrawerProvider>
                        <OpenerPage />
                    </ConversationDrawerProvider>
                </TutorialProgressProvider>
            </OverlayPresenceProvider>
        </NextIntlClientProvider>,
    );
}

/**
 * Several separate acts, each a short real wait: long enough for the lazily
 * loaded player to arrive, so "no tour" means it was never asked for.
 */
async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
    }
}

const tourTitle = () => message('tutorial.employer_messages.title');
const tourDialog = () => screen.queryByRole('dialog', { name: tourTitle() });
const launcher = () => screen.getByRole('button', { expanded: false }) as HTMLButtonElement;
const drawerOpen = () => document.querySelector('button[aria-expanded="true"]') !== null;
const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

/** Finishes the tour from its first slide. */
function finishTour() {
    const tour = tourDialog();
    expect(tour).not.toBeNull();
    for (let turn = 0; turn < 2; turn += 1) {
        act(() => {
            fireEvent.click(within(tour as HTMLElement).getByRole('button', { name: message('tutorial.common.next') }));
        });
    }
    act(() => {
        fireEvent.click(within(tour as HTMLElement).getByRole('button', { name: message('tutorial.common.got_it') }));
    });
}

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/employer/applicants';
    signIn('employer');
    serveTutorials([]);
    inbox.state = { loading: false, errorKind: null, items: [neverMessaged] };
});

describe('the drawer with the real messages tour', () => {
    it('from the launcher: the tour plays first, then the drawer opens with focus on the launcher', async () => {
        renderShell();
        await settle();
        const dialogs = watchDialogs();

        const button = launcher();
        button.focus();
        act(() => {
            fireEvent.click(button);
        });
        const tour = await screen.findByRole('dialog', { name: tourTitle() });
        expect(drawerOpen()).toBe(false);
        expect(within(tour).getByRole('heading', { level: 2 }).textContent).toBe(
            message('tutorial.employer_messages.slides.whatsapp.title'),
        );

        finishTour();
        await waitFor(() => expect(drawerOpen()).toBe(true));
        expect(tourDialog()).toBeNull();
        expect(document.activeElement).toBe(button);
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_messages', outcome: 'completed' }]);
        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });

    it('from "Message" on an applicant: the tour plays first, then the drawer opens on that applicant', async () => {
        renderShell();
        await settle();

        const opener = screen.getByRole('button', { name: 'Message applicant' });
        opener.focus();
        act(() => {
            fireEvent.click(opener);
        });
        const tour = await screen.findByRole('dialog', { name: tourTitle() });
        expect(drawerOpen()).toBe(false);

        act(() => {
            fireEvent.click(within(tour).getByRole('button', { name: message('tutorial.common.skip') }));
        });
        await waitFor(() => expect(drawerOpen()).toBe(true));
        expect(tourDialog()).toBeNull();
        expect(document.activeElement).toBe(opener);
        expect(screen.getAllByText('Test Worker').length).toBeGreaterThan(0);
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_messages', outcome: 'skipped' }]);
    });

    it('opens the drawer at once for an employer who already has a conversation', async () => {
        inbox.state = { loading: false, errorKind: null, items: [neverMessaged, messaged] };
        renderShell();
        await settle();

        act(() => {
            fireEvent.click(launcher());
        });
        expect(drawerOpen()).toBe(true);
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('opens the drawer at once while the inbox has not answered', async () => {
        inbox.state = { loading: true, errorKind: null, items: [] };
        renderShell();
        await settle();

        act(() => {
            fireEvent.click(launcher());
        });
        expect(drawerOpen()).toBe(true);
        await settle();
        expect(tourDialog()).toBeNull();
    });

    it('opens the drawer at once once the tour was finished or skipped before', async () => {
        serveTutorials([record('employer_messages', 'skipped')]);
        renderShell();
        await settle();

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Message applicant' }));
        });
        await waitFor(() => expect(drawerOpen()).toBe(true));
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });
});
