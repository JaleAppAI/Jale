'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { apiFetch } from '@/lib/api';
import { getEmployerProfile } from '@/lib/api/employer';
import type { WorkerProfileData } from '@/lib/api/worker';
import { Sidebar, type SidebarChip } from './Sidebar';
import { BottomTabBar } from './BottomTabBar';
import { getInitials, type ShellRole } from './nav-config';

type AppShellProps = {
    role: ShellRole;
    /** Page title shown in the sticky top header. */
    title: ReactNode;
    /** Optional subtitle under the title. */
    subtitle?: ReactNode;
    /** Optional actions rendered before the language toggle (e.g. "Post job"). */
    actions?: ReactNode;
    children: ReactNode;
};

/**
 * Role-aware application shell: navy desktop sidebar + sticky white top header +
 * (worker only) mobile bottom tab bar. Fetches the minimal profile needed for
 * the sidebar/header chip; tolerates it being briefly empty (never blocks
 * children on the fetch).
 */
export function AppShell({ role, title, subtitle, actions, children }: AppShellProps) {
    const { idToken, logout } = useAuth();
    const tHeader = useTranslations('header');
    const tShell = useTranslations('app_shell');
    const tCommon = useTranslations('common');
    const tDash = useTranslations('employer_dashboard');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';

    const [chip, setChip] = useState<SidebarChip | null>(null);
    const [signingOut, setSigningOut] = useState(false);

    const homeHref = role === 'worker' ? '/worker/home' : '/employer/dashboard';
    const profileHref = role === 'worker' ? '/worker/profile' : '/employer/profile';
    const chipFallback = role === 'employer' ? tDash('shell.company_fallback') : tShell('worker_fallback');
    const initialsFallback = role === 'employer' ? 'E' : 'W';

    // Best-effort chip fetch. Never throws into render; empty state is tolerated.
    useEffect(() => {
        if (!idToken) return;
        let active = true;

        async function load() {
            try {
                if (role === 'employer') {
                    const profile = await getEmployerProfile(idToken!);
                    if (!active) return;
                    const name = profile.company_name?.trim() || profile.full_name?.trim() || chipFallback;
                    const meta = [profile.city, profile.service_area]
                        .map((item) => item?.trim())
                        .filter(Boolean)
                        .join(' · ');
                    setChip({ name, meta, initials: getInitials(name, initialsFallback) });
                } else {
                    const res = await apiFetch('/worker/profile', {}, idToken!);
                    if (!res.ok || !active) return;
                    const profile = (await res.json()) as WorkerProfileData;
                    const name = profile.full_name?.trim() || chipFallback;
                    const meta = [profile.city, profile.location]
                        .map((item) => item?.trim())
                        .filter(Boolean)
                        .join(' · ');
                    setChip({ name, meta, initials: getInitials(name, initialsFallback) });
                }
            } catch {
                // Ignore — the chip renders its loading/empty placeholder.
            }
        }

        load();
        return () => {
            active = false;
        };
    }, [idToken, role, chipFallback, initialsFallback]);

    async function handleSignOut() {
        setSigningOut(true);
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    }

    // Placeholder chip while loading / when the fetch fails.
    const resolvedChip: SidebarChip = chip ?? { name: chipFallback, meta: '', initials: initialsFallback };

    return (
        <div className="min-h-screen bg-[var(--jale-shell)] text-[var(--jale-ink)]">
            <div className="grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
                <Sidebar role={role} homeHref={homeHref} chip={resolvedChip} />

                <section className="min-w-0">
                    <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_92%,transparent)] px-4 py-4 backdrop-blur md:px-6 lg:px-8">
                        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div className="min-w-0">
                                <h1 className="text-2xl font-extrabold tracking-tight text-[var(--jale-ink)] md:text-3xl">{title}</h1>
                                {subtitle ? (
                                    <p className="mt-1 text-sm font-medium text-[var(--jale-ink-2)]">{subtitle}</p>
                                ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {actions}
                                <Link
                                    href={pathname}
                                    locale={otherLocale}
                                    className="inline-flex h-10 items-center rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-4 text-xs font-bold text-[var(--jale-ink)] transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                                >
                                    {tHeader('language_toggle')}
                                </Link>
                                <ThemeToggle />
                                <Link
                                    href={profileHref}
                                    aria-label={tHeader('profile')}
                                    className="inline-flex rounded-xl focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                                >
                                    {/* Fed the raw name, not `resolvedChip.name`: pre-fetch
                                        that is a localized placeholder ("Your profile"),
                                        and initialising it would show "YP"/"TP" instead of
                                        the role letter. */}
                                    <InitialsAvatar
                                        name={chip?.name ?? ''}
                                        fallback={initialsFallback}
                                        size={40}
                                        square
                                    />
                                </Link>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleSignOut}
                                    loading={signingOut}
                                    loadingLabel={tCommon('loading')}
                                    className="h-10"
                                >
                                    {tHeader('sign_out')}
                                </Button>
                            </div>
                        </div>
                    </header>

                    {/* Bottom padding on mobile reserves room for the worker tab bar
                        (5rem bar + safe-area inset on notched devices). */}
                    <div className={role === 'worker' ? 'pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0' : undefined}>{children}</div>
                </section>
            </div>

            {role === 'worker' ? <BottomTabBar /> : null}
        </div>
    );
}
