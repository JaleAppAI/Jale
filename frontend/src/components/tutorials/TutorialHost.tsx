'use client';

import { useEffect } from 'react';
import type { TutorialId, TutorialOutcome } from '@/lib/api/tutorials';
import type { PlayMode } from '@/lib/tutorials/progress';
import { getTutorial } from '@/lib/tutorials/registry';
import type { TutorialSceneProps } from '@/lib/tutorials/types';
import { TutorialPlayer } from './TutorialPlayer';

export type TutorialHostProps = {
    id: TutorialId;
    vars?: TutorialSceneProps['vars'];
    /** Why it is playing: an `always` play offers "Don't show this again". */
    mode: PlayMode;
    /** Turns `id` off for this account; resolves false when that was not saved. */
    onMute: (id: TutorialId) => Promise<boolean>;
    /** How the person closed the tutorial (see `TutorialPlayer`). */
    onDismiss: (outcome: TutorialOutcome) => void;
    /** The tutorial has nothing to show; the play ends without an outcome. */
    onUnavailable: () => void;
};

/**
 * The player together with every tutorial's content and scenes: the code the
 * progress provider fetches with `React.lazy` only when a tutorial is about
 * to play, so a page that never plays one (a public page above all) never
 * downloads it. Nothing else may import this module statically.
 *
 * A tutorial with no slides (`registry.test.ts` rules it out for the real
 * content) ends at once, so a play never hangs with nothing on screen.
 */
export default function TutorialHost({ id, vars, mode, onMute, onDismiss, onUnavailable }: TutorialHostProps) {
    const definition = getTutorial(id);
    const playable = definition !== undefined && definition.slides.length > 0;

    useEffect(() => {
        if (!playable) onUnavailable();
    }, [playable, onUnavailable]);

    if (!playable) return null;
    return (
        <TutorialPlayer
            definition={definition}
            vars={vars}
            mode={mode}
            onMute={() => onMute(id)}
            onDismiss={onDismiss}
        />
    );
}
