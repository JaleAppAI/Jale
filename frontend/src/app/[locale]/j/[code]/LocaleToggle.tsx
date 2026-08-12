'use client';

import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { localeSwitchHref } from '@/lib/locale-switch';

interface LocaleToggleProps {
  /** The current page's path WITHOUT its locale prefix, e.g. `/j/ABC123`.
   * next-intl's `Link` prepends the prefix for `otherLocale` itself. */
  path: string;
  otherLocale: string;
  /** Names the OTHER language, in that language ("Español" / "English"), so
   * the label is legible to exactly the reader it is for. Passed down from the
   * page, which already has `getTranslations` in scope -- same arrangement as
   * `WebApplyButton`, so this island needs no i18n hook of its own. */
  label: string;
}

/**
 * BRAND SURFACE pill. This sits on the page's navy band, which is
 * `--jale-blue-900` in both themes, so its ink is white-alpha rather than an
 * `--jale-ink` token -- the same exception `LandingNav` and `Sidebar` take on
 * their own navy surfaces, and the same 85%-white / 20%-white-border /
 * 10%-white-hover values `LandingNav`'s language toggle already uses.
 *
 * `text-white/85` is a utility rather than an inline style: globals.css's
 * `a { color: inherit }` lives inside `@layer base`, and the utilities layer
 * is declared after base, so a utility on the anchor wins the cascade. (The
 * inline `color` on this page's closed-branch CTA predates that fix.)
 *
 * `min-h-[40px]` because this is a tap target on the phone of someone who just
 * opened a link in WhatsApp -- it matches `AuthShell`'s compact toggle rather
 * than shrinking to the 28px of the wordmark beside it. `shrink-0` +
 * `whitespace-nowrap` keep "Español" on one line on a 320px screen.
 */
const LOCALE_PILL = [
  'inline-flex min-h-[40px] shrink-0 items-center justify-center whitespace-nowrap',
  'rounded-full border border-white/20 px-3.5 text-sm font-semibold text-white/85',
  'transition-colors hover:bg-white/10',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
].join(' ');

/**
 * Suspense fallback for the toggle -- and, unlike this page's other three
 * fallbacks, NOT a skeleton.
 *
 * `LocaleToggle` below reads `useSearchParams()`, which opts it out of a static
 * render, so on any render where the boundary falls back -- and for a visitor
 * whose JavaScript never runs -- this block is the toggle. A grey rectangle
 * there would leave a Spanish speaker on an `/en/` link with nothing to press,
 * which is the exact failure this component exists to fix. So the fallback is
 * the SAME pill with the same label and the same box, pointing at the same page
 * in the other locale -- a working link, just without the query string.
 * Hydration only upgrades the href; nothing moves and nothing appears.
 *
 * The lost `?r=` in that pre-hydration window costs nothing real: every
 * consumer of the share tag on the destination page (`ReferralContext`,
 * `ApplyButton`, `WebApplyButton`) is itself client-side, so a visit that
 * cannot run JavaScript could not have attributed the referral either way.
 */
export function LocaleToggleFallback({ path, otherLocale, label }: LocaleToggleProps) {
  return (
    <Link href={path} locale={otherLocale} lang={otherLocale} className={LOCALE_PILL}>
      {label}
    </Link>
  );
}

/**
 * The page's only way to change language: it renders its own navy band instead
 * of the global `Header` (which is suppressed on `/j` so the page does not
 * stack two wordmarks), and the global Header was where the language toggle
 * used to live. A shared link is one URL for both audiences, so the Spanish
 * speaker who is handed an `/en/j/...` link needs this to be on the page
 * itself.
 *
 * Reads the share tag via `useSearchParams` rather than from the page's
 * `searchParams` prop, because nothing server-side on this route may touch
 * searchParams -- doing so forces dynamic rendering and defeats the
 * `revalidate = 60` ISR the page is built around. `lang` is set on the anchor
 * because the label is written in the language being switched TO, and a
 * screen reader should not read "Español" with English phonemes.
 */
export function LocaleToggle({ path, otherLocale, label }: LocaleToggleProps) {
  const searchParams = useSearchParams();

  return (
    <Link
      href={localeSwitchHref(path, searchParams.toString())}
      locale={otherLocale}
      lang={otherLocale}
      className={LOCALE_PILL}
    >
      {label}
    </Link>
  );
}
