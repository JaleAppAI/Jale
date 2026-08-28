'use client';
import { useTranslations } from 'next-intl';
import { PROGRESS_SEGMENTS, isTrustScreen, type ScreenKey } from '@/lib/onboarding-flow';

/**
 * Eight thin segments, one per screen before the summary.
 *
 * The three question segments are TEAL and the rest blue — not decoration:
 * the questions are the part of onboarding no other channel collects and the
 * part employers actually read, so the rail says "these three are different"
 * before the worker reaches them.
 *
 * `aria-hidden` on the rail with a `role="status"` label beside it: eight
 * abstract bars announce nothing useful, "Step 5 of 8" does.
 */
export function ProgressSegments({ current }: { current: ScreenKey }) {
    const t = useTranslations('worker_onboarding.progress');
    const index = (PROGRESS_SEGMENTS as readonly ScreenKey[]).indexOf(current);
    // The summary is past the end of the rail, so every segment is filled.
    const filledThrough = current === 'done' ? PROGRESS_SEGMENTS.length - 1 : index;
    const total = PROGRESS_SEGMENTS.length;

    return (
        <div className="px-[22px] pt-3">
            <div aria-hidden="true" className="flex gap-1">
                {PROGRESS_SEGMENTS.map((segment, i) => (
                    <i
                        key={segment}
                        className={[
                            'h-1 flex-1 rounded-sm transition-colors duration-300',
                            i <= filledThrough
                                ? (isTrustScreen(segment) ? 'bg-[var(--jale-teal-500)]' : 'bg-[var(--jale-blue-500)]')
                                : 'bg-[var(--jale-paper-2)]',
                        ].join(' ')}
                    />
                ))}
            </div>
            <span role="status" className="sr-only">
                {t('label', { current: Math.max(1, filledThrough + 1), total })}
            </span>
        </div>
    );
}
