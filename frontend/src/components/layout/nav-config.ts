import type { IconName } from '@/components/ui/icon';

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
    { key: 'applicants', href: '/employer/applicants', icon: 'user', labelKey: 'nav.applicants' },
    { key: 'messages', href: '/employer/conversations', icon: 'message', labelKey: 'nav.messages' },
    { key: 'templates', href: '/employer/templates', icon: 'briefcase', labelKey: 'nav.templates' },
];

/** Employer Billing link (live). */
export const employerBillingNav: NavItem = {
    key: 'billing',
    href: '/employer/billing',
    icon: 'chart',
    labelKey: 'nav.billing',
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
const employerSidebarOnlyKeys = new Set(['templates', 'applicants']);

/**
 * Employer mobile tab bar. Composed from the very same `NavItem`s the sidebar
 * renders — never a parallel list — so the two surfaces cannot drift apart on a
 * target, an icon or a label key. Four tabs is the practical ceiling for a
 * bottom bar at 360px; these are the four the sidebar leads with.
 */
export const employerMobileNav: NavItem[] = [
    // Templates is a management surface, not a daily destination; applicants
    // is a deep-dive/management view of the same data the dashboard and
    // messages already surface day to day -- both stay sidebar-only so the
    // bar keeps to its four-tab ceiling.
    ...employerPrimaryNav.filter((item) => !employerSidebarOnlyKeys.has(item.key)),
    employerBillingNav,
    employerSettingsNav,
];

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
