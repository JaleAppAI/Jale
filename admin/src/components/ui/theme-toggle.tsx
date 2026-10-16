'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Light/dark theme switch (copied from the Jale app).
 *
 * The theme is one class on `<html>`: `globals.css` defines the dark palette
 * under `.dark`. The initial class is applied by `public/theme-init.js`,
 * loaded first in `<head>`, so no page paints in the wrong theme. This module
 * owns only the flip and the saved choice.
 *
 * `localStorage[THEME_STORAGE_KEY]` holds an explicit choice ('dark' or
 * 'light'); its absence means "follow the OS". The admin key differs from the
 * app's, so the two apps keep separate choices on a shared browser.
 */
export const THEME_STORAGE_KEY = 'jale-admin-theme';

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

/**
 * The theme state and its flip. Starts `false` on the server AND on the first
 * client render, so hydration matches; the effect then reads the class the
 * init script already applied.
 */
export function useThemeToggle(): { isDark: boolean; toggle: () => void } {
    const [isDark, setIsDark] = useState(false);

    useEffect(() => {
        setIsDark(document.documentElement.classList.contains('dark'));
    }, []);

    const toggle = useCallback(() => {
        // Read the DOM, not the state: the class is the real theme.
        const next = !document.documentElement.classList.contains('dark');
        document.documentElement.classList.toggle('dark', next);
        setIsDark(next);
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
        } catch {
            // Storage blocked: the theme still changes for this page view.
        }
    }, []);

    return { isDark, toggle };
}

export function ThemeToggle({ className = '' }: { className?: string }) {
    const { isDark, toggle } = useThemeToggle();
    const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

    return (
        <button
            type="button"
            onClick={toggle}
            aria-pressed={isDark}
            aria-label={label}
            title={label}
            className={[
                // A 40px box with a 44px pointer target from the ::after overlay.
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
