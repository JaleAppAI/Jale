import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { TutorialRecord, TutorialRole } from '@/lib/api/tutorials';

/**
 * Shared state for the tutorial framework suites. Not a `.test.` file, so
 * vitest collects it as a helper rather than a suite.
 *
 * Each suite mocks `@/contexts/AuthContext`, `@/i18n/navigation` and
 * `@/lib/api` itself (mocks are hoisted per file) and points the factories at
 * the mutable objects below:
 *
 *   vi.mock('@/contexts/AuthContext', async () => ({ useAuth: (await import('./harness')).useAuthMock }));
 *
 * Fixtures only: fake account ids built at runtime, sample names.
 */

type AuthMockState = {
    idToken: string | null;
    userType: TutorialRole | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    sessionCleared: { epoch: number; role: TutorialRole | null };
    logout: () => Promise<void>;
};

export const auth: { state: AuthMockState } = {
    state: signedOutState(),
};

export const route = { path: '/employer/dashboard' };

/** Every request the code under test makes goes through this. */
export const apiFetch = vi.fn();

export function useAuthMock(): AuthMockState {
    return auth.state;
}

export function usePathnameMock(): string {
    return route.path;
}

function signedOutState(): AuthMockState {
    return {
        idToken: null,
        userType: null,
        isAuthenticated: false,
        isLoading: false,
        sessionCleared: { epoch: 0, role: null },
        logout: async () => {},
    };
}

function base64Url(text: string): string {
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token-shaped string whose payload names `account`. Never a real token. */
export function fakeIdToken(account: string, issue = 1): string {
    return `${base64Url(JSON.stringify({ alg: 'none' }))}.${base64Url(JSON.stringify({ sub: account, n: issue }))}.sig`;
}

export function signIn(role: TutorialRole, account = 'account-one', issue = 1) {
    auth.state = {
        ...auth.state,
        idToken: fakeIdToken(account, issue),
        userType: role,
        isAuthenticated: true,
        isLoading: false,
    };
}

export function signOut() {
    auth.state = { ...signedOutState(), sessionCleared: auth.state.sessionCleared };
}

/** The provider's "a session ended" announcement, as AuthContext makes it. */
export function clearSession(role: TutorialRole | null) {
    auth.state = {
        ...signedOutState(),
        sessionCleared: { epoch: auth.state.sessionCleared.epoch + 1, role },
    };
}

export function resetHarness() {
    auth.state = signedOutState();
    route.path = '/employer/dashboard';
    apiFetch.mockReset();
}

export function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function record(id: TutorialRecord['tutorial_id'], outcome: TutorialRecord['outcome'] = 'completed'): TutorialRecord {
    return { tutorial_id: id, outcome, recorded_at: '2026-10-01T15:00:00.000Z' };
}

/**
 * Answers GET with `records` (or the given failure) and POST with the record
 * it was sent, the way the backend's first-write-wins answer looks.
 */
export function serveTutorials(
    records: TutorialRecord[] | { status: number; body?: unknown },
    post: { status: number; body?: unknown } | 'echo' = 'echo',
) {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
        if (!/\/(employer|worker)\/tutorials$/.test(path)) return jsonResponse(404, { error: 'not_found' });
        if (init?.method === 'POST') {
            if (post !== 'echo') return jsonResponse(post.status, post.body ?? {});
            const sent = JSON.parse(String(init.body)) as Pick<TutorialRecord, 'tutorial_id' | 'outcome'>;
            return jsonResponse(200, { tutorial: { ...sent, recorded_at: '2026-10-22T18:00:00.000Z' } });
        }
        if (Array.isArray(records)) return jsonResponse(200, { tutorials: records });
        return jsonResponse(records.status, records.body ?? {});
    });
}

/** The tutorial calls made so far, as `[method, path, body]`. */
export function tutorialCalls(): Array<[string, string, unknown]> {
    return apiFetch.mock.calls
        .filter(([path]) => typeof path === 'string' && path.includes('/tutorials'))
        .map(([path, init]) => [
            (init as RequestInit | undefined)?.method ?? 'GET',
            path as string,
            (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
        ]);
}

/** The id token each tutorial call was sent with. */
export function tutorialTokens(): unknown[] {
    return apiFetch.mock.calls.filter(([path]) => String(path).includes('/tutorials')).map((call) => call[2]);
}

export const catalogues = { en, es } as const;

export function intlWrapper(locale: 'en' | 'es' = 'en', extra: Record<string, unknown> = {}) {
    const messages = { ...catalogues[locale], ...extra };
    return function IntlWrapper({ children }: { children: ReactNode }) {
        return (
            <NextIntlClientProvider locale={locale} messages={messages} onError={() => {}}>
                {children}
            </NextIntlClientProvider>
        );
    };
}

export function renderWithIntl(ui: ReactElement, locale: 'en' | 'es' = 'en', extra: Record<string, unknown> = {}) {
    return render(ui, { wrapper: intlWrapper(locale, extra) });
}

/** Whether `dialog` sits inside another dialog, looking no further up than `within`. */
function nestedIn(dialog: Element, within: Element): boolean {
    for (let parent = dialog.parentElement; parent && within.contains(parent); parent = parent.parentElement) {
        if (parent.matches('[role="dialog"]')) return true;
    }
    return false;
}

/**
 * The TOP-LEVEL dialogs a change added or removed under `parent`: a dialog
 * drawn inside another (a step-by-step guide's callout inside the wizard it
 * guides) is part of that one dialog on screen, not a second one stacked.
 */
function dialogsIn(node: Node, parent: Node | null): number {
    if (!(node instanceof Element)) return 0;
    if (parent instanceof Element && parent.closest('[role="dialog"]')) return 0;
    const found = [...(node.matches('[role="dialog"]') ? [node] : []), ...Array.from(node.querySelectorAll('[role="dialog"]'))];
    return found.filter((dialog) => !nestedIn(dialog, node)).length;
}

export function watchDialogs() {
    let count = document.querySelectorAll('[role="dialog"]').length;
    let most = count;
    const observer = new MutationObserver((records) => {
        for (const change of records) {
            change.removedNodes.forEach((node) => {
                count -= dialogsIn(node, change.target);
            });
            change.addedNodes.forEach((node) => {
                count += dialogsIn(node, change.target);
                most = Math.max(most, count);
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return {
        most: () => {
            for (const change of observer.takeRecords()) {
                change.removedNodes.forEach((node) => {
                    count -= dialogsIn(node, change.target);
                });
                change.addedNodes.forEach((node) => {
                    count += dialogsIn(node, change.target);
                    most = Math.max(most, count);
                });
            }
            return most;
        },
        stop: () => observer.disconnect(),
    };
}
