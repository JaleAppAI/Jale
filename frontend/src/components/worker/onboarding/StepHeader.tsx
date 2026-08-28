'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    MAX_ANSWER_CHARS,
    MAX_CUSTOM_TRADE_CHARS,
    MIN_ANSWER_CHARS,
    MIN_CUSTOM_TRADE_CHARS,
    PROGRESS_SEGMENTS,
    type ScreenKey,
} from '@/lib/onboarding-flow';

/**
 * The chrome every onboarding screen shares: a back link and step counter on
 * one line, then an optional eyebrow, the heading and its subtitle.
 *
 * The heading recipe (1.4rem / 800 / -0.03em) is `AuthHeading`'s, deliberately:
 * a worker walks straight out of `WorkerAuthForm` into this flow and the
 * headline must not change size or weight under them mid-journey.
 *
 * FOCUS MOVES TO THE HEADING on every step change. Nothing navigates here --
 * the URL is the same eight screens deep -- so a screen reader would otherwise
 * announce nothing at all when Continue swapped the entire page, and a keyboard
 * user would be left tabbing from wherever the old Continue button was.
 * `tabIndex={-1}` makes the h1 focusable programmatically without adding it to
 * the tab order.
 */
export function StepHeader({
    screen,
    title,
    subtitle,
    eyebrow,
    counterLabel,
    onBack,
    backDisabled = false,
}: {
    screen: ScreenKey;
    title: string;
    subtitle?: string;
    eyebrow?: string;
    /** Overrides the "3 / 8" counter — the questions show "Question 2 of 3" instead. */
    counterLabel?: string;
    /** `null` on the first screen and on the summary: there is nowhere to go back to. */
    onBack: (() => void) | null;
    backDisabled?: boolean;
}) {
    const t = useTranslations('worker_onboarding');
    const headingRef = useRef<HTMLHeadingElement>(null);
    const index = (PROGRESS_SEGMENTS as readonly ScreenKey[]).indexOf(screen);

    useEffect(() => {
        headingRef.current?.focus();
    }, [screen]);
    const counter = counterLabel
        ?? (index >= 0 ? t('progress.counter', { current: index + 1, total: PROGRESS_SEGMENTS.length }) : '');

    return (
        <>
            <div className="mb-2 flex min-h-[28px] items-center justify-between">
                {onBack ? (
                    <button
                        type="button"
                        onClick={onBack}
                        disabled={backDisabled}
                        className="flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent p-0 text-sm font-medium text-[var(--jale-ink-2)] transition-colors hover:text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <span aria-hidden="true">&larr;</span> {t('common.back')}
                    </button>
                ) : (
                    <span />
                )}
                {counter ? <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--jale-ink-2)]">{counter}</span> : null}
            </div>

            {eyebrow ? (
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--jale-ink-2)]">{eyebrow}</p>
            ) : null}
            <h1
                ref={headingRef}
                tabIndex={-1}
                className="mb-2 mt-1.5 text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
                {title}
            </h1>
            {subtitle ? <p className="mb-[18px] text-[15px] font-light text-[var(--jale-ink-2)]">{subtitle}</p> : null}
        </>
    );
}

/** One screen: header, a growing body, and a footer pinned to the bottom. */
export function StepLayout({ children }: { children: ReactNode }) {
    return <div className="anim-fade-in flex flex-1 flex-col">{children}</div>;
}

export function StepBody({ children }: { children: ReactNode }) {
    return <div className="flex flex-1 flex-col gap-[18px]">{children}</div>;
}

export function StepFooter({ children }: { children: ReactNode }) {
    return <div className="mt-[22px] flex flex-col gap-2.5">{children}</div>;
}

/** Uppercase field label, matching `WorkerAuthForm`'s `Field`. */
export function StepField({ label, htmlFor, children, error, errorId }: {
    label: string;
    htmlFor?: string;
    children: ReactNode;
    error?: string | null;
    /** Wire this onto the control's `aria-describedby` so the error is read with it. */
    errorId?: string;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={htmlFor} className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
                {label}
            </label>
            {children}
            {error ? <p id={errorId} role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p> : null}
        </div>
    );
}

/**
 * The quiet way out, shown under the error once saving has failed twice in a
 * row. `null` the rest of the time, which is nearly always.
 */
export type ExitLink = ReactNode | null;

export function StepHint({ children }: { children: ReactNode }) {
    return <p className="text-[13px] text-[var(--jale-ink-2)]">{children}</p>;
}

/**
 * The bounds each rejected step is measured against. A `too_short` on a trust
 * answer and a `too_short` on a typed-in trade are the same CODE and wildly
 * different numbers, so the sentence cannot be written without knowing which
 * field the engine was talking about.
 */
const STEP_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
    'profile.custom_trade': { min: MIN_CUSTOM_TRADE_CHARS, max: MAX_CUSTOM_TRADE_CHARS },
};
const DEFAULT_BOUNDS = { min: MIN_ANSWER_CHARS, max: MAX_ANSWER_CHARS };

/**
 * Turns a 422's `reason` into a sentence.
 *
 * The engine's reasons are CODES (`too_short`, `too_long`, `invalid`, ...),
 * not copy, and this app's standing rule is that no backend string is ever
 * rendered raw (see `useErrorMessage`). A code we have copy for is translated;
 * anything else falls back to one reviewed sentence, so a code the backend
 * grows tomorrow degrades to a real sentence instead of leaking an identifier
 * onto the screen.
 *
 * The same code means different things on different fields, so the lookup is
 * two-deep and the FIELD wins:
 *
 *   worker_onboarding.rejection.reason.<field>.<code>   e.g. custom_trade.too_short
 *   worker_onboarding.rejection.reason.<code>           the shared wording
 *   worker_onboarding.rejection.generic                 anything unrecognised
 *
 * `<field>` is the step key's last segment, so giving a new field its own
 * wording is a catalogue entry and no code at all.
 *
 * The bounds are passed to every lookup because the length reasons name them;
 * a message without those placeholders simply ignores them.
 */
export function useRejectionMessage(): (reason: string, stepKey?: string) => string {
    const t = useTranslations('worker_onboarding.rejection');
    return (reason: string, stepKey?: string) => {
        const field = stepKey ? stepKey.split('.').pop() : undefined;
        const values = (stepKey && STEP_BOUNDS[stepKey]) || DEFAULT_BOUNDS;
        const fieldKey = field ? `reason.${field}.${reason}` : null;
        if (fieldKey && t.has(fieldKey)) return t(fieldKey, values);
        const sharedKey = `reason.${reason}`;
        return t.has(sharedKey) ? t(sharedKey, values) : t('generic');
    };
}
