'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Light/dark theme switch.
 *
 * The theme itself is one class on `<html>`: `globals.css` defines the whole
 * dark palette under `.dark`, so flipping the class re-tints every token at
 * once. This button owns only the flip and the preference that survives a
 * reload; the *initial* class is applied by the blocking script in
 * `[locale]/layout.tsx` (see THEME_INIT_SCRIPT) so the page never paints in the
 * wrong theme first.
 *
 * `localStorage['jale-theme']` is the single source of truth for an explicit
 * choice. Its absence means "follow the OS", which is why this component
 * always writes a value: once the user has pressed the button, we stop
 * guessing.
 */

const STORAGE_KEY = 'jale-theme';

const glyph = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
};

function MoonGlyph() {
    return (
        <svg {...glyph}>
            <path d="M20 14.4A8.5 8.5 0 0 1 9.6 4 8.5 8.5 0 1 0 20 14.4Z" />
        </svg>
    );
}

function SunGlyph() {
    return (
        <svg {...glyph}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2" />
            <path d="M12 19.5v2" />
            <path d="M4.9 4.9l1.4 1.4" />
            <path d="m17.7 17.7 1.4 1.4" />
            <path d="M2.5 12h2" />
            <path d="M19.5 12h2" />
            <path d="m4.9 19.1 1.4-1.4" />
            <path d="m17.7 6.3 1.4-1.4" />
        </svg>
    );
}

export function ThemeToggle({ className = '' }: { className?: string }) {
    const t = useTranslations('common');

    // Starts `false` on BOTH the server and the first client render, which is
    // what keeps hydration byte-identical: the server has no `document`, and
    // reading the real class during render would disagree with it. The effect
    // below then syncs to whatever the init script already applied.
    const [isDark, setIsDark] = useState(false);

    useEffect(() => {
        setIsDark(document.documentElement.classList.contains('dark'));
    }, []);

    const toggle = useCallback(() => {
        // Read from the DOM, not from state: the class is the real theme, and
        // this stays correct even if something else flipped it.
        const next = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', next);
        setIsDark(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
        } catch {
            // Storage disabled (private mode, blocked cookies). The theme still
            // changes for this page view; it just will not survive a reload.
        }
    }, []);

    const label = isDark ? t('theme.toggle_to_light') : t('theme.toggle_to_dark');

    return (
        <button
            type="button"
            onClick={toggle}
            aria-pressed={isDark}
            aria-label={label}
            title={label}
            className={[
                // 40px box keeps the header actions row exactly the height it
                // already was; the ::after overlay grows the POINTER target to
                // the 44px minimum without touching layout.
                'relative inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center',
                'rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]',
                'transition-colors hover:bg-[var(--jale-paper-2)]',
                'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                className,
            ].join(' ')}
        >
            {isDark ? <SunGlyph /> : <MoonGlyph />}
        </button>
    );
}
