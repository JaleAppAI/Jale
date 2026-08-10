'use client';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';

/*
 * BRAND SURFACE. This nav is the top of the navy marketing band and stays navy
 * in BOTH themes -- it is the first thing a visitor sees and it has to look the
 * same in every screenshot, ad and share card.
 *
 * That is a token decision, not an excuse for hexes: `--jale-blue-500/600/800/
 * 900/950` are the brand-ramp tokens the dark theme deliberately does NOT
 * re-point (unlike `--jale-blue-50/700`, which flip for app chrome), so naming
 * them here keeps the file token-only AND keeps the band fixed. White and
 * white-alpha values are the navy band's own ink and are likewise stable.
 */

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
        'inline-flex min-h-[44px] items-center justify-center rounded-full border border-[var(--jale-blue-500)]/30 bg-[var(--jale-blue-500)]/20 px-4 text-sm font-semibold transition-colors hover:bg-[var(--jale-blue-500)]/30';
    // globals.css has an unlayered `a { color: inherit }` that beats Tailwind
    // text-* utilities on anchors, so anchor colors are set inline.
    //
    // White, not brand blue: brand blue on a 20%-blue-over-navy pill measures
    // ~3.0:1, under the 4.5:1 these 14px labels need. White is ~12.9:1 on the
    // same fill, and it is also the only colour that survives if a browser
    // without `color-mix()` falls back to rendering the fill fully opaque.
    const loginPillStyle = { color: '#fff' };

    return (
        <nav className="bg-[var(--jale-blue-900)] px-5 py-4 md:px-8 md:py-[18px]">
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
                        className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--jale-blue-500)] px-[18px] text-sm font-semibold shadow-[var(--shadow-btn)] transition-colors hover:bg-[var(--jale-blue-600)]"
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
