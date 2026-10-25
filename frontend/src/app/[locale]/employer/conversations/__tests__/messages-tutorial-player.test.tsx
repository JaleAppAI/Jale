// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import type { EmployerInboxResponse, InboxItem } from '@/lib/api/employer';
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
 * E4 on the Messages board, with the real tutorial machinery: the progress
 * store, the overlay coordinator, the lazily loaded player and the real
 * messages tour. The board's inbox read and the session inbox are stand-ins.
 *
 * Picking a row, for an employer with no conversation yet (K1.5), plays the
 * tour first; the picked thread opens once it has gone, with focus back on
 * the row.
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

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

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

vi.mock('@/hooks/useRequireAuth', async () => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        useRequireAuth: () => ({
            handleLegalWall: (err: unknown) => {
                throw err;
            },
            idToken: harness.auth.state.idToken,
            isAuthenticated: true,
            isLoading: false,
        }),
    };
});

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/toast', () => ({
    useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

/** The session-wide inbox, as the context polls it. */
const polled = vi.hoisted(() => ({
    state: { loading: false, items: [] as unknown[] },
}));
vi.mock('@/contexts/UnreadMessagesContext', () => ({
    useUnreadMessages: () => ({
        items: polled.state.items,
        unreadCount: 0,
        unreadByConversation: {},
        loading: polled.state.loading,
        errorKind: null,
        retry: vi.fn(),
        refresh: vi.fn(async () => {}),
        markRead: vi.fn(async () => true),
    }),
    useUnreadCount: () => 0,
}));

vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    getInbox: vi.fn(),
    getConversation: vi.fn(),
    sendConversationMessage: vi.fn(),
    startConversation: vi.fn(),
    closeConversation: vi.fn(),
    updateApplicantStatus: vi.fn(),
}));

import { getInbox } from '@/lib/api/employer';
import { OverlayPresenceProvider } from '@/lib/tutorials/overlay';
import { TutorialProgressProvider } from '@/lib/tutorials/progress';
import EmployerConversationsPage from '../page';

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

function board(items: InboxItem[]): EmployerInboxResponse {
    return {
        items,
        jobs: [{ job_id: 'job-1', title: 'Concrete Finisher', city: 'El Paso', status: 'active' }],
        unread_count: 0,
    } as EmployerInboxResponse;
}

function renderBoard() {
    return render(
        <NextIntlClientProvider locale="en" messages={catalogues.en} onError={() => {}}>
            <OverlayPresenceProvider>
                <TutorialProgressProvider>
                    <EmployerConversationsPage />
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
/** The slides player (E4 no longer plays them here) or the guide's callout. */
const tourDialog = () => screen.queryByRole('dialog', { name: tourTitle() }) ?? guideCard();
/** The step-by-step guide's callout, when one is drawn. */
const guideCard = () => document.querySelector<HTMLElement>('[data-spotlight] [role="dialog"]');
const nothingPicked = () => screen.queryAllByText(message('employer_messages.empty_select')).length > 0;
const posts = () => tutorialCalls().filter(([method]) => method === 'POST');

/** The list row for one worker, found by the name it prints. */
function rowFor(name: string): HTMLButtonElement {
    const label = screen.getAllByText(name)[0];
    const button = label.closest('button');
    if (!button) throw new Error(`no row for ${name}`);
    return button;
}

beforeAll(async () => {
    // The guides' lazy chunk, fetched once up front: a cold first import
    // would otherwise spend the first test's wait on module transforms.
    await import('@/components/tutorials/GuideHost');
});

let rectsSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
    // jsdom does no layout; one rect per element keeps focusables in the dialog's trap.
    rectsSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
});
afterAll(() => rectsSpy.mockRestore());

beforeEach(() => {
    resetHarness();
    vi.mocked(getInbox).mockReset();
    sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/employer/conversations';
    signIn('employer');
    serveTutorials([]);
    polled.state = { loading: false, items: [neverMessaged] };
    vi.mocked(getInbox).mockResolvedValue(board([neverMessaged]));
});

describe('the Messages board with the real messages tour', () => {
    it('opens the picked thread at once, then the messages guide starts over it', async () => {
        renderBoard();
        await waitFor(() => expect(rowFor('Test Worker')).toBeTruthy());
        await settle();
        const dialogs = watchDialogs();

        act(() => {
            fireEvent.click(rowFor('Test Worker'));
        });
        // The host first: E4 is a step-by-step guide over the conversation just opened.
        expect(nothingPicked()).toBe(false);
        const intro = await waitFor(() => {
            const card = guideCard();
            expect(card?.getAttribute('data-step')).toBe('intro');
            return card as HTMLElement;
        }, { timeout: 4000 });
        act(() => {
            fireEvent.click(within(intro).getByRole('button', { name: message('tutorial.common.guide.employer.start') }));
        });
        // A new applicant: the first-message composer, then the delivery rule under the cards.
        await waitFor(() => expect(guideCard()?.getAttribute('data-step')).toBe('first'));
        act(() => {
            fireEvent.click(within(guideCard() as HTMLElement).getByRole('button', { name: message('tutorial.common.next') }));
        });
        await waitFor(() => expect(guideCard()?.getAttribute('data-step')).toBe('window'));
        act(() => {
            fireEvent.click(within(guideCard() as HTMLElement).getByRole('button', { name: message('tutorial.common.guide.end') }));
        });
        await settle();
        expect(guideCard()).toBeNull();
        expect(posts().map(([, , body]) => body)).toEqual([{ tutorial_id: 'employer_messages', outcome: 'skipped' }]);
        expect(dialogs.most()).toBe(1);
        dialogs.stop();
    });

    it('opens the thread at once for an employer who already has a conversation', async () => {
        polled.state = { loading: false, items: [neverMessaged, messaged] };
        vi.mocked(getInbox).mockResolvedValue(board([neverMessaged, messaged]));
        renderBoard();
        await waitFor(() => expect(rowFor('Test Worker')).toBeTruthy());
        await settle();

        act(() => {
            fireEvent.click(rowFor('Test Worker'));
        });
        expect(nothingPicked()).toBe(false);
        await settle();
        expect(tourDialog()).toBeNull();
        expect(posts()).toEqual([]);
    });

    it('opens the thread at once once the tour was finished or skipped before', async () => {
        serveTutorials([record('employer_messages', 'completed')]);
        renderBoard();
        await waitFor(() => expect(rowFor('Test Worker')).toBeTruthy());
        await settle();

        act(() => {
            fireEvent.click(rowFor('Test Worker'));
        });
        expect(nothingPicked()).toBe(false);
        await settle();
        expect(tourDialog()).toBeNull();
    });
});
