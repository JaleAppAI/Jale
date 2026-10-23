'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { TutorialDefinition } from '@/lib/tutorials/types';
import {
  SceneBubble,
  SceneChip,
  SceneFrame,
  SceneLabel,
  SceneRow,
  SceneToggle,
  SlideIn,
  TapPulse,
} from '@/components/tutorials/scene';

/**
 * W2, `worker_apply`: how applying works, on the worker's first job page.
 * Drawn from `W2-ApplyTutorial.dc.html`, slide for slide, with the board's
 * copy: Apply and a quick question, documents later, the three statuses that
 * follow, and replies on WhatsApp. It ends on the common "Got it".
 *
 * Scenes are decoration (`aria-hidden` throughout, R7): each slide's title
 * and body say everything the picture shows.
 */

const NAMESPACE = 'tutorial.worker_apply';

/** Apply is tapped, a quick question answered, and the application is in. */
function ApplyScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <div className="flex w-[250px] flex-col gap-2.5 text-[11px]">
      <TapPulse kind="press" at={0.14} className="self-center">
        <SceneChip tone="primary" size="lg">
          {t('apply')}
        </SceneChip>
      </TapPulse>
      <SlideIn>
        <SceneFrame>
          <span className="font-bold">{t('prompt')}</span>
          <div className="flex gap-1.5">
            <SceneToggle step={2} className="flex-1">
              {t('yes')}
            </SceneToggle>
            <SceneToggle on={false} className="flex-1">
              {t('no')}
            </SceneToggle>
          </div>
        </SceneFrame>
      </SlideIn>
      <SlideIn as="span" step={3} className="self-center">
        <SceneChip tone="success">{t('applied')} ✓</SceneChip>
      </SlideIn>
    </div>
  );
}

/** Every document reads "Later": nothing to upload to apply. */
function DocumentsScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  const later = <SceneChip tone="neutral">{t('later')}</SceneChip>;
  return (
    <SceneFrame className="w-[250px]">
      <span className="text-xs font-bold">{t('docs_head')}</span>
      <SlideIn>
        <SceneRow divider trailing={later}>
          {t('doc1')}
        </SceneRow>
      </SlideIn>
      <SlideIn step={2}>
        <SceneRow divider trailing={later}>
          {t('doc2')}
        </SceneRow>
      </SlideIn>
      <SlideIn step={3}>
        <span className="leading-snug text-[var(--jale-ink-2)]">{t('docs_note')}</span>
      </SlideIn>
    </SceneFrame>
  );
}

/** Applied, In conversation, Details needed: each status with what it means. */
function NextScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  const status = (chip: ReactNode, hint: string) => (
    <>
      <span className="self-start">{chip}</span>
      <span className="text-[var(--jale-ink-2)]">{hint}</span>
    </>
  );
  return (
    <div className="flex w-[240px] flex-col items-start gap-2 text-[11px]">
      <SlideIn className="flex flex-col gap-0.5">
        {status(<SceneChip tone="blue">{t('st_applied')}</SceneChip>, t('h_applied'))}
      </SlideIn>
      <SlideIn step={2} className="flex flex-col gap-0.5">
        {status(<SceneChip tone="outline">{t('st_talking')}</SceneChip>, t('h_talking'))}
      </SlideIn>
      <SlideIn step={3} className="flex flex-col gap-0.5">
        {status(<SceneChip tone="warning">{t('st_details')}</SceneChip>, t('h_details'))}
      </SlideIn>
    </div>
  );
}

/** The employer's message lands on WhatsApp, and the worker answers there. */
function WhatsAppScene() {
  const t = useTranslations(`${NAMESPACE}.scene`);
  return (
    <SceneFrame className="w-[230px]">
      <SceneLabel tone="success">{t('whatsapp')}</SceneLabel>
      <SlideIn as="span" className="flex flex-col">
        <SceneBubble side="start" tone="muted">
          {t('emp_msg')}
        </SceneBubble>
      </SlideIn>
      <SlideIn as="span" step={3} className="flex flex-col">
        <SceneBubble side="end" tone="whatsapp">
          {t('my_reply')}
        </SceneBubble>
      </SlideIn>
    </SceneFrame>
  );
}

const workerApply: TutorialDefinition = {
  id: 'worker_apply',
  role: 'worker',
  namespace: NAMESPACE,
  titleKey: 'title',
  slides: [
    { id: 'apply', titleKey: 'slides.apply.title', bodyKey: 'slides.apply.body', Scene: ApplyScene },
    { id: 'documents', titleKey: 'slides.documents.title', bodyKey: 'slides.documents.body', Scene: DocumentsScene },
    { id: 'next', titleKey: 'slides.next.title', bodyKey: 'slides.next.body', Scene: NextScene },
    { id: 'whatsapp', titleKey: 'slides.whatsapp.title', bodyKey: 'slides.whatsapp.body', Scene: WhatsAppScene },
  ],
};

export default workerApply;
