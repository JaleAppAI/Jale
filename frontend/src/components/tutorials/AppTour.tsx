'use client';

import type { TourId, TutorialOutcome } from '@/lib/api/tutorials';
import { Spotlight } from './spotlight/Spotlight';
import { TOUR_INTRO, TOUR_STEPS } from './app-tour-steps';

/**
 * The app tour: a welcome card, then one callout per part of the app, drawn by
 * the spotlight engine (`./spotlight/Spotlight`) from the tour's own step list
 * (`./app-tour-steps`). The first step's welcome card has "Show me around" and
 * "Not now"; "Not now", Skip and Escape skip the tour, the last step's Got it
 * completes it.
 */

export type AppTourProps = {
    id: TourId;
    onDismiss: (outcome: TutorialOutcome) => void;
    onUnavailable: () => void;
};

export function AppTour({ id, onDismiss, onUnavailable }: AppTourProps) {
    return (
        <Spotlight
            name={id}
            steps={TOUR_STEPS[id]}
            intro={TOUR_INTRO[id]}
            onDismiss={onDismiss}
            onUnavailable={onUnavailable}
        />
    );
}
