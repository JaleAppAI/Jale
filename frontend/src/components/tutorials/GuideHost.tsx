'use client';

import { useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { TutorialId, TutorialOutcome } from '@/lib/api/tutorials';
import { roleOfTutorial, type PlayMode } from '@/lib/tutorials/progress';
import { useToast } from '@/components/ui/toast';
import { showDialogNotice, type DialogNoticeTone } from './DialogNotice';
import { getGuide } from './guides/registry';
import type { WalkthroughGuide } from './guides/types';
import { dialogOf } from './spotlight/scope';
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
 * again" mutes the guide as the slide player's does: at once, with a message
 * saying where to turn it back on, and a second one if the save fails. The
 * messages are toasts, except for a guide drawn inside a dialog (the post-job
 * wizard): there they show inside the dialog (`./DialogNotice`), since a
 * toast would sit under its backdrop.
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

/** The dialog the guide `id` is drawn in now, or null when it is on the page. */
function dialogOfGuide(id: TutorialId): HTMLElement | null {
    const layer = Array.from(document.querySelectorAll('[data-spotlight]')).find(
        (element) => element.getAttribute('data-spotlight') === id,
    );
    return layer ? dialogOf(layer) : null;
}

function MutableGuide({ onMute, ...props }: GuideProps & Pick<GuideHostProps, 'onMute'>) {
    const { id } = props;
    const role = roleOfTutorial(id);
    const t = useTranslations('tutorial.help_center');
    const common = useTranslations('common');
    const toast = useToast();
    const mute = useCallback(() => {
        const failed = t(`${role}.save_failed`);
        const dismissLabel = common('feedback.dismiss');
        // Asked now, while the intro is still drawn where the guide is.
        const dialog = dialogOfGuide(id);
        const say = (tone: DialogNoticeTone, message: string) => {
            if (dialog?.isConnected) showDialogNotice(dialog, { tone, message, dismissLabel });
            else if (tone === 'danger') toast.error(message);
            else toast.success(message);
        };
        say('success', t(`${role}.muted_toast`));
        void onMute(id).then((saved) => {
            if (!saved) say('danger', failed);
        });
    }, [common, id, onMute, role, t, toast]);
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
            host={guide.host}
            counterKey={guide.counterKey}
            endKey="tutorial.common.guide.end"
            onMute={onMuteGuide}
            onDismiss={onDismiss}
            onUnavailable={onUnavailable}
        />
    );
}
