// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

/*
 * The worker's "needs your attention" summary, owned once for the session.
 * Modelled on the unread-messages suite: one request however many consumers
 * mount, one poll cadence, and a failed first read that is tried again.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    usePathname: () => '/worker/home',
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

let authState: { idToken: string | null; isAuthenticated: boolean; userType: 'employer' | 'worker' | null } = {
    idToken: 'test-token',
    isAuthenticated: true,
    userType: 'worker',
};
vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => authState,
}));

// `usePageData`'s auth gate, resolved (same stub as the unread-messages suite).
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
        idToken: authState.idToken,
        isAuthenticated: authState.isAuthenticated,
        isLoading: false,
    }),
}));

const getApplicationsAttention = vi.fn();
vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getApplicationsAttention: (...args: unknown[]) => getApplicationsAttention(...args),
}));

// Below the mocks on purpose (they hoist).
import {
    ATTENTION_POLL_MS,
    ATTENTION_RETRY_MS,
    WorkerAttentionProvider,
    useWorkerAttention,
    useWorkerAttentionCount,
} from '@/contexts/WorkerAttentionContext';
import type { ApplicationsAttention } from '@/lib/api/worker';
import { ApiError } from '@/lib/api/errors';

const SUMMARY: ApplicationsAttention = {
    details_requested: [
        { application_id: 'a1', job_id: 'j1', job_title: 'Roofer', company_name: 'Acme', remaining_count: 2 },
        { application_id: 'a2', job_id: 'j2', job_title: 'Framer', company_name: 'Acme', remaining_count: 1 },
    ],
    unacknowledged_hires: [{
        application_id: 'a3', job_id: 'j3', job_title: 'Welder', company_name: 'Acme',
        hire: {
            hired_at: '2026-09-03T18:00:00.000Z', seen_at: null, acknowledged_at: null, start_date: null,
            location: null, shift_schedule: null, pay: null, pay_min: null, pay_max: null, pay_interval: null,
            details: null,
            employer_reminded_at: null,
        },
    }],
};

function Probe() {
    const { count, loading, errorKind, forgetHire } = useWorkerAttention();
    return (
        <div>
            <span data-testid="count">{loading ? 'loading' : `${count}:${errorKind ?? 'ok'}`}</span>
            <button type="button" onClick={() => forgetHire('a3')}>forget</button>
        </div>
    );
}

function renderProvider(children: ReactNode) {
    return render(<WorkerAttentionProvider>{children}</WorkerAttentionProvider>);
}

beforeEach(() => {
    authState = { idToken: 'test-token', isAuthenticated: true, userType: 'worker' };
    getApplicationsAttention.mockReset();
    getApplicationsAttention.mockResolvedValue(SUMMARY);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('WorkerAttentionProvider', () => {
    it('counts details requests plus unacknowledged hires', async () => {
        renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3:ok'));
    });

    it('reads once for every consumer', async () => {
        renderProvider(
            <>
                <Probe />
                <Probe />
            </>,
        );

        await waitFor(() => expect(screen.getAllByTestId('count')[0].textContent).toBe('3:ok'));
        expect(getApplicationsAttention).toHaveBeenCalledTimes(1);
    });

    it('asks nothing for an employer or a visitor', async () => {
        authState = { idToken: 'employer-token', isAuthenticated: true, userType: 'employer' };
        const { unmount } = renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0:ok'));
        expect(getApplicationsAttention).not.toHaveBeenCalled();
        unmount();

        authState = { idToken: null, isAuthenticated: false, userType: null };
        renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0:ok'));
        expect(getApplicationsAttention).not.toHaveBeenCalled();
    });

    it('polls on the attention cadence', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        renderProvider(<Probe />);
        await waitFor(() => expect(getApplicationsAttention).toHaveBeenCalledTimes(1));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ATTENTION_POLL_MS);
        });

        expect(getApplicationsAttention).toHaveBeenCalledTimes(2);
    });

    it('retries a failed first read after ATTENTION_RETRY_MS', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        getApplicationsAttention.mockRejectedValueOnce(new ApiError(500, 'internal'));
        renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0:server'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(ATTENTION_RETRY_MS);
        });

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3:ok'));
        expect(getApplicationsAttention).toHaveBeenCalledTimes(2);
    });

    it('treats a load it aborted itself as no failure', async () => {
        getApplicationsAttention.mockImplementation(
            (_token: string, signal: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
        );
        const first = renderProvider(<Probe />);
        await waitFor(() => expect(getApplicationsAttention).toHaveBeenCalledTimes(1));
        first.unmount();

        getApplicationsAttention.mockReset();
        getApplicationsAttention.mockResolvedValue(SUMMARY);
        renderProvider(<Probe />);

        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3:ok'));
    });

    it('drops a dismissed hire from the count at once', async () => {
        renderProvider(<Probe />);
        await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3:ok'));

        fireEvent.click(screen.getByRole('button', { name: 'forget' }));

        expect(screen.getByTestId('count').textContent).toBe('2:ok');
    });
});

describe('outside the provider', () => {
    it('answers 0 for the count and throws for the full hook', () => {
        const { result } = renderHook(() => useWorkerAttentionCount());
        expect(result.current).toBe(0);

        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => renderHook(() => useWorkerAttention())).toThrow();
        quiet.mockRestore();
    });
});
