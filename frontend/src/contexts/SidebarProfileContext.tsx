'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/contexts/AuthContext';
import { apiFetch } from '@/lib/api';
import { getEmployerProfile } from '@/lib/api/employer';
import type { WorkerProfileData } from '@/lib/api/worker';
import { getInitials, type ShellRole } from '@/components/layout/nav-config';
import type { SidebarChip } from '@/components/layout/Sidebar';
import {
    clearSidebarChips,
    readSidebarChip,
    writeSidebarChip,
    type StoredSidebarChip,
} from '@/lib/sidebar-chip-storage';
import { tradeLabel } from '@/lib/trades';

/**
 * Who the signed-in account is, as the sidebar chip renders it -- owned ONCE
 * for the whole session instead of once per page.
 *
 * Every worker/employer page mounts its own `AppShell`, and the chip's fetch
 * used to live inside it. So every navigation and every reload threw the
 * resolved profile away and started again from `loading`, which the chip drew
 * as a bare role letter: the "W" emblem bug. The fetch belongs to the session,
 * not to the page, so it lives here, above the router.
 *
 * What this owns, in order of how visible it is:
 *  - a per-role cache that SURVIVES route changes, so a second `AppShell` mount
 *    on the same key re-renders from memory and issues no request at all;
 *  - a silent background revalidation when the key changes (a refreshed id
 *    token, or a language switch, which changes the translated meta line);
 *  - a failure path that KEEPS the last good chip and only reports `failed`
 *    when there is nothing cached to keep -- a flaky profile call must not
 *    blank a name the employer is looking at;
 *  - a `sessionStorage` mirror (`lib/sidebar-chip-storage`) so a hard reload
 *    paints the name and trade before `/auth/refresh` has even answered.
 *
 * `useLayoutEffect` for that seed, not `useState`: these shells are
 * server-rendered, and reading storage in an initializer would disagree with
 * the server's markup. Seeding in a layout effect runs after hydration commits
 * and before the browser paints, so there is no mismatch and no flash either.
 */

/** The cache key: the same token AND the same locale means the same chip. */
function cacheKey(idToken: string, locale: string): string {
    return `${idToken}|${locale}`;
}

type RoleEntry = {
    /** The last chip that actually loaded, kept across failures. */
    profile: StoredSidebarChip | null;
    /** True when the most recent attempt failed. Only visible with no profile. */
    failed: boolean;
};

type SidebarProfileValue = {
    chipFor: (role: ShellRole) => SidebarChip;
    /** Ensures a load for `role` is done or in flight on the current key. */
    request: (role: ShellRole) => void;
};

const SidebarProfileContext = createContext<SidebarProfileValue | null>(null);

/**
 * Joins the parts of the chip's second line, dropping the ones the profile does
 * not have. Returns `null` — not `''` — when nothing survives, so the caller
 * cannot accidentally treat "no second line" as "a second line to fill in".
 *
 * Moved verbatim out of `AppShell` with the rest of this fetch.
 */
function joinMeta(parts: Array<string | null | undefined>): string | null {
    const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
    return kept.length > 0 ? kept.join(' · ') : null;
}

type Translate = ReturnType<typeof useTranslations>;

/** The profile read, per role. Rejects on anything that is not a real answer. */
async function loadChip(
    role: ShellRole,
    token: string,
    signal: AbortSignal,
    tCommon: Translate,
): Promise<StoredSidebarChip> {
    if (role === 'employer') {
        const profile = await getEmployerProfile(token, signal);
        const name = profile.company_name?.trim() || profile.full_name?.trim() || null;
        return {
            name,
            meta: joinMeta([profile.city, profile.service_area]),
            initials: getInitials(name ?? '', 'E'),
        };
    }
    const res = await apiFetch('/worker/profile', { signal }, token);
    // A non-OK response is a failed load, not an empty profile.
    if (!res.ok) throw new Error('worker_profile_unavailable');
    const profile = (await res.json()) as WorkerProfileData;
    const name = profile.full_name?.trim() || null;
    return {
        name,
        // `city` is the precise field; `location` is the older free-text one
        // kept as a fallback for profiles that predate it.
        meta: joinMeta([
            profile.main_trade
                ? tradeLabel(tCommon, profile.main_trade, profile.main_trade_other)
                : null,
            profile.city ?? profile.location,
        ]),
        initials: getInitials(name ?? '', 'W'),
    };
}

const ROLES: readonly ShellRole[] = ['worker', 'employer'];

