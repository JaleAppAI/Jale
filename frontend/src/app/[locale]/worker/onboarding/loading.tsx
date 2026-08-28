import { OnboardingSkeleton } from '@/components/worker/onboarding/OnboardingSkeleton';

/**
 * Route-level loading UI. Same component the page renders while its own fetch
 * is in flight, so the navy band and progress rail are drawn once and never
 * re-drawn — no flash between this unmounting and the flow mounting.
 */
export default function Loading() {
    return <OnboardingSkeleton />;
}
