'use client';
import type { CSSProperties, ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';

type AuthShellProps = {
    variant: 'worker' | 'employer';
    brand?: ReactNode; // employer: proof panel content (headline, 2.4x, bullets)
    children: ReactNode; // the form
};

// Navy + dot pattern, matching the "1a Bold" landing.
const NAVY = '#181855';
const DOT_PATTERN: CSSProperties = {
    backgroundColor: NAVY,
    backgroundImage: 'radial-gradient(circle, rgba(120,164,255,.16) 1px, transparent 1px)',
    backgroundSize: '24px 24px',
};
const WORDMARK_SHADOW: CSSProperties = { filter: 'drop-shadow(0 2px 8px rgba(1,121,255,.3))' };
// A class (specificity 0,1,0) beats globals.css's unlayered `a { color: inherit }`
// (0,0,1), so anchor color applies AND :hover works — inline styles would kill hover.
const LINK_CSS = '.jale-auth-link{color:rgba(255,255,255,.72);transition:color .15s}.jale-auth-link:hover{color:#fff}';

function LanguageToggle() {
    const locale = useLocale();
    const pathname = usePathname();
    const t = useTranslations('auth.shell');
    const otherLocale = locale === 'en' ? 'es' : 'en';
    return (
        <Link
            href={pathname}
            locale={otherLocale}
            className="jale-auth-link inline-flex min-h-[40px] items-center justify-center rounded-full border border-white/20 px-3 py-1.5 text-sm font-semibold"
        >
            {t('language_toggle')}
        </Link>
    );
}

function BackToHome() {
    const t = useTranslations('auth.shell');
    return (
        <Link
            href="/"
            className="jale-auth-link inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold"
        >
            <span aria-hidden="true">&larr;</span>
            {t('back_home')}
        </Link>
    );
}

function ShellActions() {
    return (
        <div className="flex items-center gap-1 sm:gap-2">
            <style>{LINK_CSS}</style>
            <BackToHome />
            <LanguageToggle />
        </div>
    );
}

function Wordmark({ className = 'h-9' }: { className?: string }) {
    return (
        <Link href="/" className="inline-flex min-h-[44px] items-center" aria-label="Jale">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/wordmark-white.png" alt="Jale" className={`${className} w-auto`} style={WORDMARK_SHADOW} />
        </Link>
    );
}

export function AuthShell({ variant, brand, children }: AuthShellProps) {
    const t = useTranslations('auth');

    if (variant === 'worker') {
        return (
            <div className="flex min-h-screen flex-col" style={DOT_PATTERN}>
                <div className="flex items-center justify-between px-5 py-4 md:px-8">
                    <Wordmark />
                    <ShellActions />
                </div>
                <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 md:py-12">
                    <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-[0_10px_40px_rgba(0,0,0,.28)] md:p-8">
                        {children}
                    </div>
                </div>
            </div>
        );
    }

    // employer
    return (
        <div className="flex min-h-screen flex-col lg:flex-row">
            {/* Desktop brand panel (lg+) */}
            <aside
                className="hidden flex-col p-10 lg:flex lg:w-[44%]"
                style={DOT_PATTERN}
            >
                <div className="flex items-center justify-between">
                    <Wordmark className="h-10" />
                    <ShellActions />
                </div>
                <div className="flex flex-1 flex-col justify-center pb-8">{brand}</div>
            </aside>

            {/* Mobile navy header band (below lg) */}
            <div className="lg:hidden" style={DOT_PATTERN}>
                <div className="flex items-center justify-between px-5 py-4">
                    <Wordmark />
                    <ShellActions />
                </div>
                <p className="px-5 pb-5 text-lg font-bold leading-tight text-white">{t('employer.hero')}</p>
            </div>

            {/* White form column */}
            <div className="flex flex-1 flex-col overflow-y-auto bg-white">
                <div className="flex flex-1 flex-col justify-center px-8 py-10 md:px-12">
                    <div className="w-full max-w-lg">{children}</div>
                </div>
            </div>
        </div>
    );
}

export default AuthShell;
