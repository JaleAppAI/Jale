'use client';
import { useMemo } from 'react';
import { useEmployerMembership, type EmployerMembership } from '@/hooks/useEmployerMembership';
import type { EmployerBilling } from '@/lib/api/employer';
import { membershipRole } from '@/lib/employer-membership-store';
import { isTeamManagementEnabled } from '@/lib/feature-flags';
import type { PlanLimitAudience } from '@/lib/plan-limit';

/** What a caller may know of billing; either half can be missing. */
export type AudienceBilling = Partial<Pick<EmployerBilling, 'planCode' | 'role'>> | null | undefined;

/**
 * Who reads a plan-limit message (Phase 3), as `planLimitModel` and
 * `upgradeOffered` take it: `undefined` with the team flag off (the membership
 * reads `disabled`), so every caller stays exactly Phase 2.
 *
 * - `role`: the membership's (`membershipRole`: `ready` gives its role,
 *   `error` its billing fallback); while that is unknown (`loading`), the role
 *   `billing` names, when the caller has billing; otherwise null, which the
 *   model reads as the owner (an API from before companies).
 * - `blocked` (removed, suspended, no company) is never the owner, whatever
 *   billing says: it reads as `'foreman'`, the audience with no "Upgrade"
 *   CTA. The page is already routing it to `/employer/access`; until then it
 *   must not be offered the owner's upgrade (Milestone C review, M1).
 * - `planCode`: billing's, when the caller has it. `planLimitModel` falls back
 *   to the plan a 403 itself names.
 *
 * Pure, so a component that cannot run the membership hook directly (one that
 * splits on the flag instead) derives the same answer.
 */
export function planLimitAudienceFor(
    membership: EmployerMembership,
    billing?: AudienceBilling,
): PlanLimitAudience | undefined {
    // Both say "flag off"; the explicit check keeps that true whatever a
    // membership answer (or a test double of one) claims.
    if (!isTeamManagementEnabled() || membership.status === 'disabled') return undefined;
    const planCode = billing?.planCode ?? null;
    if (membership.status === 'blocked') return { role: 'foreman', planCode };
    return { role: membershipRole(membership) ?? billing?.role ?? null, planCode };
}

/**
 * `planLimitAudienceFor` over `useEmployerMembership()`. The membership hook
 * makes no request with the flag off, and one shared request per session with
 * it on. Memoised on the two answers, so it is safe in effect and memo deps.
 */
export function usePlanLimitAudience(billing?: AudienceBilling): PlanLimitAudience | undefined {
    const membership = useEmployerMembership();
    const role = billing?.role;
    const planCode = billing?.planCode;
    return useMemo(() => planLimitAudienceFor(membership, { role, planCode }), [membership, role, planCode]);
}
