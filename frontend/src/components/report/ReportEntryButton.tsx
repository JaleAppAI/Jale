'use client';

import { useTranslations } from 'next-intl';
import { MessageSquareWarning } from 'lucide-react';
import type { ReportCategory, SignedInRole } from '@/lib/report/categories';
import { useOptionalReportProblem, type OpenReportOptions, type ReportProblemApi } from './report-problem-context';
import { preloadReportFlow } from './ReportSheet';

/**
 * Options a screen passes along: a starting category, or the role a
 * signed-out screen implies. Only the ones given are passed on.
 */
export function entryOptions(category?: ReportCategory, role?: SignedInRole): OpenReportOptions {
    const options: OpenReportOptions = {};
    if (category) options.category = category;
    if (role) options.role = role;
    return options;
}

const TONES = {
    // ThemeToggle's recipe: a 40px pill on the themed header.
    default: [
        'border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]',
        'hover:bg-[var(--jale-paper-2)] focus-visible:shadow-[var(--shadow-focus)]',
    ].join(' '),
    // The navy brand bands (onboarding, the shared-job page): white ink, the
    // same 20%-white border and 10%-white hover as their language pills.
    brand: [
        'border border-white/20 bg-transparent text-white/85',
        'hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60',
    ].join(' '),
} as const;

const SIZES = {
    md: 'h-10 gap-1.5 px-3 text-xs',
    sm: 'h-8 gap-1 px-2.5 text-xs',
} as const;

/**
 * "Report a problem" in a header: an icon and a label, the label shortened to
 * "Report" on phones. Its accessible name is always the full phrase, which
 * starts with the short label, so a voice command for what is on screen still
 * finds it. The pointer target is 44px whatever the box (ThemeToggle's
 * `::after` overlay).
 *
 * `compact` is for a header with no room to wrap: icon only below 640px, the
 * short label up to 1024px, the full phrase from there.
 *
 * Renders nothing outside the report provider.
 */
export function ReportEntryButton(props: {
    tone?: keyof typeof TONES;
    size?: keyof typeof SIZES;
    compact?: boolean;
    category?: ReportCategory;
    role?: SignedInRole;
}) {
    const reporting = useOptionalReportProblem();
    return reporting ? <EntryButton reporting={reporting} {...props} /> : null;
}

function EntryButton({
    reporting,
    tone = 'default',
    size = 'md',
    compact = false,
    category,
    role,
}: {
    reporting: ReportProblemApi;
    tone?: keyof typeof TONES;
    size?: keyof typeof SIZES;
    compact?: boolean;
    category?: ReportCategory;
    role?: SignedInRole;
}) {
    const t = useTranslations('report_common');
    const label = t('title');

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={() => reporting.openReport(entryOptions(category, role))}
            onPointerEnter={preloadReportFlow}
            onFocus={preloadReportFlow}
            className={[
                'relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-full font-bold',
                'transition-colors focus-visible:outline-none',
                "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:min-w-11 after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
                TONES[tone],
                SIZES[size],
                // Icon only on phones: a 40px square, like the controls beside it.
                compact ? 'max-sm:w-10 max-sm:px-0' : '',
            ].join(' ')}
        >
            <MessageSquareWarning aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className={compact ? 'hidden sm:inline lg:hidden' : 'sm:hidden'}>{t('entry_short')}</span>
            <span className={compact ? 'hidden lg:inline' : 'hidden sm:inline'}>{label}</span>
        </button>
    );
}
