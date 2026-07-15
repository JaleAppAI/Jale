'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import {
    employerPrimaryNav,
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
 * Desktop navy sidebar (`#10143b`). Hidden below `lg`. The navy is the one hex
 * the dashboard itself hardcodes, so it is preserved here intentionally.
 */
export function Sidebar({ role, homeHref, chip }: SidebarProps) {
    const t = useTranslations('employer_dashboard');
    const tShell = useTranslations('app_shell');
    const pathname = usePathname();

    return (
        <aside className="hidden bg-[#10143b] text-white lg:flex lg:flex-col">
            <div className="border-b border-white/10 px-6 py-6">
                <Link href={homeHref} className="text-3xl font-extrabold text-white">
                    Jale
                </Link>
                <p className="mt-1 text-xs font-semibold uppercase text-white/55">
                    {role === 'employer' ? t('shell.employer_workspace') : tShell('worker_workspace')}
                </p>
            </div>

            <div className="border-b border-white/10 px-6 py-5">
                <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--jale-blue-500)] text-sm font-extrabold">
                        {chip.initials}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-bold">{chip.name}</p>
                        <p className="truncate text-xs text-white/55">
                            {chip.meta || (role === 'employer' ? t('shell.plan_label') : tShell('worker_role'))}
                        </p>
                    </div>
                </div>
            </div>

            <nav className="flex-1 overflow-y-auto px-4 py-5">
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
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold',
                active ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10 hover:text-white',
            ].join(' ')}
        >
            <Icon name={item.icon} />
            {label}
        </Link>
    );
}

function WorkerNav({ navLabel, pathname }: { navLabel: string; pathname: string }) {
    const tHeader = useTranslations('header');
    return (
        <>
            <p className="mb-2 px-2 text-[11px] font-bold uppercase text-white/45">{navLabel}</p>
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
            <p className="mb-2 px-2 text-[11px] font-bold uppercase text-white/45">{t('nav.main')}</p>
            <div className="space-y-1">
                {employerPrimaryNav.map((item) => (
                    <NavLink key={item.key} item={item} active={isNavItemActive(item, pathname)} label={t(item.labelKey)} />
                ))}
                <NavLink
                    item={employerSettingsNav}
                    active={isNavItemActive(employerSettingsNav, pathname)}
                    label={t(employerSettingsNav.labelKey)}
                />
            </div>
        </>
    );
}
