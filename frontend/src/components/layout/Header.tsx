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
    const { isAuthenticated, logout } = useAuth();

    return (
        <header className="sticky top-0 z-10 border-b bg-background">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
                <Link href="/" className="text-lg font-semibold tracking-tight">
                    Jale
                </Link>
                <div className="flex items-center gap-3">
                    <Link
                        href={pathname}
                        locale={otherLocale}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {t('language_toggle')}
                    </Link>
                    {isAuthenticated && (
                        <Button variant="outline" size="sm" onClick={logout}>
                            {t('sign_out')}
                        </Button>
                    )}
                </div>
            </div>
        </header>
    );
}
