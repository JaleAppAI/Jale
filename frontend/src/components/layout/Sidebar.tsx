'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import {
    employerPrimaryNav,
    employerBillingNav,
    employerSettingsNav,
    workerPrimaryNav,
    isNavItemActive,
    type NavItem,
    type ShellRole,
} from './nav-config';

/**
 * What the chip knows about the signed-in account, as resolved by `AppShell`.
 *
 * The three states are explicit because the chip previously had no way to tell
 * them apart: a pending fetch and a failed one both rendered a localized
 * placeholder name ("Your profile" / "Employer team") over a role word dressed
 * up as a subtitle ("Worker" / "Jale Growth"), which is indistinguishable from
 * a real profile that happens to be called that. Now "we don't know yet" is a
 * skeleton and "we couldn't find out" is the role, stated as the role.
 */
export type SidebarChip =
    | { status: 'loading' }
    | { status: 'failed' }
    | {
          status: 'loaded';
          /** Real `full_name` / `company_name`; `null` when the profile has none. */
          name: string | null;
          /** Real, already-joined second line; `null` when there is nothing to say. */
          meta: string | null;
          /** Initials of `name`, or the role letter when there is no name. */
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
                <SidebarProfileChip role={role} chip={chip} />
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

/** Role letter shown on the tile until (or instead of) real initials. */
function roleLetter(role: ShellRole): string {
    return role === 'employer' ? 'E' : 'W';
}

/**
 * The account chip. Says only what it knows.
 *
 * Line boxes are fixed (`h-5` for the `text-sm` name, `h-4` for the `text-xs`
 * meta) so the skeleton→name swap does not move the nav below it. The chip does
 * shrink by one line when the loaded profile has no second line to show — that
 * is the honest outcome, and inventing a filler sentence to hold the space open
 * is precisely the behaviour this replaces.
 */
function SidebarProfileChip({ role, chip }: { role: ShellRole; chip: SidebarChip }) {
    const tShell = useTranslations('app_shell');
    const roleWord = role === 'employer' ? tShell('employer_role') : tShell('worker_role');

    // A loaded profile with no name is not a failure -- we reached the server,
    // the account simply has not been named yet -- but it renders the same way,
    // because "we know your role and nothing else" is the same sentence.
    const lines =
        chip.status === 'loaded'
            ? [chip.name, chip.meta].filter((line): line is string => Boolean(line))
            : [];
    const primary: string = lines[0] ?? roleWord;
    // Annotated, because index access is not `| undefined` under this tsconfig
    // and the second line genuinely may not exist.
    const secondary: string | undefined = lines[1];

    return (
        <div className="flex items-center gap-3">
            {/* Not `InitialsAvatar`: that is the blue-50/blue-700 tint for
                light surfaces. This tile sits ON the navy rail, where the
                readable pairing is solid brand blue with white. It keeps its
                footprint in every state; only the letters inside it change. */}
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--jale-blue-500)] text-sm font-extrabold">
                {chip.status === 'loaded' ? chip.initials : roleLetter(role)}
            </div>

            {chip.status === 'loading' ? (
                <div className="min-w-0 flex-1">
                    <div className="flex h-5 items-center">
                        <Skeleton tone="rail" className="h-3 w-28" />
                    </div>
                    <div className="flex h-4 items-center">
                        <Skeleton tone="rail" className="h-2.5 w-20" />
                    </div>
                </div>
            ) : (
                <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{primary}</p>
                    {secondary ? (
                        <p className="truncate text-xs font-medium text-white/55">{secondary}</p>
                    ) : null}
                </div>
            )}
        </div>
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
