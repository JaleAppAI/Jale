'use client';

import { useTranslations } from 'next-intl';
import { ChevronLeft, Lock, Mic } from 'lucide-react';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import {
  SceneChip,
  SceneCycle,
  SceneField,
  SceneFrame,
  SceneLabel,
  SceneSegments,
  SlideIn,
  TypeOn,
} from '@/components/tutorials/scene';

/**
 * W1, `worker_onboarding`: what onboarding asks before the worker starts it.
 * Drawn from `W1-OnboardingTutorial.dc.html`, slide for slide, with the
 * board's copy. It auto-opens on the first onboarding screen (terms) and ends
 * on "Let's start" (`cta_last`), because the worker goes straight on into the
 * steps it describes.
 *
 * Scenes are decoration (`aria-hidden` throughout, R7): each slide's title
 * and body say everything the picture shows.
 */

const NAMESPACE = 'tutorial.worker_onboarding';

/** About 2 minutes, and the 7 steps filling one by one. */
function MinutesScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <div className="flex w-[260px] flex-col items-center gap-3">
      <SlideIn as="span">
        <SceneChip tone="plain" size="md" className="text-[13px] font-bold">
          {t('two_min')}
        </SceneChip>
      </SlideIn>
      <SceneSegments count={7} tone="teal" thickness="lg" fill="sequence" />
      <div className="flex flex-wrap justify-center gap-1.5 text-[10px]">
        {(['st1', 'st2', 'st3', 'st4', 'st5'] as const).map((key) => (
          <SceneChip key={key} tone="plain">
            {t(key)}
          </SceneChip>
        ))}
      </div>
    </div>
  );
}

/** An answer typed in the worker's own words, and the counter passing the minimum. */
function QuestionsScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <div className="flex w-[270px] flex-col gap-1.5 text-[11px]">
      <SceneLabel tone="success">{t('trade_eyebrow')}</SceneLabel>
      <span className="text-[13px] font-extrabold">{t('question')}</span>
      <SceneField size="md" className="justify-between">
        <TypeOn>{t('answer')}</TypeOn>
        <Mic aria-hidden className="h-4 w-4 shrink-0 text-[var(--jale-blue-500)]" />
      </SceneField>
      <SceneCycle>
        <span className="font-semibold text-[var(--jale-ink-2)]">{t('cnt0')}</span>
        <span className="font-bold text-[var(--jale-success-text)]">{t('cnt1')}</span>
      </SceneCycle>
    </div>
  );
}

/** Q1 to Q3, going back allowed, then the lock after Q3. */
function LockScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <div className="flex flex-col items-center gap-3 text-xs">
      <div className="flex items-center gap-2">
        <SlideIn as="span">
          <SceneChip tone="plain" size="md">
            {t('q1')}
          </SceneChip>
        </SlideIn>
        <SlideIn as="span">
          <SceneChip tone="plain" size="md">
            {t('q2')}
          </SceneChip>
        </SlideIn>
        <SlideIn as="span" step={2}>
          <SceneChip tone="current" size="md">
            {t('q3')}
          </SceneChip>
        </SlideIn>
      </div>
      <SlideIn>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--jale-ink-2)]">
          <ChevronLeft aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {t('can_back')}
        </span>
      </SlideIn>
      <SlideIn as="span" step={3}>
        <SceneChip tone="warning" size="md">
          <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {t('locked')}
        </SceneChip>
      </SlideIn>
    </div>
  );
}

/** Two jobs for the worker's trade, each one tap from applying. */
function JobsScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  const job = (title: string, meta: string) => (
    <SceneFrame>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-bold">{title}</span>
          <span className="text-[var(--jale-ink-2)]">{meta}</span>
        </span>
        <SceneChip tone="primary" size="sm">
          {t('apply')}
        </SceneChip>
      </div>
    </SceneFrame>
  );
  return (
    <div className="flex w-[260px] flex-col gap-2">
      <SlideIn>{job(t('job1'), t('job1_meta'))}</SlideIn>
      <SlideIn step={2}>{job(t('job2'), t('job2_meta'))}</SlideIn>
    </div>
  );
}

const workerOnboarding: TutorialDefinition = {
  id: 'worker_onboarding',
  role: 'worker',
  namespace: NAMESPACE,
  titleKey: 'title',
  slides: [
    { id: 'minutes', titleKey: 'slides.minutes.title', bodyKey: 'slides.minutes.body', Scene: MinutesScene },
    { id: 'questions', titleKey: 'slides.questions.title', bodyKey: 'slides.questions.body', Scene: QuestionsScene },
    { id: 'lock', titleKey: 'slides.lock.title', bodyKey: 'slides.lock.body', Scene: LockScene },
    { id: 'jobs', titleKey: 'slides.jobs.title', bodyKey: 'slides.jobs.body', Scene: JobsScene },
  ],
};

export default workerOnboarding;
