'use client';

import { useEffect } from 'react';
import type { TourId, TutorialOutcome } from '@/lib/api/tutorials';

export type AppTourHostProps = {
    id: TourId;
    /** How the person closed the tour: `completed` (the last step's Got it) or `skipped`. */
    onDismiss: (outcome: TutorialOutcome) => void;
    /** The tour has nothing to show; the play ends without an outcome. */
    onUnavailable: () => void;
};

/**
 * The app tour overlay's chunk: what the progress provider fetches with
 * `React.lazy` when a tour id is about to play. Nothing else may import this
 * module statically.
 *
 * Contract stub from the hotfix base: no tour is drawn yet, so a tour play
 * ends at once and records nothing.
 */
export default function AppTourHost({ onUnavailable }: AppTourHostProps) {
    useEffect(() => {
        onUnavailable();
    }, [onUnavailable]);
    return null;
}
