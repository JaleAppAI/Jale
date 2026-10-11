'use client';

import { useTranslations } from 'next-intl';

/**
 * "Report this problem", beside "Try again" on an error screen. A quiet text
 * action, so "Try again" stays the obvious first move.
 *
 * Deliberately light (no sheet import): `ErrorState` renders it, and that
 * primitive is on most screens.
 */
export function ReportProblemAction({ onReport }: { onReport: () => void }) {
    const t = useTranslations('report_common');
    return (
        <button
            type="button"
            onClick={onReport}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-full px-4 text-sm font-semibold text-[var(--jale-blue-700)] underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
            {t('error_action')}
        </button>
    );
}
