import { AuthShell } from '@/components/auth/AuthShell';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * The real `AuthShell` draws the chrome, exactly as `AppShellSkeleton` keeps
 * the real nav: the navy ground, wordmark, back link and language toggle need
 * no data and are usable the instant the route paints, so greying them out
 * would be a lie that also costs a layout shift on the swap.
 *
 * `card={false}` because AuthShell's worker variant already renders the white
 * card; only its CONTENTS are unknown at this point.
 */
export default function Loading() {
    return (
        <AuthShell variant="worker">
            <CenteredCardSkeleton card={false} />
        </AuthShell>
    );
}
