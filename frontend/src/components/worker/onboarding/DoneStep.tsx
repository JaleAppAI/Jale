'use client';
import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { questionText } from '@/lib/onboarding-flow';
import type { OnboardingState } from '@/lib/api/worker';
import {
    availabilityLabelKey,
    experienceLabelKey,
    isAvailabilityKey,
    isExperienceKey,
    isTradeKey,
    tradeLabel,
    transportLabelKey,
} from '@/lib/worker-vocab';

/**
 * The summary screen: what an employer will see, said back to the worker.
 *
 * The extraction panel is the one live thing on it. Skill extraction runs
 * asynchronously after the last answer lands, so this screen opens on "Reading
 * your answers…" and flips to the skills when the poll in `OnboardingFlow`
 * sees `completed`. A worker is never BLOCKED on it — the profile is already
 * live and "Go to my profile" is enabled throughout, which is why the waiting
 * copy says they can keep going.
 *
 * A `failed` extraction is stated plainly rather than hidden or retried
 * forever: their answers still reach employers verbatim, which is the part
 * that matters, and the extractor re-runs server-side.
 *
 * There is no "improve my answers" here. The run is COMPLETE by the time this
 * screen exists (the third answer's own response says `lifecycle: 'ready'`),
 * and the engine's `back` endpoint only walks an ACTIVE run — so the button
 * would have had nothing to call. Editing an answer is the Back control on the
 * question screens, before the third one is submitted; after that, the profile
 * editor owns it.
 */
export function DoneStep({
    state,
    hasJobHandoff = false,
    extractionStalled = false,
    onFinish,
}: {
    state: OnboardingState;
    /**
     * The worker got here from a shared job link and still has that job
     * waiting. The CTA then says so instead of promising a profile page —
     * `OnboardingFlow` owns both the flag and where the button actually goes.
     */
    hasJobHandoff?: boolean;
    /**
     * The summary gave up waiting for the extraction (see `MAX_POLLS`). Not
     * the same as `status: 'failed'` — nothing failed, we just stopped asking
     * — so it gets its own, calmer sentence.
     */
    extractionStalled?: boolean;
    onFinish: () => void;
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
                            <p className="font-light text-[var(--jale-ink)]">
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
                <Button className="w-full" size="lg" onClick={onFinish}>
                    {hasJobHandoff ? t('cta_job') : t('cta')}
                </Button>
            </div>
        </div>
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
