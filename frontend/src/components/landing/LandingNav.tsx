'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

/** English/Spanish toggle styled for the navy landing nav. Labels the OTHER locale. */
function LangToggle({ className = '' }: { className?: string }) {
    const t = useTranslations('landing.nav');
    const locale = useLocale();
    const pathname = usePathname();
    const otherLocale = locale === 'en' ? 'es' : 'en';
    return (
        <Link
            href={pathname}
            locale={otherLocale}
            style={{ color: 'rgba(255,255,255,.85)' }}
            className={`min-h-[44px] items-center justify-center rounded-full border border-white/20 px-4 text-sm font-semibold transition-colors hover:bg-white/10 ${className}`}
        >
            {t('language_toggle')}
        </Link>
    );
}

/**
 * Landing-page nav (design "1a Bold"). The global Header suppresses itself on
 * the locale root, so this owns the wordmark, section anchors, logins, language
 * toggle, and the primary WhatsApp CTA (which scrolls to the #cta section).
 */
export function LandingNav() {
    const t = useTranslations('landing.nav');

    const loginPill =
        'inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(1,121,255,.3)] bg-[rgba(1,121,255,.2)] px-4 text-sm font-semibold text-[#0179FF] transition-colors hover:bg-[rgba(1,121,255,.3)]';
    // globals.css has an unlayered `a { color: inherit }` that beats Tailwind
    // text-* utilities on anchors, so anchor colors are set inline.
    const loginPillStyle = { color: '#0179FF' };

    return (
        <nav className="bg-[#181855] px-5 py-4 md:px-8 md:py-[18px]">
            <div className="flex items-center justify-between gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/brand/wordmark-white.png"
                    alt="Jale"
                    className="h-10 w-auto"
                    style={{ filter: 'drop-shadow(0 2px 8px rgba(1,121,255,.3))' }}
                />

                <div className="flex items-center gap-4 lg:gap-10">
                    <div className="hidden items-center gap-10 border-r border-white/10 pr-10 text-sm font-medium text-white/[.82] lg:flex">
                        <a href="#how-it-works" className="jale-link transition-colors">
                            {t('how')}
                        </a>
                        <a href="#for-workers" className="jale-link transition-colors">
                            {t('workers')}
                        </a>
                        <a href="#for-employers" className="jale-link transition-colors">
                            {t('employers')}
                        </a>
                    </div>

                    <div className="hidden gap-3 md:flex">
                        <Link href="/auth/worker" className={loginPill} style={loginPillStyle}>
                            {t('worker_login')}
                        </Link>
                        <Link href="/auth/employer" className={loginPill} style={loginPillStyle}>
                            {t('employer_login')}
                        </Link>
                    </div>

                    <LangToggle className="hidden md:inline-flex" />

                    <a
                        href="#cta"
                        style={{ color: '#fff' }}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[#0179FF] px-[18px] text-sm font-semibold text-white shadow-[0_4px_12px_rgba(1,121,255,.3)] transition-colors hover:bg-[#0064d6]"
                    >
                        {t('cta')}
                    </a>
                </div>
            </div>

            {/* Mobile row — language toggle + thumb-friendly login pills */}
            <div className="mt-3 flex gap-2 md:hidden">
                <LangToggle className="inline-flex" />
                <Link href="/auth/worker" className={`${loginPill} flex-1`} style={loginPillStyle}>
                    {t('worker_login')}
                </Link>
                <Link href="/auth/employer" className={`${loginPill} flex-1`} style={loginPillStyle}>
                    {t('employer_login')}
                </Link>
            </div>
        </nav>
    );
}
