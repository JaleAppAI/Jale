import type { ReactNode } from 'react';
import { scoreBandForScore, type ScoreBand } from '@/lib/match';
import {
    applicationStatusTone,
    jobStatusTone,
    normalizeApplicationStatus,
    type ApplicationStatus,
    type JobStatus,
    type LegacyApplicationStatus,
} from '@/lib/status';

/**
 * The ONE status chip.
 *
 * The locked style has no tinted status pills: a badge is a small coloured dot
 * followed by muted text. Colour carries the state, the text carries the
 * meaning, and nothing paints a background — so a row of badges reads as one
 * calm list instead of a strip of confetti. Tinted backgrounds survive in
 * exactly two places (InlineFeedback and Toast), where the tint IS the message.
 *
 * Both themes come free: every dot colour is a `--jale-*` token, so `.dark`
 * re-tints them with the rest of the palette, and the label rides `--jale-ink-2`
 * like every other piece of secondary text.
 */

export type BadgeTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

/**
 * Tone -> dot colour. These stay literal Tailwind classes (not runtime strings)
 * so the JIT can see them; the values behind them are tokens.
 */
const toneDotClasses: Record<BadgeTone, string> = {
    info: 'bg-[var(--jale-blue-500)]',
    success: 'bg-[var(--jale-success)]',
    warning: 'bg-[var(--jale-warning)]',
    danger: 'bg-[var(--jale-danger)]',
    neutral: 'bg-[var(--jale-ink-2)]',
};

export function Badge({
    tone = 'neutral',
    dotClassName,
    className = '',
    children,
}: {
    tone?: BadgeTone;
    /** Override the dot colour when a caller needs a tone the palette lacks. */
    dotClassName?: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span
            className={[
                'inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-tight text-[var(--jale-ink-2)]',
                className,
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <span
                aria-hidden
                className={['size-[7px] shrink-0 rounded-full', dotClassName ?? toneDotClasses[tone]]
                    .filter(Boolean)
                    .join(' ')}
            />
            <span className="min-w-0">{children}</span>
        </span>
    );
}

/* ===== Tone adapters ==================================================== */

/**
 * `lib/status.ts` is the single source of truth for what a status *means*, and
 * it is read-only here. Rather than restating its status->colour table (which
 * would silently drift the first time someone edits it), these adapters call it
 * and translate the `dot` token it already returns into a BadgeTone.
 *
 * Only `dot` is consumed: `bg` is a tint the locked style no longer paints, and
 * `color` is tuned to sit on that tint — badge text is always ink-2.
 */
const dotTokenToTone: Record<string, BadgeTone> = {
    'var(--jale-success)': 'success',
    'var(--jale-blue-500)': 'info',
    'var(--jale-warning)': 'warning',
    'var(--jale-danger)': 'danger',
    'var(--jale-ink)': 'neutral',
    'var(--jale-ink-2)': 'neutral',
};

export function jobStatusBadgeTone(status: JobStatus): BadgeTone {
    return dotTokenToTone[jobStatusTone(status).dot] ?? 'neutral';
}

export function applicationStatusBadgeTone(
    status: ApplicationStatus | LegacyApplicationStatus,
): BadgeTone {
    return dotTokenToTone[applicationStatusTone(normalizeApplicationStatus(status)).dot] ?? 'neutral';
}

/** Match bands: strong reads as a win, good as informational, fair as a caveat. */
export function scoreBandBadgeTone(band: ScoreBand): BadgeTone {
    if (band === 'strong') return 'success';
    if (band === 'good') return 'info';
    return 'warning';
}

/** Same mapping for callers that hold a raw 0-100 score and no band. */
export function matchScoreBadgeTone(score: number): BadgeTone {
    return scoreBandBadgeTone(scoreBandForScore(score));
}

/* ===== Thin status wrappers ============================================= */

/*
 * The label stays a `children` slot on purpose: every status string is already
 * translated inside the page's own next-intl namespace, so these wrappers carry
 * the colour decision and nothing else.
 */

export function JobStatusBadge({ status, children }: { status: JobStatus; children: ReactNode }) {
    return <Badge tone={jobStatusBadgeTone(status)}>{children}</Badge>;
}

export function ApplicationStatusBadge({
    status,
    children,
}: {
    status: ApplicationStatus | LegacyApplicationStatus;
    children: ReactNode;
}) {
    return <Badge tone={applicationStatusBadgeTone(status)}>{children}</Badge>;
}
