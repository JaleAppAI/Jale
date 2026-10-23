'use client';

import { ChevronDown, Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    CountUp,
    SceneAvatar,
    SceneBubble,
    SceneChip,
    SceneCycle,
    SceneField,
    SceneFrame,
    SceneLabel,
    SceneNote,
    SceneRow,
    SlideIn,
    TapPulse,
} from '@/components/tutorials/scene';
import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * E3, "Your applicants": what an applicant shows, which statuses are only the
 * employer's, and how requesting details leads to a hire. It plays once on a
 * job's applicants or an applicant's page, until the employer has moved
 * someone past "applied" (K1.5). Also from Help at any time.
 *
 * Drawn from the `E3-ApplicantsTutorial.dc.html` board. Sample data only.
 */

const NAMESPACE = 'tutorial.employer_applicants';
const SCENES = `${NAMESPACE}.scenes`;

function FirstLookScene() {
    const t = useTranslations(SCENES);
    return (
        <SceneFrame className="w-[270px]">
            <div className="flex items-center gap-2.5">
                <SceneAvatar initials="SW" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-xs font-bold">{t('sample_name')}</span>
                    <SlideIn as="span" className="text-[var(--jale-ink-2)]">
                        {t('sample_meta')}
                    </SlideIn>
                </div>
                <SlideIn as="span" step={2}>
                    <SceneChip tone="success">
                        {t('trust')} <CountUp to={82} />
                    </SceneChip>
                </SlideIn>
            </div>
            <SlideIn step={3}>
                <SceneNote tone="neutral" className="flex flex-col gap-1">
                    <SceneLabel>{t('own_words')}</SceneLabel>
                    <span>{t('quote')}</span>
                </SceneNote>
            </SlideIn>
        </SceneFrame>
    );
}

function StatusesScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[250px] flex-col gap-2.5 text-xs">
            <SceneField size="md" className="justify-between">
                <SceneCycle>
                    <span>{t('st_new')}</span>
                    <span>{t('st_contacted')}</span>
                    <span>{t('st_talking')}</span>
                </SceneCycle>
                <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--jale-ink-2)]" />
            </SceneField>
            <SlideIn step={2} className="text-[11px]">
                <SceneNote tone="plain" className="flex items-center gap-2">
                    <Eye aria-hidden className="h-4 w-4 shrink-0 text-[var(--jale-blue-500)]" />
                    {t('only_you')}
                </SceneNote>
            </SlideIn>
        </div>
    );
}

function RequestScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[270px] flex-col gap-2 text-[11px]">
            <TapPulse kind="press" className="self-start">
                <SceneChip tone="primary" size="lg">
                    {t('request')}
                </SceneChip>
            </TapPulse>
            <SlideIn as="span" className="flex flex-col">
                <SceneBubble side="end" tone="whatsapp">
                    {t('wa_msg')}
                </SceneBubble>
            </SlideIn>
            <div className="flex items-center gap-2">
                <SlideIn as="span" step={2}>
                    <SceneChip tone="outline" size="sm">
                        {t('complete')} ✓
                    </SceneChip>
                </SlideIn>
                <SlideIn as="span" step={3} from="dim">
                    <SceneChip tone="success" size="sm">
                        {t('hired')}
                    </SceneChip>
                </SlideIn>
            </div>
        </div>
    );
}

function HiredScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[260px] flex-col gap-2 text-[11px]">
            <SlideIn as="span" className="self-start">
                <SceneChip tone="success" size="sm">
                    {t('hired')} ✓
                </SceneChip>
            </SlideIn>
            <SlideIn step={2}>
                <SceneFrame>
                    <span className="text-xs font-bold">{t('start_head')}</span>
                    <SceneRow divider trailing={<span className="font-semibold">{t('when_value')}</span>}>
                        <span className="text-[var(--jale-ink-2)]">{t('when')}</span>
                    </SceneRow>
                    <SceneRow divider trailing={<span className="font-semibold">{t('where_value')}</span>}>
                        <span className="text-[var(--jale-ink-2)]">{t('where')}</span>
                    </SceneRow>
                </SceneFrame>
            </SlideIn>
            <SlideIn as="span" step={3} className="self-end">
                <span className="text-[10px] text-[var(--jale-ink-2)]">{t('sent_wa')}</span>
            </SlideIn>
        </div>
    );
}

const employerApplicants: TutorialDefinition = {
    id: 'employer_applicants',
    role: 'employer',
    namespace: NAMESPACE,
    titleKey: 'title',
    slides: [
        { id: 'first_look', titleKey: 'slides.first_look.title', bodyKey: 'slides.first_look.body', Scene: FirstLookScene },
        { id: 'statuses', titleKey: 'slides.statuses.title', bodyKey: 'slides.statuses.body', Scene: StatusesScene },
        { id: 'request', titleKey: 'slides.request.title', bodyKey: 'slides.request.body', Scene: RequestScene },
        { id: 'hired', titleKey: 'slides.hired.title', bodyKey: 'slides.hired.body', Scene: HiredScene },
    ],
};

export default employerApplicants;
