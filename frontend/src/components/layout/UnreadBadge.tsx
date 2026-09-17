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

/*
 * Both pairs are stated here with their measured contrast, because a filled
 * pill is the one place in this app where a token swap between themes goes
 * unnoticed until somebody cannot read a number.
 *
 *  - `rail` sits on the navy sidebar and on the drawer's navy launcher. White
 *    ground with `--jale-sidebar` ink: 19.1:1 dark, 16.5:1 light. The brand
 *    blue is already the ACTIVE nav pill's colour on that rail, so the badge
 *    deliberately does not reuse it.
 *  - `bar` sits on light grounds (the mobile tab bar, the dashboard panel
 *    header). `--jale-blue-500` (#0064d6) with `--primary-fg` (#ffffff) is
 *    5.54:1 in BOTH themes: that token is deliberately not re-pointed in
 *    `.dark` (see globals.css -- "one blue in both themes"), which is exactly
 *    the property this pill needs.
 *
 * NOT `--jale-blue-700`, which this started as: `.dark` re-points it to
 * `#a8c5ff`, a LIGHT blue, and white on it is 1.74:1 -- a number nobody could
 * read on the two surfaces where this tone is used.
 */
const TONE_CLASS: Record<UnreadBadgeTone, string> = {
    rail: 'bg-white text-[var(--jale-sidebar)]',
    bar: 'bg-[var(--jale-blue-500)] text-[var(--primary-fg)]',
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
