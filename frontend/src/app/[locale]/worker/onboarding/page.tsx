'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { classifyError, type ErrorKind } from '@/lib/api/errors';
import { getWorkerOnboarding, type OnboardingState } from '@/lib/api/worker';
import { ErrorState } from '@/components/ui/error-state';
import { OnboardingFlow } from '@/components/worker/onboarding/OnboardingFlow';
import { OnboardingSkeleton } from '@/components/worker/onboarding/OnboardingSkeleton';

export const dynamic = 'force-dynamic';

/**
 * The web door onto worker onboarding.
 *
 * This page is deliberately thin — auth gate, one fetch, three states — and it
 * does that fetch by hand rather than through `usePageData`. The hook is the
 * right tool for every other authenticated page, but it carries the legal-wall
 * redirect, and the legal read is a STEP of this flow rather than a wall in
 * front of it: bouncing to `/legal/accept` from here would take a worker away
 * from the terms they are on their way to accepting. `apiFetch`'s 401 refresh,
 * the part that actually matters for a session that has been open a while,
 * applies to this call exactly as it does to any other.
 *
 * There is no `AppShell` either: the flow owns its own navy band and progress
 * rail, and the global `Header` already stands down for `/worker/*`.
 */
export default function WorkerOnboardingPage() {
    const { idToken, isLoading } = useAuth();
    useRequireAuth();

    const [state, setState] = useState<OnboardingState | null>(null);
    const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!idToken) return;
        const controller = new AbortController();
        setErrorKind(null);
        getWorkerOnboarding(idToken, controller.signal)
            .then((next) => {
                if (controller.signal.aborted) return;
                setState(next);
            })
            .catch((err) => {
                // An abort is this effect cleaning up after itself, not a
                // failure the worker should be shown.
                if (controller.signal.aborted) return;
                setErrorKind(classifyError(err).kind);
            });
        return () => controller.abort();
    }, [idToken, attempt]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);

    if (errorKind && !state) {
        return (
            <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
                <ErrorState kind={errorKind} onRetry={retry} />
            </main>
        );
    }

    // Still waiting on the auth gate or the first response: the skeleton is
    // byte-identical to `loading.tsx`, so the shell simply stays put.
    if (isLoading || !idToken || !state) return <OnboardingSkeleton />;

    return <OnboardingFlow token={idToken} initialState={state} />;
}
