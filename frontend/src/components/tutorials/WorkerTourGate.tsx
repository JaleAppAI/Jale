'use client';

import { useEffect, useState } from 'react';
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
 *  - the address bar no longer carries `?apply=1`: the onboarding summary's
 *    Apply lands on the job page with it, and the page opens the apply flow
 *    from it once the job has loaded. From then on the flow (and the profile
 *    gate in front of it) count as overlays, so the tour waits until the
 *    worker leaves them.
 *
 * It checks again whenever an overlay opens or closes (the registry's
 * `subscribe`), the page changes, or the progress store moves on. The marker
 * is cleared once the tour has shown and gone (or had nothing to show); a
 * play the store turned down at its last check leaves it for the next check.
 *
 * Without the providers (a tree mounted on its own) it does nothing.
 */

const WORKER_TOUR = 'worker_app_tour' as const;

const ONBOARDING = new RegExp(`^(/(${locales.join('|')}))?/worker/onboarding(/|$)`);

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

    useEffect(() => {
        if (progress === null || account === null) return;
        if (progress.role !== 'worker' || ONBOARDING.test(pathname ?? '')) return;
        if (!isWorkerTourDue(account)) return;
        if (!mayAutoPlayTour(progress, WORKER_TOUR) || applyArrivalPending()) return;
        let refused = false;
        progress.play({
            id: WORKER_TOUR,
            mode: 'auto',
            source,
            onRefused: () => {
                refused = true;
            },
            then: () => {
                if (!refused) clearWorkerTourDue(account);
            },
        });
    }, [progress, account, pathname, wake, source]);

    return null;
}
