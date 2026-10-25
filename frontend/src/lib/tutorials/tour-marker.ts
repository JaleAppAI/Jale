/**
 * "The worker app tour is due": set when a worker finishes onboarding, read
 * by `WorkerTourGate`, which plays the tour at the first worker page where it
 * can and then clears it.
 *
 * Kept like the failed-save flags in `./storage`:
 *  - SESSION storage: the tour is due for this visit, right after onboarding,
 *    not for every later sign-in on this browser;
 *  - the key is ACCOUNT-scoped (`lib/account-key`), so the next person on the
 *    same phone is never shown someone else's tour; with no account nothing is
 *    read or written;
 *  - every access is wrapped, because storage throws outright in some privacy
 *    modes. Without storage the tour simply does not auto-play, and Help can
 *    still replay it.
 */

import { accountScopedKey } from '@/lib/account-key';

const KEY = 'jale.worker_tour_due';

function store(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

export function markWorkerTourDue(account: string | null): void {
    if (account === null) return;
    try {
        store()?.setItem(accountScopedKey(KEY, account), '1');
    } catch {
        // No storage: the tour is not auto-played this time.
    }
}

/** True only when THIS account finished onboarding earlier in this browser session and has not had the tour yet. */
export function isWorkerTourDue(account: string | null): boolean {
    if (account === null) return false;
    try {
        return store()?.getItem(accountScopedKey(KEY, account)) === '1';
    } catch {
        return false;
    }
}

export function clearWorkerTourDue(account: string | null): void {
    if (account === null) return;
    try {
        store()?.removeItem(accountScopedKey(KEY, account));
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
