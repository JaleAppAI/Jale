import type { MembershipBlockedError, MembershipBlockedReason } from '@/lib/api';

/**
 * The signed-in employer's membership, cached for the session (Phase 3).
 *
 * A plain module with no runtime imports, so `useRequireAuth` (which clears it
 * when it routes a blocked login) and `useEmployerMembership` (which fills it)
 * can both use it without an import cycle. The loading logic lives in the hook;
 * this only holds the one shared entry and the access-redirect guard.
 */

export type EmployerMembership =
    | { status: 'disabled' }
    | { status: 'loading' }
    | { status: 'ready'; role: 'owner' | 'foreman'; companyName: string; userId: string; organizationId: string }
    | { status: 'blocked'; reason: MembershipBlockedReason; hasInvite: boolean }
    | { status: 'error'; billingRole: 'owner' | 'foreman' | null };

/**
 * The answer with the team flag off, for a component that splits on the flag
 * and so never runs the membership hook.
 */
export const MEMBERSHIP_DISABLED: EmployerMembership = { status: 'disabled' };

/**
 * The role a membership answer names, and the one rule every caller shares:
 * `ready` gives its role, `error` the billing role read after the failure
 * (null when that failed too), and every other state -- `disabled`,
 * `loading`, `blocked` -- null. A blocked login is never an owner.
 *
 * What null MEANS is each caller's own policy (the nav reads a null `error`
 * as the owner, the team page as "let the server decide", flag off as Phase
 * 2), so callers apply it around this, never inside it.
 */
export function membershipRole(membership: EmployerMembership): 'owner' | 'foreman' | null {
    switch (membership.status) {
        case 'ready':
            return membership.role;
        case 'error':
            return membership.billingRole;
        default:
            return null;
    }
}

/** The access screen, without a locale (next-intl's router adds it). */
export const ACCESS_PAGE_PATH = '/employer/access';

/**
 * Where a blocked login is sent: the access screen with its reason, and
 * `invite=1` when a re-invite is waiting. A 403 that named no status
 * (`statusKnown` false) sends no reason; the screen reads membership itself.
 */
export function membershipAccessPath(
    err: Pick<MembershipBlockedError, 'reason' | 'hasInvite' | 'statusKnown'>,
): string {
    return err.statusKnown
        ? `${ACCESS_PAGE_PATH}?reason=${err.reason}${err.hasInvite ? '&invite=1' : ''}`
        : ACCESS_PAGE_PATH;
}

/** An answer the hook can settle on. */
export type SettledMembership = Exclude<EmployerMembership, { status: 'disabled' } | { status: 'loading' }>;

export type MembershipLoadResult = { value: SettledMembership; blockedError: MembershipBlockedError | null };

export type MembershipCacheEntry = {
    /** `AuthContext.sessionCleared.epoch` when the request was made. */
    epoch: number;
    promise: Promise<MembershipLoadResult>;
    /** Set once settled, so a later mount renders the answer on its first paint. */
    value: SettledMembership | null;
    /**
     * A blocked answer is handed to `handleLegalWall` once per entry, not once
     * per mounted caller (sidebar, tab bar and page would each `replace`).
     */
    blockedRouted: boolean;
};

let entry: MembershipCacheEntry | null = null;

/**
 * Bumped by every `clearEmployerMembershipCache()`: the moments the
 * membership may have changed. Readers that stop asking while a login is
 * blocked (the global inbox poll) subscribe, and ask once more on a bump.
 */
let generation = 0;
const generationListeners = new Set<() => void>();

/** The shared entry for this session, or null. */
export function readMembershipCache(epoch: number): MembershipCacheEntry | null {
    return entry && entry.epoch === epoch ? entry : null;
}

export function writeMembershipCache(next: MembershipCacheEntry): void {
    entry = next;
}

/** Drop `which` only if it is still the shared entry (a newer one stays). */
export function dropMembershipCacheEntry(which: MembershipCacheEntry): void {
    if (entry === which) entry = null;
}

/**
 * Forget the cached membership. Called when it may have changed: a blocked
 * login routed to the access screen, arrival on that screen, "start my
 * company", an invite accept, a sign-out.
 */
export function clearEmployerMembershipCache(): void {
    entry = null;
    generation += 1;
    for (const listener of generationListeners) listener();
}

/** How many times the cache was cleared (`useSyncExternalStore` snapshot). */
export function membershipCacheGeneration(): number {
    return generation;
}

/** Calls `listener` after every clear; returns the unsubscribe. */
export function subscribeMembershipCache(listener: () => void): () => void {
    generationListeners.add(listener);
    return () => {
        generationListeners.delete(listener);
    };
}

// ---------------------------------------------------------------------------
// Access-screen redirect guard
//
// `/employer/access` sends a login whose membership reads active back to the
// dashboard. If some other route keeps answering 403 membership_inactive for
// that login, the two would bounce forever. So the automatic redirect happens
// at most once per page load; an explicit membership change (start my company,
// an accept) re-arms it.
// ---------------------------------------------------------------------------

let accessRedirectSpent = false;

/** True (and spends the guard) when the access screen may redirect to the dashboard. */
export function takeAccessRedirect(): boolean {
    if (accessRedirectSpent) return false;
    accessRedirectSpent = true;
    return true;
}

export function resetAccessRedirectGuard(): void {
    accessRedirectSpent = false;
}
