'use client';
import { useId, useSyncExternalStore, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatPay } from '@/lib/pay';
import type { ReferredJobSummary } from '@/lib/api/worker';

/**
 * The job's pay through the app's one pay formatter, so the ticket and its
 * stub read "$22–$26/hr", or "/hora" in Spanish, exactly as the feed and the
 * job page put it. `null` when the job states none: the line is left out.
 */
function useJobPay(job: ReferredJobSummary): string | null {
    const tPay = useTranslations('pay');
    // `formatPay` reads the job payloads' snake_case columns.
    return formatPay(
        { pay: job.payRaw, pay_min: job.payMin, pay_max: job.payMax, pay_interval: job.payInterval },
        tPay,
    );
}

/**
 * The job they came for, as a ticket (decided 2026-10-02): the facts
 * on top, a tear line, and Apply on the part below it, so the button reads as
 * this job's and not as one more button under the summary.
 *
 * The title wraps and the ticket grows rather than truncating -- this is the
 * one place the whole title is shown, which is why the stub can clip it. The
 * notches are discs of the flow's own ground (`--jale-card`) laid over the two
 * edges, so they read as cut out of the ticket in either theme.
 *
 * The eyebrow names the region and the job title is its heading, so a screen
 * reader hears "The job you came for" as the landmark and the job by name.
 */
export function ReferredJobTicket({ job, onApply, ref }: {
    job: ReferredJobSummary;
    onApply: () => void;
    ref?: Ref<HTMLElement>;
}) {
    const t = useTranslations('worker_onboarding.done');
    const pay = useJobPay(job);
    const eyebrowId = useId();

    return (
        <section ref={ref} aria-labelledby={eyebrowId} className="rounded-2xl bg-[var(--jale-blue-50)]">
            <div className="px-[18px] pb-3 pt-4">
                <p id={eyebrowId} className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--jale-blue-700)]">
                    {t('job_heading')}
                </p>
                <h2 className="text-pretty text-[19px] font-semibold leading-[1.25] tracking-[-0.01em] text-[var(--jale-ink)] [overflow-wrap:anywhere]">
                    {job.title}
                </h2>
                <p className="mt-1 text-[13.5px] text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">
                    {job.company} · {job.location}
                </p>
                {pay ? (
                    <p className="mt-2.5 text-[17px] font-semibold tabular-nums text-[var(--jale-ink)]">{pay}</p>
                ) : null}
            </div>
            <div aria-hidden="true" className="relative h-[18px]">
                <span className="absolute inset-x-4 top-2 border-t-[1.5px] border-dashed border-[var(--jale-perforation)]" />
                <span className="absolute -left-[9px] top-0 size-[18px] rounded-full bg-[var(--jale-card)]" />
                <span className="absolute -right-[9px] top-0 size-[18px] rounded-full bg-[var(--jale-card)]" />
            </div>
            <div className="px-[18px] pb-[18px] pt-2.5">
                {/* Tabbing here scrolls this button into view, and while the
                    stub is still up the browser would park it UNDER the stub
                    for the frame before the stub steps aside. The scroll
                    margin clears the stub's height (an h-11 row with its
                    padding, about 72px) plus the safe-area inset it adds. */}
                <Button className="w-full scroll-mb-[calc(5rem+env(safe-area-inset-bottom))]" size="lg" onClick={onApply}>
                    {t('apply')}
                    {/* `absoluteStrokeWidth` keeps lucide's 2px line at this
                        16px size, the weight of the label beside it. */}
                    <ArrowRight aria-hidden="true" size={16} absoluteStrokeWidth />
                </Button>
            </div>
        </section>
    );
}

const noSubscription = () => () => {};

/**
 * True once this render runs in the browser, where `document.body` exists to
 * portal into. A store read rather than an effect setting a flag: the server
 * render and the hydration pass both get `false`, so they agree, and a render
 * on the client gets `true` at once, with no extra commit.
 */
function useInBrowser(): boolean {
    return useSyncExternalStore(noSubscription, () => true, () => false);
}

/**
 * The ticket's stub, docked to the bottom of the viewport while the ticket is
 * out of sight: the job on one line, pay · company on the next, and the same
 * Apply. `shown` is what `useTicketDock`'s observer last said, and nothing
 * else -- there is no way to ask for the stub.
 *
 * PORTALLED INTO `document.body`, not drawn inside the summary. A transformed
 * ancestor becomes the containing block of a `position: fixed` element, and
 * DoneStep's root fades in with `anim-fade-in`, whose keyframes animate a
 * `transform`: inside that tree the stub would be pinned to the bottom of the
 * long summary rather than the viewport while it runs, and any later
 * transform or `will-change` up there would do the same, silently. In `body`
 * its only ancestors are `body` and `html`. React context still reaches it,
 * so next-intl does too, and the tokens resolve from `:root`/`.dark` as
 * everywhere else. Being last in `body` also keeps it last in the tab order,
 * after the ticket.
 *
 * Stowed means gone for everyone, not just out of sight. `inert` takes it out
 * of the tab order and away from the pointer at once, `aria-hidden` takes it
 * out of the accessibility tree (and covers a browser without `inert`), and
 * `invisible` lands when the slide ends: `visibility` is one of the
 * transitioned properties, so it holds `visible` until the end and then drops.
 * The timings are the prototype's -- in at 220ms easing out, away at 200ms
 * easing in.
 *
 * Phone-width it spans the screen. From `sm:` it is `OnboardingShell`'s card,
 * 520px and centred, with the card's top corners. `z-20` is the app's bottom
 * bar layer, under the toasts.
 */
export function ReferredJobDock({ job, shown, onApply, ref }: {
    job: ReferredJobSummary;
    shown: boolean;
    onApply: () => void;
    ref?: Ref<HTMLElement>;
}) {
    const t = useTranslations('worker_onboarding.done');
    const pay = useJobPay(job);
    const inBrowser = useInBrowser();

    if (!inBrowser) return null;
    return createPortal(
        <aside
            ref={ref}
            aria-label={t('job_heading')}
            aria-hidden={shown ? undefined : true}
            inert={!shown}
            className={[
                'fixed inset-x-0 bottom-0 z-20 mx-auto max-w-[520px] sm:rounded-t-[24px]',
                'border-t-[1.5px] border-dashed border-[var(--jale-perforation)] bg-[var(--jale-blue-50)] shadow-[var(--shadow-dock)]',
                'transition-[translate,opacity,visibility] motion-reduce:transition-none',
                shown
                    ? 'visible translate-y-0 opacity-100 duration-[220ms] ease-out'
                    : 'invisible translate-y-full opacity-0 duration-200 ease-in',
            ].join(' ')}
        >
            <div className="flex items-center gap-3 px-[22px] pb-[calc(14px+env(safe-area-inset-bottom))] pt-3">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--jale-ink)]">{job.title}</p>
                    <p className="mt-0.5 truncate text-[12.5px] text-[var(--jale-ink-2)]">
                        {pay ? (
                            <>
                                <span className="font-semibold tabular-nums text-[var(--jale-ink)]">{pay}</span>
                                {' · '}
                            </>
                        ) : null}
                        {job.company}
                    </p>
                </div>
                <Button className="flex-none" onClick={onApply}>
                    {t('apply')}
                </Button>
            </div>
        </aside>,
        document.body,
    );
}
