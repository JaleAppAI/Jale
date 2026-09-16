'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useSidebarProfile } from '@/contexts/SidebarProfileContext';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { Sidebar } from './Sidebar';
import { BottomTabBar } from './BottomTabBar';
import type { ShellRole } from './nav-config';

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
 * role-aware mobile bottom tab bar.
 *
 * The sidebar chip is READ from `SidebarProfileContext`, never fetched here.
 * Every page mounts its own shell, so a fetch owned by this component ran again
 * on every navigation and every reload -- and until it answered the chip had
 * nothing but a role letter to draw. The profile belongs to the session, so it
 * is loaded once, above the router, and this component only renders it.
 */
export function AppShell({ role, title, subtitle, actions, children }: AppShellProps) {
    const { logout } = useAuth();
    const tHeader = useTranslations('header');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';

    const chip = useSidebarProfile(role);
    const [signingOut, setSigningOut] = useState(false);

    const homeHref = role === 'worker' ? '/worker/home' : '/employer/dashboard';

    async function handleSignOut() {
        setSigningOut(true);
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    }

    return (
        <div className="min-h-screen bg-[var(--jale-shell)] text-[var(--jale-ink)]">
            <div className="grid min-h-screen lg:grid-cols-[280px_minmax(0,1fr)]">
                <Sidebar role={role} homeHref={homeHref} chip={chip} />

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
                                {/* No profile avatar here. It was a second,
                                    redundant route to the same page the sidebar
                                    chip and the Settings/Profile tab already
                                    reach, and pre-fetch it rendered a bare role
                                    letter -- a control whose only content was a
                                    guess. Profile lives in the nav. */}
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

                    {/* Bottom padding on mobile reserves room for the tab bar
                        (5rem bar + safe-area inset on notched devices). Both
                        roles now have one, so both roles reserve the room. */}
                    <div className="pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</div>
                </section>
            </div>

            <BottomTabBar role={role} />
        </div>
    );
}
