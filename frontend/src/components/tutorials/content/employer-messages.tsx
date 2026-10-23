'use client';

import { ArrowLeftRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    SceneBubble,
    SceneChip,
    SceneClock,
    SceneFrame,
    SceneLabel,
    SlideIn,
} from '@/components/tutorials/scene';
import type { TutorialDefinition } from '@/lib/tutorials/types';

/**
 * E4, "Messages": messages travel over WhatsApp, the first one goes out as an
 * invitation, and a reply opens a window for writing freely. It plays the
 * first time an employer with no conversation yet opens one, before the
 * conversation shows (K1.5). Also from Help at any time.
 *
 * Drawn from the `E4-MessagesTutorial.dc.html` board. Sample data only.
 */

const NAMESPACE = 'tutorial.employer_messages';
const SCENES = `${NAMESPACE}.scenes`;

function WhatsAppScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex items-center gap-2.5">
            <SceneFrame className="w-[120px]">
                <SceneLabel>Jale</SceneLabel>
                <SlideIn as="span" className="flex flex-col">
                    <SceneBubble side="end" tone="brand">
                        {t('m1')}
                    </SceneBubble>
                </SlideIn>
                <SlideIn as="span" step={3} className="flex flex-col">
                    <SceneBubble side="start" tone="muted">
                        {t('m2')}
                    </SceneBubble>
                </SlideIn>
            </SceneFrame>
            <SlideIn as="span" step={2}>
                <ArrowLeftRight aria-hidden className="h-5 w-5 text-[var(--jale-blue-500)]" />
            </SlideIn>
            <SceneFrame className="w-[110px]">
                <SceneLabel tone="success">WhatsApp</SceneLabel>
                <SlideIn as="span" step={2} className="flex flex-col">
                    <SceneBubble side="start" tone="muted">
                        {t('m1')}
                    </SceneBubble>
                </SlideIn>
                <SlideIn as="span" step={3} className="flex flex-col">
                    <SceneBubble side="end" tone="whatsapp">
                        {t('m2')}
                    </SceneBubble>
                </SlideIn>
            </SceneFrame>
        </div>
    );
}

function InvitationScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex w-[250px] flex-col gap-2">
            <SlideIn as="span" className="self-start">
                <SceneChip tone="warning">{t('invite_chip')}</SceneChip>
            </SlideIn>
            <SlideIn from="left">
                <SceneFrame>
                    <span className="leading-snug">{t('invite')}</span>
                    <SlideIn as="span" step={2} className="flex">
                        <SceneChip tone="outline" size="sm" className="w-full text-[var(--jale-blue-500)]">
                            {t('reply')}
                        </SceneChip>
                    </SlideIn>
                </SceneFrame>
            </SlideIn>
        </div>
    );
}

function ReplyWindowScene() {
    const t = useTranslations(SCENES);
    return (
        <div className="flex items-center gap-3.5 text-[11px]">
            <SceneClock />
            <div className="flex w-[190px] flex-col gap-1.5">
                <SlideIn as="span" className="flex flex-col">
                    <SceneBubble side="start" tone="whatsapp">
                        {t('m2')}
                    </SceneBubble>
                </SlideIn>
                <SlideIn as="span" step={2} className="self-start">
                    <SceneChip tone="success">{t('window_chip')}</SceneChip>
                </SlideIn>
                <SlideIn as="span" step={3} className="flex flex-col">
                    <SceneBubble side="end" tone="brand">
                        {t('m3')}
                    </SceneBubble>
                </SlideIn>
            </div>
        </div>
    );
}

const employerMessages: TutorialDefinition = {
    id: 'employer_messages',
    role: 'employer',
    namespace: NAMESPACE,
    titleKey: 'title',
    slides: [
        { id: 'whatsapp', titleKey: 'slides.whatsapp.title', bodyKey: 'slides.whatsapp.body', Scene: WhatsAppScene },
        { id: 'invitation', titleKey: 'slides.invitation.title', bodyKey: 'slides.invitation.body', Scene: InvitationScene },
        { id: 'reply_window', titleKey: 'slides.reply_window.title', bodyKey: 'slides.reply_window.body', Scene: ReplyWindowScene },
    ],
};

export default employerMessages;
