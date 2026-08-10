'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import {
    employerMobileNav,
    workerPrimaryNav,
    isNavItemActive,
    type NavItem,
    type ShellRole,
} from './nav-config';

/**
 * Mobile bottom tab bar. Hidden at `lg` and above, where the desktop sidebar
 * takes over.
 *
 * Both roles render it. Employers used to be told they were "header-only on
 * mobile", which in practice meant they had NO persistent navigation below
 * `lg` at all: the sidebar is `lg:flex`, this bar was worker-only, and the
 * sticky header carries a language toggle and a sign-out button but no links.
 * An employer on a phone could reach a page and then only leave it by using
 * the browser's back button.
 */
export function BottomTabBar({ role }: { role: ShellRole }) {
    const tShell = useTranslations('app_shell');
    const pathname = usePathname();

    return (
        <nav
            aria-label={tShell('mobile_nav')}
            className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_95%,transparent)] backdrop-blur lg:hidden pb-[env(safe-area-inset-bottom)]"
        >
            <ul className="mx-auto flex max-w-lg items-stretch justify-around">
                {role === 'employer' ? (
                    <EmployerTabs pathname={pathname} />
                ) : (
                    <WorkerTabs pathname={pathname} />
                )}
            </ul>
        </nav>
    );
}

/*
 * The two roles read their labels from different namespaces -- employer nav
 * labels live under `employer_dashboard.nav.*`, worker ones under `header.*` --
 * so each gets its own component with its own `useTranslations` call. Same
 * split, and same reason, as `Sidebar`'s `EmployerNav` / `WorkerNav`. Calling
 * one hook or the other from a single component would be a conditional hook.
 */

function WorkerTabs({ pathname }: { pathname: string }) {
    const t = useTranslations('header');
    return (
        <>
            {workerPrimaryNav.map((item) => (
                <TabLink key={item.key} item={item} pathname={pathname} label={t(item.labelKey)} />
            ))}
        </>
    );
}

function EmployerTabs({ pathname }: { pathname: string }) {
    const t = useTranslations('employer_dashboard');
    return (
        <>
            {employerMobileNav.map((item) => (
                <TabLink key={item.key} item={item} pathname={pathname} label={t(item.labelKey)} />
            ))}
        </>
    );
}

function TabLink({ item, pathname, label }: { item: NavItem; pathname: string; label: string }) {
    const active = isNavItemActive(item, pathname);
    return (
        <li className="flex-1">
            <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                    // min-h keeps every tab at the 48px touch minimum even where
                    // the label wraps to one short line.
                    'flex min-h-12 flex-col items-center justify-center gap-1 py-3 text-[11px] font-semibold transition-colors',
                    active ? 'text-[var(--jale-blue-700)]' : 'text-[var(--jale-ink-2)]',
                ].join(' ')}
            >
                <Icon name={item.icon} />
                {label}
            </Link>
        </li>
    );
}
