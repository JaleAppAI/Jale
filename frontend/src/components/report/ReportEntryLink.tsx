'use client';

import { useTranslations } from 'next-intl';
import type { SignedInRole } from '@/lib/report/categories';
import { useOptionalReportProblem, type ReportProblemApi } from './report-problem-context';
import { preloadReportFlow } from './ReportSheet';

/**
 * "Having trouble? Report a problem", under the sign-in and sign-up forms.
 * Nobody is signed in there, so it passes the screen's role; the category
 * comes from the route (the sign-in screens start on "I can't sign in").
 *
 * `brand` is for the navy ground of the worker sign-in; `default` for the
 * themed form column. A button styled as a link: it opens the form in place
 * rather than going anywhere.
 *
 * Renders nothing outside the report provider.
 */
export function ReportEntryLink(props: { role: SignedInRole; tone?: 'default' | 'brand' }) {
    const reporting = useOptionalReportProblem();
    return reporting ? <EntryLink reporting={reporting} {...props} /> : null;
}

function EntryLink({
    reporting,
    role,
    tone = 'default',
}: {
    reporting: ReportProblemApi;
    role: SignedInRole;
    tone?: 'default' | 'brand';
}) {
    const t = useTranslations('report_common');
    const brand = tone === 'brand';

    return (
        <p className={`text-center text-sm ${brand ? 'text-white/70' : 'text-[var(--jale-ink-2)]'}`}>
            <span>{t('entry_link_lead')}</span>{' '}
            <button
                type="button"
                onClick={() => reporting.openReport({ role })}
                onPointerEnter={preloadReportFlow}
                onFocus={preloadReportFlow}
                className={[
                    'inline-flex min-h-11 cursor-pointer items-center rounded-full px-1 font-semibold underline underline-offset-2',
                    'focus-visible:outline-none',
                    brand
                        ? 'text-white hover:decoration-2 focus-visible:ring-2 focus-visible:ring-white/60'
                        : 'text-[var(--jale-blue-700)] hover:decoration-2 focus-visible:shadow-[var(--shadow-focus)]',
                ].join(' ')}
            >
                {t('title')}
            </button>
        </p>
    );
}
