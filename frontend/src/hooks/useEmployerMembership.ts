'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { isMembershipBlockedError, type MembershipBlockedError } from '@/lib/api';
import { getBilling } from '@/lib/api/employer';
import { getMembership } from '@/lib/api/team';
import {
    clearEmployerMembershipCache,
    dropMembershipCacheEntry,
    MEMBERSHIP_DISABLED,
    readMembershipCache,
    writeMembershipCache,
    type EmployerMembership,
    type MembershipCacheEntry,
    type MembershipLoadResult,
    type SettledMembership,
} from '@/lib/employer-membership-store';
import { isTeamManagementEnabled } from '@/lib/feature-flags';
import { currentReturnPath } from '@/lib/login-url';

/**
 * The signed-in employer's place in their company (Phase 3).
 *
 * - `disabled`: the team flag is off. No request is made; callers behave
 *   exactly as in Phase 2 (every login is its company's owner).
 * - `loading`: no answer yet (or no employer token yet).
 * - `ready`: an active member.
 * - `blocked`: removed, billing-suspended, or in no company. Never an owner:
 *   callers show nothing owner-only. The hook has already handed the error to
 *   `handleLegalWall` (once per cached answer), which routes to
 *   `/employer/access`.
 * - `error`: the membership call failed for any other reason. `billingRole`
 *   is `getBilling(token).role`, read once after the failure (null when that
 *   fails too or names no role), so navigation can still follow the server's
 *   billing answer -- an owner keeps Billing; the server enforces anyway. If
 *   that billing read says the login is blocked, the answer is `blocked`.
 *
 * One request per session, shared by every caller (sidebar, tab bar, page)
 * through `lib/employer-membership-store`. Keyed by the session-cleared
 * epoch: a sign-out (or any session clear) starts a new session. An `error`
 * answer is not kept, so the next page to mount retries; `ready` and
 * `blocked` are.
 */
export type { EmployerMembership } from '@/lib/employer-membership-store';
export { clearEmployerMembershipCache };

const LOADING: EmployerMembership = { status: 'loading' };

function blocked(err: MembershipBlockedError): MembershipLoadResult {
    // Never the billing fallback: a blocked login must not read as an owner.
    return { value: { status: 'blocked', reason: err.reason, hasInvite: err.hasInvite }, blockedError: err };
}

async function loadMembership(token: string): Promise<MembershipLoadResult> {
    try {
        const m = await getMembership(token);
        return {
            value: { status: 'ready', role: m.role, companyName: m.companyName, userId: m.userId, organizationId: m.organizationId },
            blockedError: null,
        };
    } catch (err) {
        if (isMembershipBlockedError(err)) return blocked(err);
        let billingRole: 'owner' | 'foreman' | null = null;
        try {
            const role = (await getBilling(token)).role;
            billingRole = role === 'owner' || role === 'foreman' ? role : null;
        } catch (billingErr) {
            if (isMembershipBlockedError(billingErr)) return blocked(billingErr);
            billingRole = null;
        }
        return { value: { status: 'error', billingRole }, blockedError: null };
    }
}

function cachedLoad(token: string, epoch: number): MembershipCacheEntry {
    const cached = readMembershipCache(epoch);
    if (cached) return cached;
    const entry: MembershipCacheEntry = { epoch, promise: loadMembership(token), value: null, blockedRouted: false };
    writeMembershipCache(entry);
    void entry.promise.then(({ value }) => {
        if (value.status === 'error') dropMembershipCacheEntry(entry);
        else entry.value = value;
    });
    return entry;
}

export function useEmployerMembership(): EmployerMembership {
    const enabled = isTeamManagementEnabled();
    // The employer's token without arming a sign-in redirect: the page that
    // uses this hook owns that decision.
    const { idToken, handleLegalWall } = useRequireAuth({ enabled: false, role: 'employer' });
    const { sessionCleared } = useAuth();
    // `?.` for test doubles of useAuth that predate `sessionCleared`.
    const epoch = sessionCleared?.epoch ?? 0;

    // This caller's own settled answer, for the session it was asked in.
    const [settled, setSettled] = useState<{ epoch: number; value: SettledMembership } | null>(null);

    useEffect(() => {
        if (!enabled || !idToken) return;
        let live = true;
        const entry = cachedLoad(idToken, epoch);
        void entry.promise.then(({ value, blockedError }) => {
            if (!live) return;
            setSettled({ epoch, value });
            if (blockedError && !entry.blockedRouted) {
                entry.blockedRouted = true;
                try {
                    // A blocked error is never the legal wall, so this return
                    // URL is never stored; it is passed for the signature.
                    handleLegalWall(blockedError, currentReturnPath() ?? '');
                } catch {
                    // handleLegalWall only re-throws what it does not route; a
                    // blocked error always routes.
                }
            }
        });
        return () => {
            live = false;
        };
    }, [enabled, idToken, epoch, handleLegalWall]);

    if (!enabled) return MEMBERSHIP_DISABLED;
    if (!idToken) return LOADING;
    if (settled && settled.epoch === epoch) return settled.value;
    // A later mount renders an answer another caller already settled on its
    // first paint, with no request and no loading flash.
    const cached = readMembershipCache(epoch);
    if (cached?.value) return cached.value;
    return LOADING;
}
