'use client';

import { useTranslations } from 'next-intl';
import { FileCheck } from 'lucide-react';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import { SceneChip, SceneFrame, SceneNote, SceneRow, SceneSegments, SlideIn, TapPulse } from '@/components/tutorials/scene';

/**
 * W3, `worker_details`: what happens when an employer asks for the worker's
 * details. Drawn from `W3-DetailsTutorial.dc.html`, slide for slide, with the
 * board's copy: about 5 minutes in three steps, saved documents added for
 * them, then review and send. It opens over the details stepper and ends on
 * "Start" (`cta_last`), because the worker begins the steps right after.
 *
 * Scenes are decoration (`aria-hidden` throughout, R7): each slide's title
 * and body say everything the picture shows.
 */

const NAMESPACE = 'tutorial.worker_details';

/** The employer, about 5 minutes, and the three steps. */
function RequestScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <div className="flex w-[260px] flex-col gap-2.5 text-[11px]">
      <SlideIn>
        <SceneFrame>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-xs font-bold">{t('company')}</span>
            <SceneChip tone="blue">{t('five_min')}</SceneChip>
          </div>
        </SceneFrame>
      </SlideIn>
      <SceneSegments
        count={3}
        tone="teal"
        thickness="md"
        fill="pop"
        labels={[t('step1'), t('step2'), t('step3')]}
      />
    </div>
  );
}

/** A saved driver license slides into its slot, with a way to replace it. */
function SavedScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <SceneFrame className="w-[260px]">
      <span className="text-xs font-bold">{t('slot_name')}</span>
      <SlideIn from="left">
        <SceneNote tone="success" className="flex items-center gap-2">
          <FileCheck aria-hidden className="h-4 w-4 shrink-0 text-[var(--jale-success-text)]" />
          <span className="min-w-0 flex-1">{t('from_vault')}</span>
          <SlideIn as="span" step={3} className="shrink-0">
            <span className="text-[var(--jale-blue-500)]">{t('replace')}</span>
          </SlideIn>
        </SceneNote>
      </SlideIn>
    </SceneFrame>
  );
}

/** Three answers checked, then Send to employer. */
function SendScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  const check = <span className="font-bold text-[var(--jale-success-text)]">✓</span>;
  return (
    <SceneFrame className="w-[250px]">
      <SlideIn>
        <SceneRow trailing={check}>{t('r1')}</SceneRow>
      </SlideIn>
      <SlideIn>
        <SceneRow divider trailing={check}>
          {t('r2')}
        </SceneRow>
      </SlideIn>
      <SlideIn step={2}>
        <SceneRow divider trailing={check}>
          {t('r3')}
        </SceneRow>
      </SlideIn>
      <TapPulse className="mt-1 flex self-stretch">
        <SceneChip tone="primary" size="lg" className="w-full">
          {t('send')}
        </SceneChip>
      </TapPulse>
    </SceneFrame>
  );
}

const workerDetails: TutorialDefinition = {
  id: 'worker_details',
  role: 'worker',
  namespace: NAMESPACE,
  titleKey: 'title',
  slides: [
    { id: 'request', titleKey: 'slides.request.title', bodyKey: 'slides.request.body', Scene: RequestScene },
    { id: 'saved', titleKey: 'slides.saved.title', bodyKey: 'slides.saved.body', Scene: SavedScene },
    { id: 'send', titleKey: 'slides.send.title', bodyKey: 'slides.send.body', Scene: SendScene },
  ],
};

export default workerDetails;
