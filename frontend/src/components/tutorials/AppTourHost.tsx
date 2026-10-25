'use client';

import type { TourId, TutorialOutcome } from '@/lib/api/tutorials';
import { AppTour } from './AppTour';

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
 * module statically, and it is the only module that imports the tour's UI
 * (`AppTour` and its step model), so none of it reaches a page's own bundle.
 */
export default function AppTourHost({ id, onDismiss, onUnavailable }: AppTourHostProps) {
    return <AppTour id={id} onDismiss={onDismiss} onUnavailable={onUnavailable} />;
}
