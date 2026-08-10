'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { apiFetch } from '@/lib/api';
import { getEmployerProfile } from '@/lib/api/employer';
import type { WorkerProfileData } from '@/lib/api/worker';
import { tradeLabel } from '@/lib/trades';
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
 * Joins the parts of the chip's second line, dropping the ones the profile does
 * not have. Returns `null` — not `''` — when nothing survives, so the caller
 * cannot accidentally treat "no second line" as "a second line to fill in".
 */
function joinMeta(parts: Array<string | null | undefined>): string | null {
    const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
    return kept.length > 0 ? kept.join(' · ') : null;
}

/**
 * Role-aware application shell: navy desktop sidebar + sticky white top header +
 * role-aware mobile bottom tab bar. Fetches the minimal profile needed for the
 * sidebar chip; the fetch never gates the page, and the chip reports which of
 * its three states it is actually in rather than papering over two of them.
 */
export function AppShell({ role, title, subtitle, actions, children }: AppShellProps) {
    const { idToken, logout } = useAuth();
    const tHeader = useTranslations('header');
    const tCommon = useTranslations('common');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';

    const [chip, setChip] = useState<SidebarChip>({ status: 'loading' });
    const [signingOut, setSigningOut] = useState(false);

    const homeHref = role === 'worker' ? '/worker/home' : '/employer/dashboard';

    /*
     * Best-effort chip fetch: non-blocking, and it never throws into render.
     * What changed is the failure path -- a rejected request, or a non-OK
     * worker-profile response, now lands the chip in `failed` instead of
     * leaving a placeholder that looked exactly like real data.
     *
     * `tCommon` is a dependency because the worker meta line is translated
     * here. next-intl memoises the translator on (messages, locale, namespace),
     * so its identity is stable and this does not re-fetch on every render.
     */
    useEffect(() => {
        if (!idToken) return;
        let active = true;

        async function load() {
            try {
                if (role === 'employer') {
                    const profile = await getEmployerProfile(idToken!);
                    if (!active) return;
                    const name = profile.company_name?.trim() || profile.full_name?.trim() || null;
                    setChip({
                        status: 'loaded',
                        name,
                        meta: joinMeta([profile.city, profile.service_area]),
                        initials: getInitials(name ?? '', 'E'),
                    });
                } else {
                    const res = await apiFetch('/worker/profile', {}, idToken!);
                    // A non-OK response is a failed load, not an empty profile.
                    if (!res.ok) throw new Error('worker_profile_unavailable');
                    const profile = (await res.json()) as WorkerProfileData;
                    if (!active) return;
                    const name = profile.full_name?.trim() || null;
                    setChip({
                        status: 'loaded',
                        name,
                        // `city` is the precise field; `location` is the older
                        // free-text one kept as a fallback for profiles that
                        // predate it.
                        meta: joinMeta([
                            profile.main_trade
                                ? tradeLabel(tCommon, profile.main_trade, profile.main_trade_other)
                                : null,
                            profile.city ?? profile.location,
                        ]),
                        initials: getInitials(name ?? '', 'W'),
                    });
                }
            } catch {
                if (active) setChip({ status: 'failed' });
            }
        }

        load();
        return () => {
            active = false;
        };
    }, [idToken, role, tCommon]);

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
