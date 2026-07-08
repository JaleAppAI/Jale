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

/** A disabled/"soon" employer nav item (rendered non-interactively). */
export type DisabledNavItem = {
    key: string;
    icon: IconName;
    labelKey: string;
    badge?: 'soon';
};

/**
 * Employer primary nav. Targets are kept exactly as the dashboard uses them
 * today (there is no top-level `/employer/jobs` page yet, so "jobs" points at
 * the dashboard's jobs section).
 */
export const employerPrimaryNav: NavItem[] = [
    { key: 'dashboard', href: '/employer/dashboard', icon: 'grid', labelKey: 'nav.dashboard', exact: true },
    { key: 'jobs', href: '/employer/dashboard', icon: 'briefcase', labelKey: 'nav.jobs', activePrefixes: ['/employer/jobs'] },
    { key: 'messages', href: '/employer/conversations', icon: 'message', labelKey: 'nav.messages' },
];

/** Disabled "Hiring" section — unchanged from the dashboard today. */
export const employerHiringNav: DisabledNavItem[] = [
    { key: 'workers', icon: 'user', labelKey: 'nav.workers' },
    { key: 'interviews', icon: 'clock', labelKey: 'nav.interviews', badge: 'soon' },
    { key: 'search_workers', icon: 'search', labelKey: 'nav.search_workers' },
    { key: 'boost_job', icon: 'spark', labelKey: 'nav.boost_job' },
    { key: 'jale_direct', icon: 'briefcase', labelKey: 'nav.jale_direct' },
];

/** Disabled "Account" section — unchanged from the dashboard today. */
export const employerAccountNav: DisabledNavItem[] = [
    { key: 'analytics', icon: 'chart', labelKey: 'nav.analytics' },
    { key: 'billing', icon: 'briefcase', labelKey: 'nav.billing' },
];

/** Employer Settings link (live). */
export const employerSettingsNav: NavItem = {
    key: 'settings',
    href: '/employer/profile',
    icon: 'user',
    labelKey: 'nav.settings',
};

/** Worker primary nav — mirrors the worker bottom tab bar. */
export const workerPrimaryNav: NavItem[] = [
    { key: 'find_jobs', href: '/worker/home', icon: 'search', labelKey: 'worker_home', activePrefixes: ['/worker/home', '/worker/jobs'] },
    { key: 'applications', href: '/worker/applications', icon: 'briefcase', labelKey: 'my_applications' },
    { key: 'profile', href: '/worker/profile', icon: 'user', labelKey: 'profile' },
];

export function getInitials(value: string, fallback: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return fallback;
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}
