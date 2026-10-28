/**
 * Build-time feature flags.
 *
 * Each reads its `NEXT_PUBLIC_*` variable at call time, written out in full so
 * Next inlines it into the client bundle (a computed `process.env[name]` is
 * never inlined). Only the exact string `'true'` turns a flag on: an unset,
 * empty or misspelled value leaves the feature off, which is the safe side.
 */

/**
 * Phase 3 team management (invites, the Team page, role-aware navigation, the
 * membership-blocked screens). Off: the app behaves exactly as in Phase 2 --
 * no membership request, no `/employer/access` redirect, Phase 2's nav. The
 * backend's twin is `TEAM_MANAGEMENT_ENABLED`; both come from the same
 * deploy-time setting (`JALE_TEAM_MANAGEMENT_ENABLED`).
 */
export function isTeamManagementEnabled(): boolean {
    return process.env.NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED === 'true';
}
