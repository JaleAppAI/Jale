'use client';

import { ArrowDown, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    CountUp,
    SceneAvatar,
    SceneBubble,
    SceneChip,
    SceneField,
    SceneFrame,
    SceneLabel,
    SceneNote,
    ScenePointer,
    SceneSegments,
    SlideIn,
    TapPulse,
    TypeOn,
} from '@/components/tutorials/scene';
import type { TutorialDefinition, TutorialSceneProps } from '@/lib/tutorials/types';

/**
 * E1, "How Jale works": the employer's first look at the whole loop, from
 * posting a job to hiring. It plays once on the dashboard for an employer
 * with no job yet (K1.5), and from Help at any time.
 *
 * Drawn from the `Main.dc.html` board. Sample data only.
 */

const NAMESPACE = 'tutorial.employer_welcome';
const SCENES = `${NAMESPACE}.scenes`;

/** The prototype's sample share link; not a real job. */
const SAMPLE_LINK = 'jaleapp.ai/j/AB12CD';

/** The prototype's QR mark: 5 × 5 cells, 1 = filled. A drawing, not a code. */
const QR_CELLS = [1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1] as const;

function PostScene() {
    const t = useTranslations(SCENES);
    return (
        <>
            <SceneFrame className="w-[230px]">
                <SceneSegments count={3} filled={1} />
                <SceneLabel>{t('f_title')}</SceneLabel>
                <SceneField>
                    <TypeOn>{t('f_title_value')}</TypeOn>
                </SceneField>
                <div className="flex gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <SceneLabel>{t('f_trade')}</SceneLabel>
                        <SlideIn>
                            <SceneField>{t('f_trade_value')}</SceneField>
                        </SlideIn>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <SceneLabel>{t('f_city')}</SceneLabel>
                        <SlideIn step={2}>
                            <SceneField className="gap-1">
                                El Paso, TX <span className="text-[var(--jale-success-text)]">✓</span>
                            </SceneField>
                        </SlideIn>
                    </div>
                </div>
                <div className="flex justify-end">
                    <TapPulse>
                        <SceneChip tone="primary" size="sm">
                            {t('f_next')}
                        </SceneChip>
                    </TapPulse>
                </div>
            </SceneFrame>
            <ScenePointer from={{ x: 70, y: 40 }} to={{ x: 266, y: 160 }} />
        </>
    );
}

function ShareScene() {
    const t = useTranslations(SCENES);
    return (
        <>
            <div className="flex items-center gap-4">
                <div className="flex w-[170px] flex-col gap-2 text-[11px]">
                    <SceneNote tone="plain" className="flex items-center justify-between gap-2">
                        <span className="text-[var(--jale-ink-2)]">{SAMPLE_LINK}</span>
                        <TapPulse>
                            <SceneChip tone="primary">{t('copy')}</SceneChip>
                        </TapPulse>
                    </SceneNote>
                    <SlideIn as="span" step={2} className="self-start">
                        <SceneChip tone="ink" size="sm">
                            {t('copied')}
                        </SceneChip>
                    </SlideIn>
                    <SlideIn step={3}>
                        <span className="text-[11px] text-[var(--jale-ink-2)]">{t('crew')}</span>
                    </SlideIn>
                </div>
                <SlideIn>
                    <span className="grid h-[84px] w-[84px] grid-cols-5 gap-[3px] rounded-lg bg-[var(--jale-card)] p-2">
                        {QR_CELLS.map((filled, index) => (
                            <span key={index} className={filled ? 'bg-[var(--jale-ink)]' : undefined} />
                        ))}
                    </span>
                </SlideIn>
            </div>
            <ScenePointer from={{ x: 60, y: 150 }} to={{ x: 152, y: 66 }} />
        </>
    );
}

function ApplyScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex items-center gap-3.5">
            <div className="flex w-[112px] flex-col gap-2 text-[11px]">
                <SlideIn as="span" className="flex flex-col">
                    <SceneBubble side="start" tone="whatsapp">
                        {t('wa_bubble')}
                    </SceneBubble>
                </SlideIn>
                <SlideIn step={2}>
                    <SceneNote tone="plain" className="flex items-center justify-between gap-1">
                        {t('web')}
                        <SceneChip tone="primary">{t('apply')}</SceneChip>
                    </SceneNote>
                </SlideIn>
            </div>
            <ArrowRight aria-hidden className="h-5 w-5 shrink-0 text-[var(--jale-blue-500)]" />
            <SceneFrame className="w-[130px]">
                <span className="font-bold">{t('applicants')} · 3</span>
                <SlideIn className="flex items-center gap-1.5">
                    <SceneAvatar size="sm" initials="SW" />
                    {t('trade1')}
                </SlideIn>
                <SlideIn step={2} className="flex items-center gap-1.5">
                    <SceneAvatar size="sm" tone="blue" initials="TW" />
                    {t('trade2')}
                </SlideIn>
                <SlideIn step={3} className="flex items-center gap-1.5">
                    <SceneAvatar size="sm" tone="warning" initials="EW" />
                    {t('trade3')}
                </SlideIn>
            </SceneFrame>
        </div>
    );
}

function ReviewScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[250px] flex-col gap-2 text-[11px]">
            <SceneFrame>
                <div className="flex items-center gap-2.5">
                    <SceneAvatar initials="SW" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-bold">{t('sample_name')}</span>
                        <span className="text-[var(--jale-ink-2)]">{t('sample_meta')}</span>
                    </div>
                    <SlideIn as="span">
                        <SceneChip tone="success">
                            {t('trust')} <CountUp to={82} />
                        </SceneChip>
                    </SlideIn>
                </div>
            </SceneFrame>
            <SlideIn as="span" step={2} className="flex flex-col">
                <SceneBubble side="end" tone="brand">
                    {t('msg')}
                </SceneBubble>
            </SlideIn>
            <SlideIn as="span" step={3} className="self-end">
                <span className="text-[10px] text-[var(--jale-ink-2)]">{t('sent_wa')}</span>
            </SlideIn>
        </div>
    );
}

/**
 * The plan's real active-job limit, when the host passed one (E1 on the
 * dashboard passes the plan snapshot's). A replay from Help may pass none, and
 * then there is no plan line at all rather than a made-up number.
 */
function activeJobLimit(vars: TutorialSceneProps['vars']): number | null {
    const limit = vars?.activeJobLimit;
    return typeof limit === 'number' && Number.isInteger(limit) && limit >= 0 ? limit : null;
}

function HireScene({ vars }: TutorialSceneProps) {
    const t = useTranslations(SCENES);
    const limit = activeJobLimit(vars);
    return (
        <div className="flex flex-col items-center gap-2 text-xs">
            <SlideIn as="span">
                <SceneChip tone="blue" size="md">
                    {t('st1')}
                </SceneChip>
            </SlideIn>
            <ArrowDown aria-hidden className="h-3.5 w-3.5 text-[var(--jale-ink-2)]" />
            <SlideIn as="span" step={2}>
                <SceneChip tone="outline" size="md">
                    {t('st2')} ✓
                </SceneChip>
            </SlideIn>
            <ArrowDown aria-hidden className="h-3.5 w-3.5 text-[var(--jale-ink-2)]" />
            <SlideIn as="span" step={3}>
                <SceneChip tone="success" size="md">
                    {t('st3')}
                </SceneChip>
            </SlideIn>
            {limit === null ? null : (
                <SceneChip tone="neutral" size="sm" className="mt-1">
                    {t('plan_line', { limit })}
                </SceneChip>
            )}
        </div>
    );
}

const employerWelcome: TutorialDefinition = {
    id: 'employer_welcome',
    role: 'employer',
    namespace: NAMESPACE,
    titleKey: 'title',
    slides: [
        { id: 'post', titleKey: 'slides.post.title', bodyKey: 'slides.post.body', Scene: PostScene },
        { id: 'share', titleKey: 'slides.share.title', bodyKey: 'slides.share.body', Scene: ShareScene },
        { id: 'apply', titleKey: 'slides.apply.title', bodyKey: 'slides.apply.body', Scene: ApplyScene },
        { id: 'review', titleKey: 'slides.review.title', bodyKey: 'slides.review.body', Scene: ReviewScene },
        { id: 'hire', titleKey: 'slides.hire.title', bodyKey: 'slides.hire.body', Scene: HireScene },
    ],
};

export default employerWelcome;
