'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';

export function Header() {
    const locale = useLocale();
    const pathname = usePathname();
    const t = useTranslations('header');
    const otherLocale = locale === 'en' ? 'es' : 'en';

    return (
        <header>
            <Link href={pathname} locale={otherLocale}>{t('language_toggle')}</Link>
        </header>
    );
}
