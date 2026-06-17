'use client';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

export function Header() {
    const locale = useLocale();
    const pathname = usePathname();
    const t = useTranslations('header');
    const tCommon = useTranslations('common');
    const otherLocale = locale === 'en' ? 'es' : 'en';
    const { isAuthenticated, logout, userType } = useAuth();
    const [signingOut, setSigningOut] = useState(false);

    if (pathname === '/employer/dashboard' || pathname.endsWith('/employer/dashboard')) {
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
        <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-white/90 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
                {/* Wordmark */}
                <Link href="/" className="jale-wordmark">
                    Jale
                </Link>

                {/* Nav + actions */}
                <div className="flex items-center gap-2">
                    <Link
                        href={homeHref}
                        aria-label={t('home')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors"
                    >
                        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
                            <path d="M3 9.5L10 3l7 6.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1V9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="hidden sm:inline">{t('home')}</span>
                    </Link>
                    {isAuthenticated && userType === 'worker' && (
                        <nav className="hidden sm:flex items-center gap-1 mr-2">
                            <Link
                                href="/worker/home"
                                className="px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors"
                            >
                                {t('worker_home')}
                            </Link>
                            <Link
                                href="/worker/applications"
                                className="px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors"
                            >
                                {t('my_applications')}
                            </Link>
                        </nav>
                    )}
                    {isAuthenticated && userType === 'employer' && (
                        <nav className="hidden sm:flex items-center gap-1 mr-2">
                            <Link
                                href="/employer/dashboard"
                                className="px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors"
                            >
                                {t('employer_jobs')}
                            </Link>
                            <Link
                                href="/employer/conversations"
                                className="px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors"
                            >
                                {t('messages')}
                            </Link>
                        </nav>
                    )}

                    {/* Language toggle */}
                    <Link
                        href={pathname}
                        locale={otherLocale}
                        className="px-3 py-1.5 rounded-full text-sm font-semibold text-[var(--jale-ink-2)] hover:bg-[var(--jale-blue-50)] hover:text-[var(--jale-blue-700)] transition-colors border border-[var(--jale-divider)]"
                    >
                        {t('language_toggle')}
                    </Link>

                    {isAuthenticated && (
                        <>
                            {/* Profile avatar link */}
                            <Link
                                href={userType === 'worker' ? '/worker/profile' : '/employer/profile'}
                                aria-label={t('profile')}
                                className="avatar-initials square"
                                style={{ width: 34, height: 34 }}
                            >
                                {userType === 'worker' ? 'W' : 'E'}
                            </Link>
                            <Button variant="outline" size="sm" onClick={handleSignOut} loading={signingOut} loadingLabel={tCommon('loading')}>
                                {t('sign_out')}
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </header>
    );
}
