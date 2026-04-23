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
        <header className="sticky top-0 z-10 border-b border-border/50 bg-card/80 backdrop-blur-md">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
                <Link href="/" className="text-lg font-bold tracking-tight">
                    Jale
                </Link>
                <div className="flex items-center gap-3">
                    <Link
                        href={pathname}
                        locale={otherLocale}
                        className="text-sm text-muted hover:text-foreground transition-colors"
                    >
                        {t('language_toggle')}
                    </Link>
                    {isAuthenticated && (
                        <>
                            {userType === 'employer' && (
                                <Link
                                    href="/employer/profile"
                                    aria-label={t('profile')}
                                    className="text-muted hover:text-foreground transition-colors"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                                        <circle cx="12" cy="7" r="4"/>
                                    </svg>
                                </Link>
                            )}
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
