import * as React from 'react';

/**
 * Shared icon set. Extracted verbatim from the employer dashboard's inline
 * `Icon` component so every logged-in surface draws from one canonical set.
 *
 * `home` was added for the AppShell top-bar / worker nav; every other glyph
 * matches the dashboard's originals 1:1.
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
    | 'home';

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
        default:
            return <svg {...common}><path d="M4 4h7v7H4z" /><path d="M13 4h7v7h-7z" /><path d="M4 13h7v7H4z" /><path d="M13 13h7v7h-7z" /></svg>;
    }
}
