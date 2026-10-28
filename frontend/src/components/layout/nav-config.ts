import type { IconName } from '@/components/ui/icon';
import type { EmployerMembership } from '@/lib/employer-membership-store';

export type ShellRole = 'worker' | 'employer';

/**
 * A live nav link. `labelKey` is a next-intl key; which translation namespace
 * it resolves against is decided by the rendering component (Sidebar /
 * BottomTabBar), since those are role-scoped.
 */
export type NavItem = {
    key: string;
    href: string;
    icon: IconName;
    labelKey: string;
    /** Path prefixes that mark this item active; defaults to `[href]`. */
    activePrefixes?: string[];
    /** When true, only an exact pathname match activates this item. */
    exact?: boolean;
    /**
     * Shown only to the company's owner (Phase 3). See `isEmployerNavItemVisible`
     * for how the role is decided while it is still unknown.
     */
    ownerOnly?: boolean;
    /** Shown only while the named feature flag is on. `'team'`: `isTeamManagementEnabled()`. */
    flag?: 'team';
};

export function isNavItemActive(item: NavItem, pathname: string): boolean {
    if (item.exact) return pathname === item.href;
    const prefixes = item.activePrefixes ?? [item.href];
    return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Employer primary nav. Targets are kept exactly as the dashboard uses them
 * today (there is no top-level `/employer/jobs` page yet, so "jobs" points at
 * the dashboard's jobs section).
 */
export const employerPrimaryNav: NavItem[] = [
    { key: 'dashboard', href: '/employer/dashboard', icon: 'grid', labelKey: 'nav.dashboard', exact: true },
    // Messages sits directly under the dashboard, above the management
    // surfaces (sprint 26, B3): a worker's reply is the one thing here that
    // goes stale if it is not read today, and it was previously the third
    // item, below a deep-dive list an employer visits occasionally.
    { key: 'messages', href: '/employer/conversations', icon: 'message', labelKey: 'nav.messages' },
    { key: 'applicants', href: '/employer/applicants', icon: 'user', labelKey: 'nav.applicants' },
    { key: 'templates', href: '/employer/templates', icon: 'briefcase', labelKey: 'nav.templates' },
];

/**
 * Employer Team link (Phase 3): the owner's invites and members. Owner-only and
 * behind the team flag, so with the flag off the sidebar is Phase 2's. Never on
 * the mobile bar (four tabs is its ceiling; see `employerMobileNav`).
 */
export const employerTeamNav: NavItem = {
    key: 'team',
    href: '/employer/team',
    // No dedicated "people" glyph exists in the icon set; `user` is the
    // nearest, as for Applicants and Settings.
    icon: 'user',
    labelKey: 'nav.team',
    ownerOnly: true,
    flag: 'team',
};

/** Employer Billing link (live). Only the owner pays (Phase 2), so owner-only. */
export const employerBillingNav: NavItem = {
    key: 'billing',
    href: '/employer/billing',
    icon: 'chart',
    labelKey: 'nav.billing',
    ownerOnly: true,
};

/** Employer Settings link (live). */
export const employerSettingsNav: NavItem = {
    key: 'settings',
    href: '/employer/profile',
    icon: 'user',
    labelKey: 'nav.settings',
};

/**
 * Sidebar-only primary-nav items: management/secondary surfaces that don't
 * earn a slot in the four-tab mobile bar. Keep this list, not the mobile
 * composition below, as the place a new item opts out of mobile — one set
 * membership check instead of a second copy of the exclusion logic.
 */
const employerSidebarOnlyKeys = new Set(['templates']);

/**
 * Employer mobile tab bar. Composed from the very same `NavItem`s the sidebar
 * renders — never a parallel list — so the two surfaces cannot drift apart on a
 * target, an icon or a label key. Four tabs is the practical ceiling for a
 * bottom bar at 360px, and they are taken in sidebar order: dashboard,
 * messages and applicants, then settings.
 *
 * Applicants joined the bar in sprint 29: employers on phones had no way to
 * reach the board. Billing left it to keep four tabs; on a phone the plan is
 * reached from the dashboard's plan meter ("View plan").
 */
export const employerMobileNav: NavItem[] = [
    // Templates is a management surface, not a daily destination, so it stays
    // sidebar-only.
    ...employerPrimaryNav.filter((item) => !employerSidebarOnlyKeys.has(item.key)),
    employerSettingsNav,
];

/**
 * The sidebar's items after the primary nav, in order: Team, Billing, Settings.
 * Team and Billing drop out by `isEmployerNavItemVisible`.
 */
export const employerSidebarSecondaryNav: NavItem[] = [employerTeamNav, employerBillingNav, employerSettingsNav];

/**
 * Who the employer nav is drawn for: `'owner'`, `'foreman'`, or `null` while
 * that is not known.
 *
 * - `disabled` (team flag off): `'owner'`. Every login is its company's owner,
 *   which draws exactly Phase 2's nav.
 * - `ready`: the membership's role.
 * - `error`: billing's role, read by the hook after the failure. `null` there
 *   (billing failed too, or named no role) counts as the owner, so an owner
 *   never loses Billing to a flaky membership call; the server enforces
 *   `owner_required` anyway.
 * - `loading` and `blocked`: `null`. A blocked login (removed, suspended, no
 *   company) is never an owner; the hook has already routed it away.
 */
export function employerNavRole(membership: EmployerMembership): 'owner' | 'foreman' | null {
    switch (membership.status) {
        case 'disabled':
            return 'owner';
        case 'ready':
            return membership.role;
        case 'error':
            return membership.billingRole ?? 'owner';
        default:
            return null;
    }
}

/**
 * Whether an employer nav item is drawn: a flagged item only with its flag on,
 * an owner-only item only for a known owner (hidden while the role is `null`).
 */
export function isEmployerNavItemVisible(
    item: NavItem,
    role: 'owner' | 'foreman' | null,
    teamEnabled: boolean,
): boolean {
    if (item.flag === 'team' && !teamEnabled) return false;
    if (item.ownerOnly && role !== 'owner') return false;
    return true;
}

/** Worker primary nav — mirrors the worker bottom tab bar. */
export const workerPrimaryNav: NavItem[] = [
    { key: 'find_jobs', href: '/worker/home', icon: 'search', labelKey: 'worker_home', activePrefixes: ['/worker/home', '/worker/jobs'] },
    { key: 'applications', href: '/worker/applications', icon: 'briefcase', labelKey: 'my_applications' },
    { key: 'profile', href: '/worker/profile', icon: 'user', labelKey: 'profile' },
];

/**
 * Re-export only. The canonical implementation lives with the component that
 * renders initials (`ui/initials-avatar`); this module used to carry a second
 * copy of it, which is exactly how the two drift apart.
 */
export { getInitials } from '@/components/ui/initials-avatar';
