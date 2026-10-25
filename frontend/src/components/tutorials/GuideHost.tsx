'use client';

import { useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { TutorialId, TutorialOutcome } from '@/lib/api/tutorials';
import { roleOfTutorial, type PlayMode } from '@/lib/tutorials/progress';
import { useToast } from '@/components/ui/toast';
import { getGuide } from './guides/registry';
import type { WalkthroughGuide } from './guides/types';
import { Spotlight } from './spotlight/Spotlight';

export type GuideHostProps = {
    id: TutorialId;
    /** Why it is playing: an `always` play offers "Don't show this again" on the intro. */
    mode: PlayMode;
    /** Turns `id` off for this account; resolves false when that was not saved. */
    onMute: (id: TutorialId) => Promise<boolean>;
    /** `completed` (the last step done) or `skipped` (ended any other way). */
    onDismiss: (outcome: TutorialOutcome) => void;
    /** No guide, or its first control never showed; the play ends without an outcome. */
    onUnavailable: () => void;
};

/**
 * The step-by-step guides' chunk: what the progress provider fetches with
 * `React.lazy` when a walkthrough play is about to show. Nothing else may
 * import this module statically, and it is the only module that imports the
 * guides (`./guides/registry`), so none of them reaches a page's own bundle.
 *
 * It draws the task's guide with the spotlight engine in lazy mode, with the
 * shared intro and end buttons in the role's own voice. "Don't show this
 * again" mutes the guide as the slide player's does: at once, with a toast
 * saying where to turn it back on, and a second toast if the save fails.
 */
export default function GuideHost({ id, mode, onMute, onDismiss, onUnavailable }: GuideHostProps) {
    const guide = getGuide(id);

    useEffect(() => {
        if (guide === null) onUnavailable();
    }, [guide, onUnavailable]);

    if (guide === null) return null;
    const props = { id, guide, onDismiss, onUnavailable };
    // Only an "every time" play offers "Don't show this again", and only it
    // needs the toasts that go with it.
    return mode === 'always' ? <MutableGuide {...props} onMute={onMute} /> : <Guide {...props} />;
}

type GuideProps = Pick<GuideHostProps, 'id' | 'onDismiss' | 'onUnavailable'> & { guide: WalkthroughGuide };

function MutableGuide({ onMute, ...props }: GuideProps & Pick<GuideHostProps, 'onMute'>) {
    const { id } = props;
    const role = roleOfTutorial(id);
    const t = useTranslations('tutorial.help_center');
    const toast = useToast();
    const mute = useCallback(() => {
        const failed = t(`${role}.save_failed`);
        toast.success(t(`${role}.muted_toast`));
        void onMute(id).then((saved) => {
            if (!saved) toast.error(failed);
        });
    }, [id, onMute, role, t, toast]);
    return <Guide {...props} onMuteGuide={mute} />;
}

function Guide({ id, guide, onDismiss, onUnavailable, onMuteGuide }: GuideProps & { onMuteGuide?: () => void }) {
    const role = roleOfTutorial(id);
    return (
        <Spotlight
            name={id}
            resolve="lazy"
            steps={guide.steps}
            intro={{
                ...guide.intro,
                startKey: `tutorial.common.guide.${role}.start`,
                notNowKey: 'tutorial.common.guide.self',
                muteKey: 'tutorial.help_center.mute',
            }}
            done={guide.done}
            counterKey={guide.counterKey}
            endKey="tutorial.common.guide.end"
            onMute={onMuteGuide}
            onDismiss={onDismiss}
            onUnavailable={onUnavailable}
        />
    );
}
