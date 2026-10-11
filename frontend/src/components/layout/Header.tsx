'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { LogOut } from 'lucide-react';
import { ReportEntryButton } from '@/components/report/ReportEntryButton';

// Routes that render their own chrome: AppShell for /employer|/worker,
// AuthShell for /auth, and the public job page's own navy brand band for /j.
// Without /j here the global bar stacked a second wordmark directly above
// that band -- two headers on the one page a referred stranger sees first.
// `/legal` and `/upload` keep the global Header.
const SHELL_ROUTE_PREFIXES = ['/employer', '/worker', '/auth', '/j'];

/*
 * Phones (below 640px). This bar is one row that cannot wrap, and signed in it
 * holds the wordmark and six controls: it used to run off the right edge of a
 * 375px screen, sign-out half hidden. Below 640px only: tighter padding and
 * gaps, every control a 40px box with ThemeToggle's ::after overlay for a 44px
 * pointer target, and sign-out as an icon. From 640px up nothing changes.
 */
const PHONE_TARGET =
    "max-sm:relative max-sm:after:absolute max-sm:after:left-1/2 max-sm:after:top-1/2 max-sm:after:h-11 max-sm:after:w-11 max-sm:after:-translate-x-1/2 max-sm:after:-translate-y-1/2 max-sm:after:content-['']";
/**
 * The language pill. From 360px to 640px it is a text pill wider than 44px,
 * with a full-width, 44px-tall target. Below 360px it is a 40px box showing
 * the two-letter code, with the centred 44px target the other controls have;
 * its name is still the full language name, in that language. The two target
 * shapes sit in disjoint ranges so neither can override the other.
 */
const PHONE_LANGUAGE_PILL = [
    "max-sm:relative max-sm:after:absolute max-sm:after:top-1/2 max-sm:after:h-11 max-sm:after:-translate-y-1/2 max-sm:after:content-['']",
    'min-[360px]:max-sm:after:inset-x-0',
    'max-[360px]:w-10 max-[360px]:justify-center max-[360px]:px-0',
    'max-[360px]:after:left-1/2 max-[360px]:after:w-11 max-[360px]:after:-translate-x-1/2',
].join(' ');

export function Header() {
    const locale = useLocale();
    const pathname = usePathname();
    const t = useTranslations('header');
    const tCommon = useTranslations('common');
    const otherLocale = locale === 'en' ? 'es' : 'en';
    const { isAuthenticated, logout, userType } = useAuth();
    const [signingOut, setSigningOut] = useState(false);

    // `usePathname` from @/i18n/navigation returns a locale-stripped path, but
    // we strip a leading /en or /es defensively in case a raw path leaks in.
    const pathWithoutLocale = pathname.replace(/^\/(en|es)(?=\/|$)/, '');
    // The marketing landing page (locale root) owns its own chrome.
    if (pathWithoutLocale === '' || pathWithoutLocale === '/') {
        return null;
    }
    if (SHELL_ROUTE_PREFIXES.some((p) => pathWithoutLocale === p || pathWithoutLocale.startsWith(`${p}/`))) {
        return null;
    }

    const homeHref = !isAuthenticated
        ? '/'
        : userType === 'worker'
            ? '/worker/home'
            : userType === 'employer'
                ? '/employer/dashboard'
                : '/';

    const handleSignOut = async () => {
        setSigningOut(true);
        try {
            await logout();
        } finally {
            setSigningOut(false);
        }
    };

    return (
        <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-[color-mix(in_srgb,var(--jale-card)_90%,transparent)] backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-3 max-sm:gap-0.5 max-[360px]:px-2 sm:px-6">
                {/* Wordmark. On phones a 44px-tall target like the controls. */}
                <Link href="/" className="jale-wordmark max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                    Jale
                </Link>

                {/* Nav + actions */}
                <div className="flex items-center gap-1 sm:gap-2">
                    <Link
                        href={homeHref}
                        aria-label={t('home')}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors max-sm:h-10 max-sm:w-10 max-sm:justify-center max-sm:px-0 max-sm:py-0 ${PHONE_TARGET}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
                            <path d="M3 9.5L10 3l7 6.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1V9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="hidden sm:inline">{t('home')}</span>
                    </Link>
                    {/* Report a problem. Icon-only on phones: this bar is one
                        row that cannot wrap, and signed in it already holds
                        five controls. The name is always the full phrase. */}
                    <ReportEntryButton compact />
                    {/* Language toggle */}
                    <Link
                        href={pathname}
                        locale={otherLocale}
                        className={`px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors border border-[var(--jale-divider)] max-sm:inline-flex max-sm:h-10 max-sm:items-center max-sm:px-2.5 max-sm:py-0 ${PHONE_LANGUAGE_PILL}`}
                    >
                        <span lang={otherLocale} className="max-[360px]:sr-only">
                            {t('language_toggle')}
                        </span>
                        <span aria-hidden="true" className="hidden max-[360px]:inline">
                            {otherLocale.toUpperCase()}
                        </span>
                    </Link>

                    <ThemeToggle />

                    {isAuthenticated && (
                        <>
                            {/* Profile avatar link. This header has no profile fetch,
                                so the role letter IS the content — passed as the
                                fallback rather than faked into a name. */}
                            <Link
                                href={userType === 'worker' ? '/worker/profile' : '/employer/profile'}
                                aria-label={t('profile')}
                                className={`inline-flex rounded-xl focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-sm:h-10 max-sm:w-10 max-sm:items-center max-sm:justify-center ${PHONE_TARGET}`}
                            >
                                <InitialsAvatar
                                    name=""
                                    fallback={userType === 'worker' ? 'W' : 'E'}
                                    size={34}
                                    square
                                />
                            </Link>
                            {/* Phones: the same button, handler and loading state as an
                                icon, named by the same copy. An empty loading label, so
                                no "Loading..." width is reserved. */}
                            <span className="inline-flex sm:hidden">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleSignOut}
                                    loading={signingOut}
                                    loadingLabel=""
                                    aria-label={t('sign_out')}
                                    title={t('sign_out')}
                                    className={`h-10 w-10 !px-0 ${PHONE_TARGET}`}
                                >
                                    <LogOut aria-hidden="true" className="h-4 w-4" />
                                </Button>
                            </span>
                            <span className="hidden sm:inline-flex">
                                <Button variant="outline" size="sm" onClick={handleSignOut} loading={signingOut} loadingLabel={tCommon('loading')}>
                                    {t('sign_out')}
                                </Button>
                            </span>
                        </>
                    )}
                </div>
            </div>
        </header>
    );
}
