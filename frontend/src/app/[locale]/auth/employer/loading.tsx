import { AuthShell } from '@/components/auth/AuthShell';
import { EmployerBrandPanel } from '@/components/auth/EmployerAuthForm';
import { CenteredCardSkeleton } from '@/components/ui/page-skeletons';

/**
 * Same reasoning as the worker auth loading state: real shell, skeleton body.
 * The brand panel is static copy, so it renders for real rather than as grey
 * blocks -- the desktop split would otherwise show an empty navy column.
 */
export default function Loading() {
    return (
        <AuthShell variant="employer" brand={<EmployerBrandPanel />}>
            <CenteredCardSkeleton card={false} />
        </AuthShell>
    );
}
