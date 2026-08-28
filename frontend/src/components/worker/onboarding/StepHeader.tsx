'use client';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PROGRESS_SEGMENTS, type ScreenKey } from '@/lib/onboarding-flow';

/**
 * The chrome every onboarding screen shares: a back link and step counter on
 * one line, then an optional eyebrow, the heading and its subtitle.
 *
 * The heading recipe (1.4rem / 800 / -0.03em) is `AuthHeading`'s, deliberately:
 * a worker walks straight out of `WorkerAuthForm` into this flow and the
 * headline must not change size or weight under them mid-journey.
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
    const index = (PROGRESS_SEGMENTS as readonly ScreenKey[]).indexOf(screen);
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
            <h1 className="mb-2 mt-1.5 text-[1.4rem] font-extrabold leading-tight tracking-[-0.03em] text-[var(--jale-ink)]">
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
export function StepField({ label, htmlFor, children, error }: {
    label: string;
    htmlFor?: string;
    children: ReactNode;
    error?: string | null;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={htmlFor} className="text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">
                {label}
            </label>
            {children}
            {error ? <p role="alert" className="text-xs font-semibold text-[var(--jale-danger)]">{error}</p> : null}
        </div>
    );
}

export function StepHint({ children }: { children: ReactNode }) {
    return <p className="text-[13px] text-[var(--jale-ink-2)]">{children}</p>;
}

/**
 * Turns a 422's `reason` into a sentence.
 *
 * The engine's reasons are CODES, not copy, and this app's standing rule is
 * that no backend string is ever rendered raw (see `useErrorMessage`). A code
 * we have copy for is translated; anything else falls back to one reviewed
 * sentence. Adding `worker_onboarding.rejection.reason.<code>` to both
 * catalogues is all it takes to give a new code its own wording.
 */
export function useRejectionMessage(): (reason: string) => string {
    const t = useTranslations('worker_onboarding.rejection');
    return (reason: string) => {
        const key = `reason.${reason}`;
        return t.has(key) ? t(key) : t('generic');
    };
}
