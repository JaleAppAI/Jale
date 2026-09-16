/**
 * The sidebar chip's reload cache.
 *
 * A hard reload has no id token until `/auth/refresh` answers, so the chip had
 * nothing to paint and fell back to a bare role letter for as long as that took.
 * The last good chip is mirrored here so the reload paints the name and trade
 * immediately and the refetch merely confirms them.
 *
 * `sessionStorage`, deliberately: this is a paint accelerator for the current
 * tab, not a profile store. It holds ONLY what the chip renders -- name, meta
 * line, initials -- and never a token or anything else about the account.
 *
 * The locale travels with the payload because the worker meta line is
 * TRANSLATED (`tradeLabel`), so a chip cached in English is not a valid seed
 * for a Spanish page; a mismatch reads as "nothing cached" rather than as a
 * stale English label the refetch would only replace a second later.
 */

import type { ShellRole } from '@/components/layout/nav-config';

const PREFIX = 'jale.sidebar_chip.';
const ROLES: readonly ShellRole[] = ['worker', 'employer'];

/** Exactly what the chip renders. Nothing else is ever written. */
export type StoredSidebarChip = {
    name: string | null;
    meta: string | null;
    initials: string;
};

type Payload = StoredSidebarChip & { locale: string };

function keyFor(role: ShellRole): string {
    return `${PREFIX}${role}`;
}

function isPayload(value: unknown): value is Payload {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Record<string, unknown>;
    return (
        typeof row.initials === 'string' &&
        typeof row.locale === 'string' &&
        (row.name === null || typeof row.name === 'string') &&
        (row.meta === null || typeof row.meta === 'string')
    );
}

/** The cached chip for `role` in `locale`, or null when there is not one to trust. */
export function readSidebarChip(role: ShellRole, locale: string): StoredSidebarChip | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.sessionStorage.getItem(keyFor(role));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isPayload(parsed) || parsed.locale !== locale) return null;
        return { name: parsed.name, meta: parsed.meta, initials: parsed.initials };
    } catch {
        // Storage disabled, or a payload from an older shape. Either way there
        // is no seed, which is a state the chip already handles.
        return null;
    }
}

export function writeSidebarChip(role: ShellRole, chip: StoredSidebarChip, locale: string): void {
    if (typeof window === 'undefined') return;
    try {
        const payload: Payload = { ...chip, locale };
        window.sessionStorage.setItem(keyFor(role), JSON.stringify(payload));
    } catch {
        // The seed just will not survive the next reload. Not worth a crash.
    }
}

/**
 * Drops every cached chip. Called from `AuthContext.clearSession`, so the name
 * of the account that just signed out cannot paint for the next one.
 */
export function clearSidebarChips(): void {
    if (typeof window === 'undefined') return;
    try {
        for (const role of ROLES) window.sessionStorage.removeItem(keyFor(role));
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
