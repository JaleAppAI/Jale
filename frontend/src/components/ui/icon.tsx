import * as React from 'react';

/**
 * Shared icon set. Extracted verbatim from the employer dashboard's inline
 * `Icon` component so every logged-in surface draws from one canonical set.
 *
 * `home` was added for the AppShell top-bar / worker nav; every other glyph
 * matches the dashboard's originals 1:1.
 *
 * `check` / `alert` / `x` / `wifi-off` were added for the feedback surfaces
 * (toast tones, error states, dismiss buttons), drawn to the same recipe:
 * 18x18, a 24-unit viewBox, `currentColor` at stroke-width 1.8, round joins.
 */
export type IconName =
    | 'grid'
    | 'briefcase'
    | 'message'
    | 'user'
    | 'bell'
    | 'search'
    | 'spark'
    | 'chart'
    | 'clock'
    | 'plus'
    | 'home'
    | 'eye'
    | 'upload'
    | 'trash'
    | 'check'
    | 'alert'
    | 'x'
    | 'wifi-off';

export function Icon({ name }: { name: IconName }) {
    const common = {
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

    switch (name) {
        case 'briefcase':
            return <svg {...common}><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M4 7h16v12H4z" /><path d="M4 12h16" /></svg>;
        case 'message':
            return <svg {...common}><path d="M5 6h14v9H8l-3 3z" /></svg>;
        case 'user':
            return <svg {...common}><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
        case 'bell':
            return <svg {...common}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></svg>;
        case 'search':
            return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
        case 'spark':
            return <svg {...common}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></svg>;
        case 'chart':
            return <svg {...common}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-3" /></svg>;
        case 'clock':
            return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>;
        case 'plus':
            return <svg {...common}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
        case 'home':
            return <svg {...common}><path d="M4 10.5 12 4l8 6.5" /><path d="M6 9.5V20h12V9.5" /></svg>;
        case 'eye':
            return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
        case 'upload':
            return <svg {...common}><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>;
        case 'trash':
            return <svg {...common}><path d="M4 7h16" /><path d="M8 7V4h8v3" /><path d="M6 7l1 13h10l1-13" /></svg>;
        case 'check':
            return <svg {...common}><path d="m5 12.5 4.5 4.5L19 7" /></svg>;
        // Circle-exclaim rather than a triangle: `search` and `clock` already
        // set this set's "round container" aesthetic.
        case 'alert':
            return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5" /><path d="M12 16h.01" /></svg>;
        case 'x':
            return <svg {...common}><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>;
        case 'wifi-off':
            return <svg {...common}><path d="m3 3 18 18" /><path d="M2 8.8a15 15 0 0 1 5.6-3.2" /><path d="M16.4 5.6A15 15 0 0 1 22 8.8" /><path d="M5 12.4a10 10 0 0 1 3.2-2" /><path d="M15.8 10.4a10 10 0 0 1 3.2 2" /><path d="M8.5 15.9a5 5 0 0 1 7 0" /><path d="M12 19.5h.01" /></svg>;
        default:
            return <svg {...common}><path d="M4 4h7v7H4z" /><path d="M13 4h7v7h-7z" /><path d="M4 13h7v7H4z" /><path d="M13 13h7v7h-7z" /></svg>;
    }
}
