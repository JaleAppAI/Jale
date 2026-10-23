'use client';

import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    SceneChip,
    SceneField,
    SceneFrame,
    SceneLabel,
    SceneNote,
    ScenePointer,
    SceneRow,
    SceneSegments,
    SceneToggle,
    SlideIn,
    TypeOn,
} from '@/components/tutorials/scene';
import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * E2, "Posting a job": the wizard in four slides, played the first time an
 * employer with no job presses "Post a job", after the plan gate has passed
 * and before the wizard opens (K1.5). Also from Help at any time.
 *
 * Drawn from the `E2-PostJobTutorial.dc.html` board. Sample data only.
 */

const NAMESPACE = 'tutorial.employer_post_job';
const SCENES = `${NAMESPACE}.scenes`;

function StepsScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[270px] flex-col gap-3.5">
            <SceneSegments count={3} labels={[t('step1'), t('step2'), t('step3')]} fill="pop" />
            <SceneFrame>
                <span className="font-bold">{t('required')}</span>
                <div className="flex flex-wrap gap-1.5">
                    <SlideIn as="span">
                        <SceneChip tone="blue">{t('r1')}</SceneChip>
                    </SlideIn>
                    <SlideIn as="span">
                        <SceneChip tone="blue">{t('r2')}</SceneChip>
                    </SlideIn>
                    <SlideIn as="span" step={2}>
                        <SceneChip tone="blue">{t('r3')}</SceneChip>
                    </SlideIn>
                    <SlideIn as="span" step={2}>
                        <SceneChip tone="blue">{t('r4')}</SceneChip>
                    </SlideIn>
                </div>
            </SceneFrame>
        </div>
    );
}

function CityScene() {
    return (
        <>
            <div className="flex w-[230px] flex-col gap-1 text-xs">
                <SceneField focused caret size="md">
                    <TypeOn>El Pa</TypeOn>
                </SceneField>
                <SlideIn>
                    <SceneFrame>
                        <SceneNote tone="blue" className="flex justify-between">
                            El Paso, Texas
                            <SlideIn as="span" step={3} className="text-[var(--jale-success-text)]">
                                ✓
                            </SlideIn>
                        </SceneNote>
                        <span className="px-2 text-[var(--jale-ink-2)]">El Paso County, Texas</span>
                        <span className="px-2 text-[var(--jale-ink-2)]">El Paso, Illinois</span>
                    </SceneFrame>
                </SlideIn>
            </div>
            <ScenePointer from={{ x: 230, y: 160 }} to={{ x: 170, y: 82 }} />
        </>
    );
}

function ShiftsScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[270px] flex-col gap-2.5 text-xs">
            <SceneLabel className="text-[10px]">{t('shifts')}</SceneLabel>
            <div className="grid grid-cols-2 gap-2">
                <SceneToggle shape="tile" step={1}>
                    {t('day')}
                </SceneToggle>
                <SceneToggle shape="tile" on={false}>
                    {t('evening')}
                </SceneToggle>
                <SceneToggle shape="tile" step={2}>
                    {t('night')}
                </SceneToggle>
                <SceneToggle shape="tile" on={false}>
                    {t('overnight')}
                </SceneToggle>
            </div>
            <SlideIn step={3}>
                <span className="text-[11px] text-[var(--jale-ink-2)]">{t('times_optional')}</span>
            </SlideIn>
        </div>
    );
}

function QuestionsScene() {
    const t = useTranslations(SCENES);
    return (
        <SceneFrame className="w-[260px]">
            <span className="flex items-center justify-between font-bold">
                {t('questions')}
                <Lock aria-hidden className="h-4 w-4 text-[var(--jale-warning-text)]" />
            </span>
            <SceneRow divider trailing={<span className="font-semibold text-[var(--jale-blue-700)]">{t('required_tag')}</span>}>
                {t('q1')}
            </SceneRow>
            <SceneRow divider trailing={<span className="text-[var(--jale-ink-2)]">{t('optional_tag')}</span>}>
                {t('q2')}
            </SceneRow>
            <SceneRow divider trailing={<span className="text-[var(--jale-ink-2)]">{t('off_tag')}</span>}>
                {t('q3')}
            </SceneRow>
            <SlideIn step={3}>
                <SceneNote tone="warning">{t('lock_note')}</SceneNote>
            </SlideIn>
        </SceneFrame>
    );
}

const employerPostJob: TutorialDefinition = {
    id: 'employer_post_job',
    role: 'employer',
    namespace: NAMESPACE,
    titleKey: 'title',
    slides: [
        { id: 'steps', titleKey: 'slides.steps.title', bodyKey: 'slides.steps.body', Scene: StepsScene },
        { id: 'city', titleKey: 'slides.city.title', bodyKey: 'slides.city.body', Scene: CityScene },
        { id: 'shifts', titleKey: 'slides.shifts.title', bodyKey: 'slides.shifts.body', Scene: ShiftsScene },
        { id: 'questions', titleKey: 'slides.questions.title', bodyKey: 'slides.questions.body', Scene: QuestionsScene },
    ],
};

export default employerPostJob;
