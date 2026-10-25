'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePathname } from '@/i18n/navigation';
import { locales } from '@/i18n/locales';
import { accountKeyFromIdToken } from '@/lib/account-key';
import { useOverlayRegistry } from '@/lib/tutorials/overlay';
import { useTutorialProgress } from '@/lib/tutorials/progress';
import { clearWorkerTourDue, isWorkerTourDue } from '@/lib/tutorials/tour-marker';
import { mayAutoPlayTour } from '@/lib/tutorials/use-app-tour';

/**
 * Plays the worker app tour once, right after onboarding (K1-v2).
 *
 * Onboarding's `finish()` leaves an account-scoped marker (`tour-marker`).
 * This gate, mounted once in the app layout inside the progress provider,
 * plays the tour at the first worker shell page view where:
 *  - the marker is there for the signed-in account;
 *  - the tour may auto-open (`mayAutoPlayTour`: progress read for the worker
 *    role, no outcome yet, no failed-save flag, nothing playing, no overlay);
 *  - the page is not onboarding itself (it has a Help button, but no tabs);
 *  - the shell is really on screen: a rendered Help button and a rendered
 *    nav link. The route's loading skeleton draws the nav but not Help, and a
 *    tour started over it would lose its Help step. Nothing announces the
 *    swap, so while everything else holds the gate looks again every 250 ms,
 *    for up to 10 s per page;
 *  - the address bar no longer carries `?apply=1`: the onboarding summary's
 *    Apply lands on the job page with it, and the page opens the apply flow
 *    from it once the job has loaded. From then on the flow (and the profile
 *    gate in front of it) count as overlays, so the tour waits until the
 *    worker leaves them.
 *
 * It checks again whenever an overlay opens or closes (the registry's
 * `subscribe`), the page changes, or the progress store moves on. The marker
 * is cleared once the account has an outcome for the tour (or a failed save
 * of one), so a play that was turned down, or found nothing to show, leaves
 * it for the next check.
 *
 * Without the providers (a tree mounted on its own) it does nothing.
 */

const WORKER_TOUR = 'worker_app_tour' as const;

const ONBOARDING = new RegExp(`^(/(${locales.join('|')}))?/worker/onboarding(/|$)`);

/** How often, and how many times per page, the gate looks for the shell to be up. */
const READY_INTERVAL_MS = 250;
const READY_CHECKS = 40;

function renderedIn(selector: string): boolean {
    return Array.from(document.querySelectorAll(selector)).some((element) => element.getClientRects().length > 0);
}

/** The worker shell is on screen: its Help button and its navigation, not a loading skeleton. */
function shellReady(): boolean {
    return renderedIn('[data-tour="help"]') && renderedIn('[data-nav-key]');
}

/** True while the address bar still asks the job page to open its apply flow. */
function applyArrivalPending(): boolean {
    try {
        return new URLSearchParams(window.location.search).get('apply') === '1';
    } catch {
        return false;
    }
}

export function WorkerTourGate() {
    const progress = useTutorialProgress();
    const overlays = useOverlayRegistry();
    const { idToken } = useAuth();
    const account = accountKeyFromIdToken(idToken);
    const pathname = usePathname();
    const [source] = useState(() => ({}));

    // Bumped when an overlay opens or closes. The registry tells listeners
    // from the layout phase, before every overlay of that commit has
    // registered, so the decision waits for this component's own effect.
    const [wake, setWake] = useState(0);
    useEffect(() => {
        if (!overlays) return;
        return overlays.subscribe(() => setWake((count) => count + 1));
    }, [overlays]);

    const readyChecks = useRef({ path: '', count: 0 });

    useEffect(() => {
        if (progress === null || account === null) return;
        if (progress.role !== 'worker' || progress.status !== 'ready') return;
        if (!isWorkerTourDue(account)) return;
        // The tour has an outcome (or a failed save of one): it is done.
        if (progress.hasRecord(WORKER_TOUR) || progress.isFlagged(WORKER_TOUR)) {
            clearWorkerTourDue(account);
            return;
        }
        if (ONBOARDING.test(pathname ?? '')) return;
        if (!mayAutoPlayTour(progress, WORKER_TOUR) || applyArrivalPending()) return;
        if (!shellReady()) {
            const checks = readyChecks.current;
            if (checks.path !== pathname) {
                checks.path = pathname ?? '';
                checks.count = 0;
            }
            if (checks.count >= READY_CHECKS) return;
            checks.count += 1;
            const timer = window.setTimeout(() => setWake((count) => count + 1), READY_INTERVAL_MS);
            return () => window.clearTimeout(timer);
        }
        progress.play({ id: WORKER_TOUR, mode: 'auto', source });
    }, [progress, account, pathname, wake, source]);

    return null;
}
