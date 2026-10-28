'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';
import { EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import type { Placement } from './geometry';

/**
 * The spotlight's three cards, drawn from text the engine has already looked
 * up: the opening card, the callout beside a control, and the closing card.
 * Every button is at least 44px; the primary action comes first in the DOM,
 * so it is the first Tab stop.
 */

export const TEXT_BUTTON = [
    'inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full px-4 text-sm font-semibold',
    'transition-colors hover:bg-[var(--jale-paper-2)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
].join(' ');

const CARD =
    'pointer-events-auto rounded-[var(--radius-card)] bg-[var(--jale-card)] text-[var(--jale-ink)] shadow-[var(--shadow-modal)] outline-none';

type CardIds = { titleId: string; bodyId: string };

/** A card in the middle of the spotlight's layer, with no cutout: the opening and closing cards. */
function CentredCard({
    dialogRef,
    ids,
    animate,
    stepId,
    children,
}: {
    dialogRef: Ref<HTMLDivElement>;
    ids: CardIds;
    animate: boolean;
    stepId: string;
    children: ReactNode;
}) {
    return (
        <div className="absolute inset-0 flex items-center justify-center p-4">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={ids.titleId}
                aria-describedby={ids.bodyId}
                tabIndex={-1}
                data-step={stepId}
                className={`${animate ? 'anim-fade-in ' : ''}w-full max-w-[440px] p-6 ${CARD}`}
            >
                {children}
            </div>
        </div>
    );
}

export function IntroCard({
    dialogRef,
    primaryRef,
    ids,
    animate,
    eyebrow,
    title,
    body,
    start,
    notNow,
    mute,
    onStart,
    onNotNow,
    onMute,
}: {
    dialogRef: Ref<HTMLDivElement>;
    primaryRef: Ref<HTMLButtonElement>;
    ids: CardIds;
    animate: boolean;
    eyebrow?: string;
    title: string;
    body: string;
    start: string;
    notNow: string;
    /** The mute button's label; no button without it. */
    mute?: string;
    onStart: () => void;
    onNotNow: () => void;
    onMute?: () => void;
}) {
    return (
        <CentredCard dialogRef={dialogRef} ids={ids} animate={animate} stepId="intro">
            <span
                aria-hidden="true"
                className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-[var(--radius-card)] bg-[var(--jale-teal-500)] text-[var(--primary-fg)]"
            >
                <Icon name="spark" />
            </span>
            {eyebrow ? (
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--jale-ink-2)]">{eyebrow}</p>
            ) : null}
            <h2 id={ids.titleId} className="text-xl font-bold leading-tight">
                {title}
            </h2>
            <p id={ids.bodyId} className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
                {body}
            </p>
            {/* The primary action first in the DOM, so it is the first stop;
                on wider screens it sits on the right. */}
            <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
                <Button ref={primaryRef} onClick={onStart} data-spotlight-action="start">
                    {start}
                </Button>
                <button
                    type="button"
                    className={`${TEXT_BUTTON} text-[var(--jale-ink)]`}
                    onClick={onNotNow}
                    data-spotlight-action="not-now"
                >
                    {notNow}
                </button>
            </div>
            {mute && onMute ? (
                <div className="mt-3 flex justify-center border-t border-[var(--jale-divider)] pt-1">
                    <button
                        type="button"
                        onClick={onMute}
                        data-spotlight-action="mute"
                        className={[
                            'inline-flex h-11 cursor-pointer items-center gap-2 rounded-full px-3',
                            'text-[13px] font-medium text-[var(--jale-ink-2)] transition-colors',
                            'hover:bg-[var(--jale-paper-2)] hover:text-[var(--jale-ink)]',
                            'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
                        ].join(' ')}
                    >
                        <EyeOff aria-hidden="true" className="h-4 w-4 shrink-0" />
                        {mute}
                    </button>
                </div>
            ) : null}
        </CentredCard>
    );
}

