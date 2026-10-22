/**
 * Where the "this tutorial's outcome did not save" flag lives (K1.4).
 *
 * When recording a dismissed tutorial fails, the tutorial must not re-open in
 * this browser session, and the save is not retried in a loop. The next
 * session reads the server again and may show it once more, which K1 accepts.
 *
 * Modelled on `lib/signage-storage.ts`:
 *  - SESSION storage, because the flag is meant to end with the browser
 *    session;
 *  - every key is ACCOUNT-scoped (`lib/account-key`), so one person's failed
 *    save never hides a tutorial from the next person on the same phone;
 *  - with no account, nothing is read or written: an unscoped key would be
 *    exactly that leak;
 *  - every access is wrapped, because storage throws outright in some privacy
 *    modes. The progress provider keeps its own in-memory copy too, so the
 *    rule holds even when storage is unavailable.
 *
 * Not `lib/session-storage.ts`: that module is the auth session store.
 */

import { accountScopedKey } from '@/lib/account-key';
import type { TutorialId, TutorialRole } from '@/lib/api/tutorials';

/** Every key this module writes starts here, so a sweep can find them all. */
const PREFIX = 'jale.tutorial_record_failed.';

function store(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

/** True only when THIS account's save of THIS tutorial failed earlier in the session. */
export function readRecordFailed(id: TutorialId, account: string | null): boolean {
    if (account === null) return false;
    try {
        return store()?.getItem(accountScopedKey(`${PREFIX}${id}`, account)) === '1';
    } catch {
        return false;
    }
}

export function writeRecordFailed(id: TutorialId, account: string | null): void {
    if (account === null) return;
    try {
        store()?.setItem(accountScopedKey(`${PREFIX}${id}`, account), '1');
    } catch {
        // The provider's in-memory copy still holds for this page's lifetime.
    }
}

/**
 * Drops the flags of one role's tutorials (every account), or of both roles.
 * Called when a session ends: the flag answered that session's failed save,
 * and the next sign-in reads the server again.
 */
export function clearRecordFailed(role?: TutorialRole): void {
    const storage = store();
    if (!storage) return;
    const prefix = role ? `${PREFIX}${role}_` : PREFIX;
    try {
        const doomed: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key !== null && key.startsWith(prefix)) doomed.push(key);
        }
        // Collected first: removing during the walk reindexes the store.
        for (const key of doomed) storage.removeItem(key);
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
