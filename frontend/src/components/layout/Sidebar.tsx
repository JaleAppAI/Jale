'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import {
    employerPrimaryNav,
    employerBillingNav,
    employerSettingsNav,
    workerPrimaryNav,
    isNavItemActive,
    type NavItem,
    type ShellRole,
} from './nav-config';

/** Chip data resolved by the AppShell (company/worker name + initials). */
export type SidebarChip = {
    name: string;
    meta?: string;
    initials: string;
};

type SidebarProps = {
    role: ShellRole;
    homeHref: string;
    chip: SidebarChip;
};

/**
 * Desktop navy sidebar (`--jale-sidebar`, `#10143b` in the light theme -- the
 * one navy the dashboard itself hardcoded, preserved exactly). It is a token
 * rather than a literal so the dark theme can deepen it; the white-on-navy
 * foreground is correct in both themes and stays literal.
 */
export function Sidebar({ role, homeHref, chip }: SidebarProps) {
    const t = useTranslations('employer_dashboard');
    const tShell = useTranslations('app_shell');
    const pathname = usePathname();

    return (
        <aside className="hidden bg-[var(--jale-sidebar)] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:self-start">
            <div className="border-b border-white/10 px-6 py-7">
                <Link href={homeHref} className="text-3xl font-extrabold tracking-tight text-white">
                    Jale
                </Link>
                <p className="mt-1.5 text-[11px] font-bold uppercase tracking-wider text-white/55">
                    {role === 'employer' ? t('shell.employer_workspace') : tShell('worker_workspace')}
                </p>
            </div>

            <div className="border-b border-white/10 px-6 py-5">
                <div className="flex items-center gap-3">
                    {/* Not `InitialsAvatar`: that is the blue-50/blue-700 tint for
                        light surfaces. This tile sits ON the navy rail, where the
                        readable pairing is solid brand blue with white. */}
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--jale-blue-500)] text-sm font-extrabold">
                        {chip.initials}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-bold">{chip.name}</p>
                        <p className="truncate text-xs font-medium text-white/55">
                            {chip.meta || (role === 'employer' ? t('shell.plan_label') : tShell('worker_role'))}
                        </p>
                    </div>
                </div>
            </div>

            <nav aria-label={tShell('primary_nav')} className="flex-1 overflow-y-auto px-4 py-6">
                {role === 'employer' ? (
                    <EmployerNav t={t} pathname={pathname} />
                ) : (
                    <WorkerNav navLabel={tShell('worker_nav_main')} pathname={pathname} />
                )}
            </nav>
        </aside>
    );
}

function NavLink({ item, active, label }: { item: NavItem; active: boolean; label: string }) {
    return (
        <Link
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={[
                'flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                // Active is a solid brand pill rather than a white wash: the tint
                // is a token, so it holds its meaning when the rail deepens in
                // the dark theme, and it never reads as "hovered".
                active
                    ? 'bg-[var(--jale-blue-500)] text-white'
                    : 'text-white/80 hover:bg-white/10 hover:text-white',
            ].join(' ')}
        >
            <Icon name={item.icon} />
            {label}
        </Link>
    );
}

function NavSectionLabel({ children }: { children: string }) {
    return (
        <p className="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-white/45">
            {children}
        </p>
    );
}

function WorkerNav({ navLabel, pathname }: { navLabel: string; pathname: string }) {
    const tHeader = useTranslations('header');
    return (
        <>
            <NavSectionLabel>{navLabel}</NavSectionLabel>
            <div className="space-y-1">
                {workerPrimaryNav.map((item) => (
                    <NavLink key={item.key} item={item} active={isNavItemActive(item, pathname)} label={tHeader(item.labelKey)} />
                ))}
            </div>
        </>
    );
}

function EmployerNav({
    t,
    pathname,
}: {
    t: ReturnType<typeof useTranslations>;
    pathname: string;
}) {
    return (
        <>
            <NavSectionLabel>{t('nav.main')}</NavSectionLabel>
            <div className="space-y-1">
                {employerPrimaryNav.map((item) => (
                    <NavLink key={item.key} item={item} active={isNavItemActive(item, pathname)} label={t(item.labelKey)} />
                ))}
                <NavLink
                    item={employerBillingNav}
                    active={isNavItemActive(employerBillingNav, pathname)}
                    label={t(employerBillingNav.labelKey)}
                />
                <NavLink
                    item={employerSettingsNav}
                    active={isNavItemActive(employerSettingsNav, pathname)}
                    label={t(employerSettingsNav.labelKey)}
                />
            </div>
        </>
    );
}
