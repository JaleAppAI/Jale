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
