'use client';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineFeedback } from '@/components/ui/inline-feedback';
import { questionText } from '@/lib/onboarding-flow';
import type { OnboardingState, ReferredJobSummary } from '@/lib/api/worker';
import {
    availabilityLabelKey,
    experienceLabelKey,
    isAvailabilityKey,
    isExperienceKey,
    isTradeKey,
    tradeLabel,
    transportLabelKey,
} from '@/lib/worker-vocab';
import { ReferredJobDock, ReferredJobTicket } from './ReferredJobTicket';
import { useTicketDock } from './useTicketDock';

/**
 * Where the summary goes next. `OnboardingFlow` decides which -- it holds the
 * server's job, this tab's stash and the routes -- and this screen draws it.
 * One union rather than a set of flags, so a shape can never be half one thing
 * and half another (an Apply button over a closed job).
 */
export type DoneNext =
    /** The job they came for is open: its ticket, Apply, and every job as the way past it. */
    | { kind: 'apply'; job: ReferredJobSummary }
    /** It stopped taking applications: say so, and offer the feed. */
    | { kind: 'closed'; job: ReferredJobSummary }
    /** The server has no job on file but this tab does -- the claim never landed. */
    | { kind: 'handoff' }
    /** Nothing referred: the feed, which is where the jobs are (not the profile). */
    | { kind: 'feed' };

/** Which way the worker went; `OnboardingFlow` turns it into a route. */
export type DoneAction = 'apply' | 'jobs' | 'handoff';

/**
 * The summary screen: what an employer will see, said back to the worker.
 *
 * The extraction panel is the one live thing on it. Skill extraction runs
 * asynchronously after the last answer lands, so this screen opens on "Reading
 * your answers…" and flips to the skills when the poll in `OnboardingFlow`
 * sees `completed`. A worker is never BLOCKED on it — the profile is already
 * live and the way on is enabled throughout, which is why the waiting copy
 * says they can keep going.
 *
 * The way on is the job they came for when there is one (decided 2026-10-01):
 * its ticket with Apply, or a plain "it closed" — and otherwise the jobs feed.
 * Never the profile page, which shows no jobs at all. The ticket stays at the
 * BOTTOM of the summary (decided 2026-10-02), and a stub docked to the screen's
 * edge carries Apply while it is out of sight.
 *
 * A `failed` extraction is stated plainly rather than hidden or retried
 * forever: their answers still reach employers verbatim, which is the part
 * that matters, and the extractor re-runs server-side.
 *
 * There is no "improve my answers" here — Luis, 2026-08-29. Editing an answer
 * is the Back control on the question screens, up until the third one is sent;
 * after that the run is complete and the profile editor owns it.
 */
