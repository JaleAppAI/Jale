import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { ProfileSkeleton } from '@/components/ui/profile-skeleton';

export default function Loading() {
    return (
        <AppShellSkeleton role="employer">
            <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
                {/* Same props as the page's own `showSkeleton` branch, so the
                    server render and the client fetch draw one picture. */}
                <ProfileSkeleton sections={[4, 3, 2]} />
            </div>
        </AppShellSkeleton>
    );
}