/**
 * `useLayoutEffect` client-side, `useEffect` on the server pass. React warns
 * about the former during server rendering, and these shells DO render on the
 * server; the seed itself only ever has work to do in a browser.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function SidebarProfileProvider({ children }: { children: ReactNode }) {
    const { idToken, isAuthenticated, isLoading } = useAuth();
    const tCommon = useTranslations('common');
    const locale = useLocale();

    const [entries, setEntries] = useState<Partial<Record<ShellRole, RoleEntry>>>({});
    /** The key each role has already been requested on. The dedupe. */
    const requestedRef = useRef<Partial<Record<ShellRole, string>>>({});
    /** In-flight reads, so a superseded one is cancelled rather than merely ignored. */
    const abortRef = useRef<Partial<Record<ShellRole, AbortController>>>({});

    // The reload seed. `{ ...seeded, ...prev }` so a chip that has already
    // loaded in this session always wins over the stored copy of it.
    useIsomorphicLayoutEffect(() => {
        const seeded: Partial<Record<ShellRole, RoleEntry>> = {};
        for (const role of ROLES) {
            const stored = readSidebarChip(role, locale);
            if (stored) seeded[role] = { profile: stored, failed: false };
        }
        if (Object.keys(seeded).length === 0) return;
        setEntries((prev) => ({ ...seeded, ...prev }));
    }, [locale]);

    const request = useCallback(
        (role: ShellRole) => {
            if (!idToken) return;
            const key = cacheKey(idToken, locale);
            // Already loaded, or already loading, on exactly this key.
            if (requestedRef.current[role] === key) return;
            requestedRef.current[role] = key;

            abortRef.current[role]?.abort();
            const controller = new AbortController();
            abortRef.current[role] = controller;

            loadChip(role, idToken, controller.signal, tCommon).then(
                (profile) => {
                    // A response for a superseded key is not an answer about
                    // the account this provider is now describing.
                    if (requestedRef.current[role] !== key) return;
                    setEntries((prev) => ({ ...prev, [role]: { profile, failed: false } }));
                    writeSidebarChip(role, profile, locale);
                },
                () => {
                    if (requestedRef.current[role] !== key) return;
                    // The last good chip stays. `failed` is only ever SEEN when
                    // there is nothing cached behind it.
                    setEntries((prev) => ({
                        ...prev,
                        [role]: { profile: prev[role]?.profile ?? null, failed: true },
                    }));
                },
            );
        },
        [idToken, locale, tCommon],
    );

    // Signing out drops the cache with the session. The storage side is cleared
    // by `AuthContext.clearSession` (synchronously, so `logout`'s navigation
    // cannot race it); this is the in-memory half, for the same event.
    //
    // `!isLoading` is what tells a sign-out apart from a ROLE SWITCH. While the
    // session is being re-read for the other role (worker page -> employer
    // page in a browser signed in as both), AuthContext masks the tokens and
    // reports `isAuthenticated: false` with `isLoading: true`. That is not the
    // session ending -- both roles are still signed in -- and wiping the seed
    // here would repaint the bare role letter on the next reload, the very bug
    // this provider exists to prevent.
    const wasAuthenticatedRef = useRef(isAuthenticated);
    useEffect(() => {
        if (isLoading) return;
        if (wasAuthenticatedRef.current && !isAuthenticated) {
            requestedRef.current = {};
            for (const role of ROLES) abortRef.current[role]?.abort();
            abortRef.current = {};
            setEntries({});
            clearSidebarChips();
        }
        wasAuthenticatedRef.current = isAuthenticated;
    }, [isAuthenticated, isLoading]);

    const chipFor = useCallback(
        (role: ShellRole): SidebarChip => {
            const entry = entries[role];
            if (entry?.profile) return { status: 'loaded', ...entry.profile };
            if (entry?.failed) return { status: 'failed' };
            return { status: 'loading' };
        },
        [entries],
    );

    return (
        <SidebarProfileContext.Provider value={{ chipFor, request }}>
            {children}
        </SidebarProfileContext.Provider>
    );
}

/**
 * The chip for `role`, loading it if this session has not already. Safe to call
 * from as many shells as mount: the second caller on the same key gets the
 * cached value and sends no request.
 */
export function useSidebarProfile(role: ShellRole): SidebarChip {
    const ctx = useContext(SidebarProfileContext);
    // Read before the guard below so the hooks in this function are
    // unconditional; `request` is undefined only on the path that throws.
    const request = ctx?.request;
    useEffect(() => {
        request?.(role);
    }, [request, role]);
    if (!ctx) throw new Error('useSidebarProfile must be used inside SidebarProfileProvider');
    return ctx.chipFor(role);
}