export function DoneStep({
    state,
    next,
    extractionStalled = false,
    onFinish,
}: {
    state: OnboardingState;
    /** What to offer as the way on. See `DoneNext`. */
    next: DoneNext;
    /**
     * The summary gave up waiting for the extraction (see `MAX_POLLS`). Not
     * the same as `status: 'failed'` — nothing failed, we just stopped asking
     * — so it gets its own, calmer sentence.
     */
    extractionStalled?: boolean;
    onFinish: (action: DoneAction) => void;
}) {
    const locale = useLocale();
    const spanish = locale === 'es';
    const t = useTranslations('worker_onboarding.done');
    const tSummary = useTranslations('worker_onboarding.summary');
    const tShared = useTranslations('worker_onboarding.common');
    const tVocab = useTranslations('worker_vocab');

    const { profile, trust, extraction } = state;
    const empty = tSummary('empty');

    const location = profile.location?.city && profile.location.state
        ? `${profile.location.city}, ${profile.location.state}`
        : profile.location?.zip ?? null;
    const trade = isTradeKey(profile.trade?.key)
        ? tradeLabel((key) => tVocab(key), profile.trade?.key, profile.trade?.other)
        : null;

    const rows: Array<[string, string]> = [
        [tSummary('name'), profile.fullName || empty],
        [tSummary('location'), location || empty],
        [tSummary('trade'), trade || empty],
        [tSummary('experience'), isExperienceKey(profile.yearsExperience) ? tVocab(experienceLabelKey(profile.yearsExperience)) : empty],
        [tSummary('transportation'), profile.hasTransportation === null
            ? empty
            : tVocab(transportLabelKey(profile.hasTransportation ? 'yes' : 'no'))],
        [tSummary('availability'), isAvailabilityKey(profile.availability) ? tVocab(availabilityLabelKey(profile.availability)) : empty],
    ];

    const answers = [...trust.answers].sort((a, b) => a.index - b.index);
    const chips = extraction?.extracted
        ? Object.values(extraction.extracted).flat().map((skill) => (spanish ? skill.label_es : skill.label_en))
        : [];
    const summary = spanish ? extraction?.summary_es : extraction?.summary_en;

    return (
        <div className="anim-fade-in flex flex-1 flex-col">
            <h1 className="flex items-center gap-2.5 rounded-xl bg-[var(--jale-success-bg)] px-3.5 py-3 text-[15px] font-semibold text-[var(--jale-success-text)]">
                <span aria-hidden="true">✓</span>
                <span>{t('title')}</span>
            </h1>
            <p className="mb-[18px] mt-3 text-[15px] font-light text-[var(--jale-ink-2)]">{t('subtitle')}</p>

            <div className="flex flex-1 flex-col gap-3">
                <Panel title={t('profile_heading')}>
                    {rows.map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-3 border-b border-[var(--jale-divider)] py-2.5 text-sm last:border-b-0">
                            <span className="text-[var(--jale-ink-2)]">{label}</span>
                            <span className="text-right font-medium text-[var(--jale-ink)]">{value}</span>
                        </div>
                    ))}
                </Panel>

                <div role="status" className="flex items-start gap-3 rounded-[14px] border border-[var(--jale-divider)] px-4 py-3.5">
                    {extraction?.status === 'completed' ? (
                        <>
                            <span aria-hidden="true" className="mt-0.5 grid h-[22px] w-[22px] flex-none place-items-center rounded-full bg-[var(--jale-success-bg)] text-[13px] font-bold text-[var(--jale-success-text)]">✓</span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('extracted')}</p>
                                {chips.length > 0 ? (
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {chips.map((chip, i) => (
                                            <span key={`${chip}-${i}`} className="rounded-full bg-[var(--jale-blue-50)] px-2.5 py-1 text-[13px] font-medium text-[var(--jale-blue-700)]">
                                                {chip}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                                {summary ? <p className="mt-2 text-[13px] text-[var(--jale-ink-2)]">{summary}</p> : null}
                            </div>
                        </>
                    ) : extraction?.status === 'failed' ? (
                        <p className="text-sm text-[var(--jale-ink-2)]">{t('failed')}</p>
                    ) : extractionStalled ? (
                        // The poll budget is gone. A spinner that never stops
                        // says "something is broken and you should wait"; both
                        // halves are wrong, so say the true thing instead.
                        <p className="text-sm text-[var(--jale-ink-2)]">{t('stalled')}</p>
                    ) : (
                        <>
                            <span
                                aria-hidden="true"
                                className="mt-0.5 h-[22px] w-[22px] flex-none animate-spin rounded-full border-[3px] border-[var(--jale-paper-2)] border-t-[var(--jale-blue-500)]"
                            />
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-[var(--jale-ink)]">{t('working')}</p>
                                <p className="text-[13px] text-[var(--jale-ink-2)]">{t('working_body')}</p>
                            </div>
                        </>
                    )}
                </div>

                <Panel title={t('own_words')}>
                    {answers.length === 0 ? (
                        <p className="text-[13px] text-[var(--jale-ink-2)]">{empty}</p>
                    ) : answers.map((answer) => (
                        <div key={answer.index} className="border-t border-[var(--jale-divider)] pt-2.5 text-sm first:border-t-0 first:pt-0">
                            <p className="mb-0.5 text-[13px] text-[var(--jale-ink-2)]">{questionText(state, answer.index, locale)}</p>
                            <p data-private className="font-light text-[var(--jale-ink)]">
                                {`“${answer.text}” `}
                                <span className="inline-block rounded-full bg-[var(--jale-input)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--jale-ink-2)]">
                                    {tShared(answer.source === 'voice' ? 'voice_badge' : 'typed_badge')}
                                </span>
                            </p>
                        </div>
                    ))}
                </Panel>
            </div>

            <div className="mt-[22px] flex flex-col gap-2.5">
                <DoneActions next={next} onFinish={onFinish} />
            </div>
        </div>
    );
}

/**
 * The bottom of the summary, one shape per `DoneNext`. The primary action is
 * always the full-width large button and a second way on, when there is one,
 * the quiet ghost under it. For an open job the large button rides on the
 * job's ticket.
 */
function DoneActions({ next, onFinish }: { next: DoneNext; onFinish: (action: DoneAction) => void }) {
    const t = useTranslations('worker_onboarding.done');

    switch (next.kind) {
        case 'apply':
            return <ApplyActions job={next.job} onFinish={onFinish} />;
        case 'closed':
            return (
                <>
                    {/* `info`, so `role="status"`: a fact about the job, not an
                        error the worker caused or can fix. */}
                    <InlineFeedback tone="info">{t('job_closed', { title: next.job.title })}</InlineFeedback>
                    <Button className="w-full" size="lg" onClick={() => onFinish('jobs')}>
                        {t('see_jobs')}
                    </Button>
                </>
            );
        case 'handoff':
            return (
                <Button className="w-full" size="lg" onClick={() => onFinish('handoff')}>
                    {t('cta_job')}
                </Button>
            );
        case 'feed':
            return (
                <Button className="w-full" size="lg" onClick={() => onFinish('jobs')}>
                    {t('see_jobs')}
                </Button>
            );
    }
}

/**
 * The open job's way on: its ticket, every job under it, and the stub that
 * stands in for the ticket while it is out of sight. Both Apply buttons are
 * one action, `onFinish('apply')` -- the stub is a shortcut to the same place,
 * never a second path.
 *
 * The stub is rendered after the ghost button and portalled to the end of
 * `document.body` (see `ReferredJobDock`), so the tab order meets the ticket
 * first. Where it sits on screen is CSS (`fixed`), not markup.
 */
function ApplyActions({ job, onFinish }: { job: ReferredJobSummary; onFinish: (action: DoneAction) => void }) {
    const t = useTranslations('worker_onboarding.done');
    const { ticketRef, dockRef, dockShown } = useTicketDock();
    const apply = () => onFinish('apply');

    return (
        <>
            <ReferredJobTicket ref={ticketRef} job={job} onApply={apply} />
            <Button variant="ghost" className="w-full" onClick={() => onFinish('jobs')}>
                {t('see_all_jobs')}
            </Button>
            <ReferredJobDock ref={dockRef} job={job} shown={dockShown} onApply={apply} />
        </>
    );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="rounded-[14px] border border-[var(--jale-divider)] px-4 py-3.5">
            <h2 className="mb-2 text-sm font-semibold text-[var(--jale-ink)]">{title}</h2>
            <div className="flex flex-col gap-2.5">{children}</div>
        </section>
    );
}
