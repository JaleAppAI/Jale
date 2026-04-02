'use client';
import { useLocale } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation'; // or next-intl/navigation

export function Header() {
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';
    const label = locale === 'en' ? 'Español' : 'English';

    return (
        <header>
            <Link href={pathname} locale={otherLocale}>{label}</Link>
        </header>
    );
}
