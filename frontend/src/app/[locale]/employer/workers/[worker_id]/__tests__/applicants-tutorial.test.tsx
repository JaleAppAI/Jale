// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

import type { InboxItem, WorkerProfile } from '@/lib/api/employer';

/*
 * E3 (sprint 29), second host: opening an applicant asks for the applicants
 * tutorial too, judged by this application's status and the inbox (K1.5). The
 * real tutorial lands with the framework; here the hook is a recording handle.
 */

const tutorial = vi.hoisted(() => {
    const latestDone: Record<string, boolean | undefined> = {};
    const walkthrough: Record<string, boolean | undefined> = {};
    const ids = new Set<string>();
    const handle = { maybeAutoOpen: vi.fn(), runBeforeHost: vi.fn((openHost: () => void) => openHost()), runWithHost: vi.fn(), replay: vi.fn() };
    return { latestDone, walkthrough, ids, handle };
});
vi.mock('@/lib/tutorials/use-tutorial', () => ({
    useTutorial: (id: string, options: { done: boolean | undefined; walkthrough?: boolean }) => {
        tutorial.ids.add(id);
        tutorial.latestDone[id] = options.done;
        tutorial.walkthrough[id] = options.walkthrough;
        return tutorial.handle;
    },
}));

const WORKER_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = '00000000-0000-4000-8000-000000000002';

vi.mock('next/navigation', () => ({
    useParams: () => ({ worker_id: WORKER_ID }),
    useSearchParams: () => new URLSearchParams(`job_id=${JOB_ID}`),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

const auth = { idToken: 'test-token' };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const requireAuth = {
    handleLegalWall: (err: unknown) => {
        throw err;
    },
};
vi.mock('@/hooks/useRequireAuth', () => ({ useRequireAuth: () => requireAuth }));

vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/AppShellSkeleton', () => ({
    AppShellSkeleton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../DocumentSlots', () => ({ DocumentSlots: () => null }));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({ MediaBoardGrid: () => null }));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));

/** The session-wide inbox, driven from the test. */
const inbox = vi.hoisted(() => {
    let state: { loading: boolean; errorKind: string | null; items: unknown[] } = { loading: true, errorKind: null, items: [] };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const inboxActions = { retry: vi.fn(), refresh: vi.fn(), markRead: vi.fn() };
vi.mock('@/contexts/UnreadMessagesContext', async () => {
    const react = await import('react');
    return {
        useUnreadMessages: () => {
            const state = react.useSyncExternalStore(inbox.subscribe, inbox.get, inbox.get);
            return { ...state, unreadCount: 0, unreadByConversation: {}, ...inboxActions };
        },
        useUnreadCount: () => 0,
    };
});

/** The page's own load, driven from the test. */
const page = vi.hoisted(() => {
    let state: { phase: 'loading' | 'ready'; data: unknown } = { phase: 'loading', data: null };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set(next: typeof state) {
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const noop = vi.fn();
vi.mock('@/hooks/usePageData', async () => {
    const react = await import('react');
    return {
        usePageData: () => {
            const state = react.useSyncExternalStore(page.subscribe, page.get, page.get);
            return {
                phase: state.phase,
                data: state.data,
                empty: false,
                errorKind: null,
                refreshing: false,
                refreshError: null,
                retry: noop,
                refresh: noop,
                setData: noop,
            };
        },
    };
});

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import EmployerWorkerPage from '../page';

function profile(application_status: WorkerProfile['application_status']): WorkerProfile {
    return {
        worker_id: WORKER_ID,
        full_name: 'Test Worker',
        phone: null,
        skills: [],
        availability: null,
        years_experience: null,
        experience_months: null,
        certifications: [],
        location: null,
        city: null,
        main_trade: null,
        main_trade_other: null,
        has_transportation: null,
        application_status,
        applied_at: '2026-08-28T00:00:00.000Z',
        trust_assessment: null,
        trust_extraction: null,
    } as unknown as WorkerProfile;
}

const ready = (status: WorkerProfile['application_status']) =>
    page.set({ phase: 'ready', data: { profile: profile(status), documents: [], posts: [] } });

const inboxRow = (application_status: InboxItem['application_status']) =>
    ({ application_id: 'app-other', application_status, conversation_id: null }) as unknown as InboxItem;

beforeEach(() => {
    vi.clearAllMocks();
    for (const id of Object.keys(tutorial.latestDone)) delete tutorial.latestDone[id];
    tutorial.ids.clear();
    page.set({ phase: 'loading', data: null });
    inbox.set({ loading: true, errorKind: null, items: [] });
});

describe('applicant profile: the applicants tutorial', () => {
    it('waits for the profile and the inbox, then asks once', () => {
        renderIntl(<EmployerWorkerPage />);
        expect(tutorial.ids.has('employer_applicants')).toBe(true);
        expect(tutorial.latestDone.employer_applicants).toBeUndefined();

        act(() => ready('pending'));
        expect(tutorial.latestDone.employer_applicants).toBeUndefined();
        expect(tutorial.handle.maybeAutoOpen).not.toHaveBeenCalled();

        act(() => inbox.set({ loading: false, errorKind: null, items: [inboxRow('contacted')] }));
        expect(tutorial.latestDone.employer_applicants).toBe(false);
        expect(tutorial.handle.maybeAutoOpen).toHaveBeenCalledTimes(1);
    });

    it('passes done true when this application is past applied, once both sources are in', () => {
        renderIntl(<EmployerWorkerPage />);
        act(() => ready('not_interested'));
        expect(tutorial.latestDone.employer_applicants).toBeUndefined();

        act(() => inbox.set({ loading: false, errorKind: null, items: [] }));
        expect(tutorial.latestDone.employer_applicants).toBe(true);
    });

    it('passes done true when the inbox shows a details request elsewhere', () => {
        renderIntl(<EmployerWorkerPage />);
        act(() => {
            ready('talking');
            inbox.set({ loading: false, errorKind: null, items: [inboxRow('details_requested')] });
        });

        expect(tutorial.latestDone.employer_applicants).toBe(true);
    });
});

describe('applicant profile: the applicants guide’s places', () => {
    const mark = (name: string) => document.querySelector<HTMLElement>(`[data-guide="${name}"]`);

    it('asks for the step-by-step guide, and marks the status with its saved value, Request details and the documents', () => {
        renderIntl(<EmployerWorkerPage />);
        act(() => {
            ready('pending');
            inbox.set({ loading: false, errorKind: null, items: [] });
        });

        expect(tutorial.walkthrough.employer_applicants).toBe(true);
        expect(mark('apps.profile_status')?.getAttribute('data-status')).toBe('pending');
        expect(mark('apps.profile_request')).not.toBeNull();
        expect(mark('apps.profile_docs')).not.toBeNull();
    });

    it('says hired on the status mark once hired, with no Request details', () => {
        renderIntl(<EmployerWorkerPage />);
        act(() => {
            ready('hired');
            inbox.set({ loading: false, errorKind: null, items: [] });
        });

        expect(mark('apps.profile_status')?.getAttribute('data-status')).toBe('hired');
        expect(mark('apps.profile_request')).toBeNull();
    });
});
