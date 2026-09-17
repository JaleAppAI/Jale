/**
 * Where the billing banner's dismissals live.
 *
 * Split out of `SubscriptionBanner` because two other places have a stake in
 * it: the keys are ACCOUNT-scoped (see `lib/account-key`), and `AuthContext`
 * has to be able to drop all of them when a session ends.
 *
 * Which store a dismissal goes in depends on what the banner was saying:
 *
 *  - the LAPSED banners ("your payment failed", "your subscription ended") use
 *    SESSION storage, deliberately: a permanently dismissed payment warning is
 *    a support ticket. They come back next session.
 *  - the FREE-plan banner uses LOCAL storage. It states a standing fact about
 *    the account rather than a problem to act on, so re-showing it every
 *    session asked the same employer to dismiss the same sentence forever.
 *
 * Neither is ever written without an account id. A dismissal stored under a
 * bare `jale.signage.free.employer_free` is one browser's answer for every
 * account that ever signs in on it -- which is exactly how one employer's
 * dismissal hid the free-plan signage from the next.
 */

import { accountScopedKey } from '@/lib/account-key';

export type SignageVariant = 'free' | 'lapsed';

/** Every key this module writes starts here, so a sweep can find them all. */
const SIGNAGE_PREFIX = 'jale.signage.';

function storeFor(variant: SignageVariant): Storage {
    return variant === 'free' ? window.localStorage : window.sessionStorage;
}

/**
 * True only when THIS account dismissed THIS banner. Unknown account, unknown
 * storage and a storage that throws all read as "not dismissed", which shows
 * the banner -- the safe side of a question about someone's billing.
 */
export function readSignageDismissed(
    dismissKey: string,
    variant: SignageVariant,
    account: string | null,
): boolean {
    if (account === null || typeof window === 'undefined') return false;
    try {
        return storeFor(variant).getItem(accountScopedKey(dismissKey, account)) === '1';
    } catch {
        // Private mode / storage disabled -- show the banner rather than crash.
        return false;
    }
}

export function writeSignageDismissed(
    dismissKey: string,
    variant: SignageVariant,
    account: string | null,
): void {
    if (account === null || typeof window === 'undefined') return;
    try {
        storeFor(variant).setItem(accountScopedKey(dismissKey, account), '1');
    } catch {
        // Dismissal just does not survive the next page load. Not worth a crash.
    }
}

/**
 * Drops every signage dismissal this browser is holding, for every account.
 *
 * Called from `AuthContext.clearSession`. Unscoped on purpose: sign-out is the
 * one moment we can be sure the person is done, and leaving a stale dismissal
 * behind is how a billing warning stops being shown to someone who needs it.
 */
export function clearSignageDismissals(): void {
    if (typeof window === 'undefined') return;
    for (const store of [window.localStorage, window.sessionStorage]) {
        try {
            const doomed: string[] = [];
            for (let i = 0; i < store.length; i += 1) {
                const key = store.key(i);
                if (key !== null && key.startsWith(SIGNAGE_PREFIX)) doomed.push(key);
            }
            // Collected first: removing during the walk reindexes the store.
            for (const key of doomed) store.removeItem(key);
        } catch {
            // Nothing to clear if storage is unavailable.
        }
    }
}