export function DoneCard({
    dialogRef,
    primaryRef,
    ids,
    animate,
    title,
    body,
    gotIt,
    onGotIt,
}: {
    dialogRef: Ref<HTMLDivElement>;
    primaryRef: Ref<HTMLButtonElement>;
    ids: CardIds;
    animate: boolean;
    title: string;
    body: string;
    gotIt: string;
    onGotIt: () => void;
}) {
    return (
        <CentredCard dialogRef={dialogRef} ids={ids} animate={animate} stepId="done">
            <h2 id={ids.titleId} className="text-xl font-bold leading-tight">
                {title}
            </h2>
            <p id={ids.bodyId} className="mt-2 text-sm leading-6 text-[var(--jale-ink-2)]">
                {body}
            </p>
            <div className="mt-6 flex justify-end">
                <Button ref={primaryRef} onClick={onGotIt} data-spotlight-action="done">
                    {gotIt}
                </Button>
            </div>
        </CentredCard>
    );
}

/** The arrow is a small rotated square on the callout's edge that faces the target. */
function arrowStyle(placement: Placement): CSSProperties {
    const offset = placement.arrow - 7;
    if (placement.side === 'top') return { bottom: -7, left: offset };
    if (placement.side === 'bottom') return { top: -7, left: offset };
    return { left: -7, top: offset };
}

/** What the step's primary button does, if it has one. */
export type StepPrimary = { label: string; disabled: boolean; onClick: () => void } | null;

export function StepCallout({
    dialogRef,
    primaryRef,
    ids,
    stepId,
    interactive,
    placement,
    transition,
    counter,
    title,
    body,
    wait,
    end,
    back,
    primary,
    onEnd,
    onBack,
}: {
    dialogRef: Ref<HTMLDivElement>;
    primaryRef: Ref<HTMLButtonElement>;
    ids: CardIds;
    stepId: string;
    interactive: boolean;
    /** Null centres the callout, with no arrow: its control is missing. */
    placement: Placement | null;
    transition: string;
    counter: string;
    title: string;
    body: string;
    /** What the step waits for, when it is waiting. */
    wait?: string;
    end: string;
    /** Back's label, when there is a step to go back to. */
    back?: string;
    primary: StepPrimary;
    onEnd: () => void;
    onBack: () => void;
}) {
    return (
        <div
            ref={dialogRef}
            role="dialog"
            // On an interactive step the control the person uses sits
            // outside the callout, so the rest of the page is not
            // declared inert to assistive technology.
            aria-modal={interactive ? undefined : 'true'}
            aria-labelledby={ids.titleId}
            aria-describedby={ids.bodyId}
            tabIndex={-1}
            data-step={stepId}
            data-side={placement?.side ?? 'center'}
            // Sized by the layer it sits in: the viewport, or inside a dialog
            // that contains the layer, the dialog.
            className={`absolute w-[min(360px,calc(100%-32px))] p-4 ${CARD}`}
            style={
                placement
                    ? { top: placement.top, left: placement.left, transition }
                    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
            }
        >
            {placement ? (
                <span
                    aria-hidden="true"
                    className="absolute h-3.5 w-3.5 rotate-45 bg-[var(--jale-card)]"
                    style={arrowStyle(placement)}
                />
            ) : null}
            <p className="relative text-xs font-semibold text-[var(--jale-ink-2)]">{counter}</p>
            <h2 id={ids.titleId} className="relative mt-1 text-lg font-bold leading-tight">
                {title}
            </h2>
            <p id={ids.bodyId} className="relative mt-1 text-sm leading-6">
                {body}
            </p>
            {wait ? (
                <p data-spotlight-wait="" className="relative mt-2 text-[13px] font-medium leading-[18px] text-[var(--jale-ink-2)]">
                    {wait}
                </p>
            ) : null}
            <div className="relative mt-3 flex items-center justify-between gap-2">
                <button
                    type="button"
                    className={`${TEXT_BUTTON} -ml-2 whitespace-nowrap text-[var(--jale-ink-2)]`}
                    onClick={onEnd}
                    data-spotlight-action="end"
                >
                    {end}
                </button>
                <div className="flex items-center justify-end gap-2">
                    {back ? (
                        <Button variant="outline" onClick={onBack} data-spotlight-action="back">
                            {back}
                        </Button>
                    ) : null}
                    {primary ? (
                        <Button
                            ref={primaryRef}
                            disabled={primary.disabled}
                            onClick={primary.onClick}
                            data-spotlight-action="next"
                        >
                            {primary.label}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
