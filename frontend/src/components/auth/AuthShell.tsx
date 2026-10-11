'use client';
import type { CSSProperties, ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, Link } from '@/i18n/navigation';

type AuthShellProps = {
    variant: 'worker' | 'employer';
    brand?: ReactNode; // employer: proof panel content (headline, 2.4x, bullets)
    children: ReactNode; // the form
};

/*
 * ===== BRAND SURFACE ==================================================
 * The navy ground, its dot pattern and the white chrome sitting on it are the
 * Jale brand mark -- matching the "1a Bold" landing -- NOT a themed surface.
 * It renders IDENTICALLY in light and dark: a visitor meets the same brand
 * either way, and the auth pages are the first thing they ever see.
 *
 * That is why these are literals and not tokens. `--jale-blue-900` happens to
 * hold #181855 in both themes today, but a brand surface must be immune to
 * token drift: the day someone adds a `.dark` override for that ramp, a
 * tokenised panel would silently re-tint the brand. Literals cannot.
 *
 * This block is the ONLY sanctioned raw colour in this file. Everything the
 * brand panel does not cover -- the worker card, the employer form column --
 * is a themed surface and uses tokens.
 *
 * Contrast on this ground holds in both themes because the ground never moves:
 * white @72% (the header links) ~8.8:1, white @70% (brand body copy) ~8.4:1,
 * solid white ~17.8:1 -- all AA or better at the sizes used here.
 */
const BRAND_NAVY = '#181855';
const DOT_PATTERN: CSSProperties = {
    backgroundColor: BRAND_NAVY,
    backgroundImage: 'radial-gradient(circle, rgba(120,164,255,.16) 1px, transparent 1px)',
    backgroundSize: '24px 24px',
};
const WORDMARK_SHADOW: CSSProperties = { filter: 'drop-shadow(0 2px 8px rgba(1,121,255,.3))' };
// A class (specificity 0,1,0) beats globals.css's unlayered `a { color: inherit }`
// (0,0,1), so anchor color applies AND :hover works — inline styles would kill hover.
const LINK_CSS = '.jale-auth-link{color:rgba(255,255,255,.72);transition:color .15s}.jale-auth-link:hover{color:#fff}';

/*
 * ===== THEMED SURFACE =================================================
 * The card (worker) and the form column (employer) are ordinary app surfaces
 * and follow the tokens, so they flip with the theme like every other panel.
 *
 * The divider border is load-bearing rather than decorative: in the dark theme
 * `--jale-card` (#161b44) and the brand navy (#181855) sit ~1.02:1 apart, so
 * without an edge the card would dissolve into the ground. `--jale-divider`
 * lifts that seam to ~1.35:1 in dark and stays a quiet hairline in light.
 *
 * `--shadow-modal`, not `--shadow-card`: this surface floats over a dark brand
 * ground exactly the way a modal panel floats over its scrim, and the modal
 * token is the one tuned for that (and deepened again under `.dark`).
 *
 * Fill + edge COLOUR only; each surface picks its own border sides.
 */
const SURFACE = 'border-[var(--jale-divider)] bg-[var(--jale-card)]';

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
    if (variant === 'worker') {
        return (
            <div className="flex min-h-screen flex-col" style={DOT_PATTERN}>
                {/* Hoisted to the shell root: the employer variant renders
                    ShellActions twice (desktop aside + mobile band), and the
                    stylesheet only ever needs to exist once per page. */}
                <style>{LINK_CSS}</style>
                <div className="flex items-center justify-between px-5 py-4 md:px-8">
                    <Wordmark />
                    <ShellActions />
                </div>
                <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 md:py-12">
                    <div className={`w-full max-w-md rounded-[var(--radius-card)] border ${SURFACE} p-6 shadow-[var(--shadow-modal)] md:p-8`}>
                        {children}
                    </div>
                </div>
            </div>
        );
    }

    // employer
    return (
        <div className="flex min-h-screen flex-col lg:flex-row">
            <style>{LINK_CSS}</style>

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
            </div>

            {/* Form column. Border only on the seam it actually shares with the
                brand panel: the top edge while stacked, the left edge once the
                split goes side-by-side. */}
            <div className={`flex flex-1 flex-col overflow-y-auto border-t lg:border-t-0 lg:border-l ${SURFACE}`}>
                <div className="flex flex-1 flex-col justify-center px-8 py-10 md:px-12">
                    <div className="w-full max-w-lg">{children}</div>
                </div>
            </div>
        </div>
    );
}

export default AuthShell;
