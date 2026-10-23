'use client';

import { useTranslations } from 'next-intl';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import {
  SceneAvatar,
  SceneChip,
  SceneCycle,
  SceneFrame,
  SceneNote,
  SlideIn,
  TapPulse,
} from '@/components/tutorials/scene';

/**
 * W4, `worker_profile`: what the profile is for, on the worker's first visit
 * to it. Drawn from `W4-ProfileTutorial.dc.html`, slide for slide, with the
 * board's copy: what employers see, documents saved once and reused, and
 * Edit. It ends on the common "Got it".
 *
 * Scenes are decoration (`aria-hidden` throughout, R7): each slide's title
 * and body say everything the picture shows. The person on the card is a
 * made-up sample.
 */

const NAMESPACE = 'tutorial.worker_profile';

/** The card employers see: trade, years, availability and the worker's own words. */
function SeenScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <SceneFrame className="w-[260px]">
      <div className="flex items-center gap-2">
        <SceneAvatar initials="JR" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-bold">{t('sample_name')}</span>
          <span className="text-[var(--jale-ink-2)]">{t('sample_city')}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <SlideIn as="span">
          <SceneChip>{t('trade')}</SceneChip>
        </SlideIn>
        <SlideIn as="span">
          <SceneChip>{t('years')}</SceneChip>
        </SlideIn>
        <SlideIn as="span" step={2}>
          <SceneChip>{t('avail')}</SceneChip>
        </SlideIn>
      </div>
      <SlideIn step={3}>
        <SceneNote>{t('quote')}</SceneNote>
      </SlideIn>
    </SceneFrame>
  );
}

/** A driver license uploaded once, then saved and reused. */
function DocumentsScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <SceneFrame className="w-[260px]">
      <span className="text-xs font-bold">{t('docs_head')}</span>
      <SceneCycle className="h-10">
        <SceneNote tone="empty" className="flex h-10 items-center justify-between gap-2">
          <span className="min-w-0">{t('license')}</span>
          <TapPulse kind="press">
            <SceneChip tone="primary" size="sm">
              {t('upload')}
            </SceneChip>
          </TapPulse>
        </SceneNote>
        <SceneNote tone="success" className="flex h-10 items-center justify-between gap-2">
          <span className="min-w-0">{t('license')} ✓</span>
          <span className="shrink-0 text-[var(--jale-blue-500)]">{t('replace')}</span>
        </SceneNote>
      </SceneCycle>
      <SlideIn step={3}>
        <span className="leading-snug text-[var(--jale-ink-2)]">{t('reused')}</span>
      </SlideIn>
    </SceneFrame>
  );
}

/** Edit is tapped, a skill is added, and the profile is saved. */
function EditScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <SceneFrame className="w-[250px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold">{t('skills')}</span>
        <TapPulse kind="press">
          <SceneChip tone="outline" size="sm">
            {t('edit')}
          </SceneChip>
        </TapPulse>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <SceneChip tone="neutral">{t('sk1')}</SceneChip>
        <SceneChip tone="neutral">{t('sk2')}</SceneChip>
        <SlideIn as="span" step={2}>
          <SceneChip>+ {t('sk3')}</SceneChip>
        </SlideIn>
      </div>
      <SlideIn as="span" step={3} className="self-end">
        <SceneChip tone="success">{t('saved')}</SceneChip>
      </SlideIn>
    </SceneFrame>
  );
}

const workerProfile: TutorialDefinition = {
  id: 'worker_profile',
  role: 'worker',
  namespace: NAMESPACE,
  titleKey: 'title',
  slides: [
    { id: 'seen', titleKey: 'slides.seen.title', bodyKey: 'slides.seen.body', Scene: SeenScene },
    { id: 'documents', titleKey: 'slides.documents.title', bodyKey: 'slides.documents.body', Scene: DocumentsScene },
    { id: 'edit', titleKey: 'slides.edit.title', bodyKey: 'slides.edit.body', Scene: EditScene },
  ],
};

export default workerProfile;
