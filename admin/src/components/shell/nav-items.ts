import { ChartColumn, House, Inbox, Shield, Users, type LucideIcon } from 'lucide-react';
import type { AdminRole } from '@/lib/types';

export type AdminNavItem = {
  href: '/' | '/inbox' | '/analytics' | '/admins' | '/security';
  label: 'Home' | 'Inbox' | 'Analytics' | 'Admins' | 'Security';
  icon: LucideIcon;
  /** Home is current on '/' only; every other entry on its path and below. */
  exact: boolean;
  /** Shown to admin_superadmin only (K1.4). The pages check the role again. */
  superadminOnly?: boolean;
  /** Carries the waiting-on-us badge (K2.1). */
  inboxBadge?: boolean;
  /** Other paths that belong to this entry (Report settings opens from the Inbox header). */
  alsoActiveOn?: readonly string[];
};

// lucide-react 1.x names: House (not Home), ChartColumn (not BarChart3).
// Admin links never prefetch: a page may record a read when it renders, and a
// prefetch must never record a read the admin did not make.
export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/', label: 'Home', icon: House, exact: true },
  { href: '/inbox', label: 'Inbox', icon: Inbox, exact: false, inboxBadge: true, alsoActiveOn: ['/reports/settings'] },
  { href: '/analytics', label: 'Analytics', icon: ChartColumn, exact: false },
  { href: '/admins', label: 'Admins', icon: Users, exact: false, superadminOnly: true },
  { href: '/security', label: 'Security', icon: Shield, exact: false, superadminOnly: true },
];

export function visibleNavItems(role: AdminRole): AdminNavItem[] {
  return ADMIN_NAV.filter((item) => !item.superadminOnly || role === 'admin_superadmin');
}

const isUnder = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);

export function isNavActive(pathname: string, item: Pick<AdminNavItem, 'href' | 'exact' | 'alsoActiveOn'>): boolean {
  if (item.exact) return pathname === item.href;
  return isUnder(pathname, item.href) || (item.alsoActiveOn ?? []).some((path) => isUnder(pathname, path));
}
