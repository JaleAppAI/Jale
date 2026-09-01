'use client';
import { useTranslations } from 'next-intl';
import { Skeleton, SkeletonLine } from '@/components/ui/skeleton';
import { OnboardingShell } from './OnboardingHeader';
import { ProgressSegments } from './ProgressSegments';

/**
 * Shared by `loading.tsx` and by the page's own fetch, so the navy band, the
 * progress rail and the card geometry are already in place before the run
 * lands and nothing moves when it does — the same skeleton-parity rule the
 * worker profile page follows.
 *
 * The rail is drawn at the first segment rather than empty: every worker
 * starts there, and an empty rail then a filled one is a visible jump.
 */
export function OnboardingSkeleton() {
    const t = useTranslations('common');
    return (
        <OnboardingShell progress={<ProgressSegments current="terms" />}>
            <div role="status" className="flex flex-1 flex-col">
                <span className="sr-only">{t('loading')}</span>
                <div className="mb-2 flex min-h-[28px] items-center justify-between">
                    <span />
                    <SkeletonLine width="w-10" className="h-2.5" />
                </div>
                <Skeleton className="mb-2 mt-1.5 h-7 w-3/5" />
                <SkeletonLine width="w-4/5" className="mb-[18px]" />
                <div className="flex flex-1 flex-col gap-[18px]">
                    <Skeleton className="h-[52px] w-full rounded-xl" />
                    <Skeleton className="h-[52px] w-full rounded-xl" />
                    <Skeleton className="h-[52px] w-full rounded-xl" />
                </div>
                <Skeleton className="mt-[22px] h-12 w-full rounded-full" />
            </div>
        </OnboardingShell>
    );
}
