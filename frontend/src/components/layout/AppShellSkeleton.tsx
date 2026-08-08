'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { SkeletonLine } from '@/components/ui/skeleton';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { Sidebar, type SidebarChip } from './Sidebar';
import { BottomTabBar } from './BottomTabBar';
import type { ShellRole } from './nav-config';

type AppShellSkeletonProps = {
    role: ShellRole;
    children: ReactNode;
};

/**
 * Loading twin of `AppShell`.
 *
 * The nav chrome here is the REAL `Sidebar` / `BottomTabBar` — not skeletons of
 * them. Navigation is static, known before any fetch resolves, and immediately
 * usable, so greying it out would be a lie that also costs a layout shift when
 * the real shell mounts. Only the header title (which genuinely depends on the
 * page) is a skeleton line.
 *
 * The chip is byte-identical to the one `AppShell` shows pre-fetch (same
 * fallback strings, empty meta, same fallback initial), so mounting the real
 * shell over this one changes nothing in the sidebar.
 *
 * Every wrapper class is copied from `AppShell` verbatim. If AppShell's frame
 * changes, this must change with it or the swap will jump.
 */
export function AppShellSkeleton({ role, children }: AppShellSkeletonProps) {
    const tShell = useTranslations('app_shell');
    const tDash = useTranslations('employer_dashboard');

    const homeHref = role === 'worker' ? '/worker/home' : '/employer/dashboard';

    // Mirrors AppShell's `resolvedChip` in its pre-fetch state.
    const chip: SidebarChip = {
        name: role === 'employer' ? tDash('shell.company_fallback') : tShell('worker_fallback'),
        meta: '',
        initials: role === 'employer' ? 'E' : 'W',
    };

    return (
        <div className="min-h-screen bg-[var(--jale-shell)] text-[var(--jale-ink)]">
            <div className="grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
                <Sidebar role={role} homeHref={homeHref} chip={chip} />

                <section className="min-w-0">
                    <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_92%,transparent)] px-4 py-4 backdrop-blur md:px-6 lg:px-8">
                        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div className="min-w-0">
                                {/* Occupies the h1 (text-2xl / md:text-3xl) line box. */}
                                <div className="flex h-8 items-center md:h-9">
                                    <SkeletonLine width="w-56" className="h-5" />
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="h-10 w-24 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)]" />
                                {/* Real control, not a placeholder — same reasoning as the
                                    nav above: the theme switch needs no data and is usable
                                    the instant the shell paints. */}
                                <ThemeToggle />
                                {/* Matches `InitialsAvatar size={40} square`: 40px,
                                    12px radius, blue-50 tint — minus the letters. */}
                                <div className="h-10 w-10 rounded-xl bg-[var(--jale-blue-50)]" />
                                <div className="h-10 w-24 rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)]" />
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
