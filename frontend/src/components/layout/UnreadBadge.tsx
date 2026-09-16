'use client';

import { useTranslations } from 'next-intl';

/**
 * The unread-message count, as a pill on a nav item (sprint 26, B3).
 *
 * One component for both rails so the two can never disagree about the cap,
 * the zero case or how the number is announced; only the palette differs,
 * because one pill sits on the navy sidebar and the other on the light tab
 * bar.
 *
 * Three rules it owns:
 *
 *  - ZERO renders nothing. A "0" pill is a badge saying there is no news,
 *    which is exactly the thing a badge is supposed to mean the absence of.
 *  - The PRINTED number is capped at "99+" (three characters is what the rail
 *    can hold without the label wrapping), but the ANNOUNCED one is the real
 *    count. The cap is a width constraint, not a fact, and "99+ unread
 *    messages" would be a second inaccuracy stacked on the first.
 *  - The announcement is `sr-only` text rather than an `aria-label` on the
 *    pill: a bare <span> with an `aria-label` and no role is not reliably
 *    exposed by screen readers, and the text sits INSIDE the nav link, so it
 *    is read as part of the link's name ("Messages, 3 unread messages").
 */

const DISPLAY_CAP = 99;

export type UnreadBadgeTone = 'rail' | 'bar';

const TONE_CLASS: Record<UnreadBadgeTone, string> = {
    // On the navy sidebar: the brand blue is already the ACTIVE pill's colour
    // there, so the badge uses white-on-navy's counterpart instead and stays
    // legible on both the active and the idle row.
    rail: 'bg-white text-[var(--jale-sidebar)]',
    bar: 'bg-[var(--jale-blue-700)] text-white',
};

export function UnreadBadge({ count, tone }: { count: number; tone: UnreadBadgeTone }) {
    const t = useTranslations('employer_dashboard');
    if (count <= 0) return null;

    const printed = count > DISPLAY_CAP ? `${DISPLAY_CAP}+` : String(count);

    return (
        <span
            className={[
                'inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5',
                'text-[10px] font-extrabold leading-4 tabular-nums',
                TONE_CLASS[tone],
            ].join(' ')}
        >
            <span aria-hidden="true">{printed}</span>
            <span className="sr-only">{t('nav.unread_badge', { count })}</span>
        </span>
    );
}
