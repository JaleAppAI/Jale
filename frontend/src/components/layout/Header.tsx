'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';

export function Header() {
    const locale = useLocale();
    const pathname = usePathname();
    const t = useTranslations('header');
    const otherLocale = locale === 'en' ? 'es' : 'en';
    const { isAuthenticated, logout, userType } = useAuth();

    return (
        <header className="sticky top-0 z-10 border-b border-[var(--jale-divider)] bg-white/90 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
                {/* Wordmark */}
                <Link href="/" className="jale-wordmark">
                    Jale
                </Link>

                {/* Nav + actions */}
                <div className="flex items-center gap-2">
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
                                Jobs
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
                            <Button variant="outline" size="sm" onClick={logout}>
                                {t('sign_out')}
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </header>
    );
}
