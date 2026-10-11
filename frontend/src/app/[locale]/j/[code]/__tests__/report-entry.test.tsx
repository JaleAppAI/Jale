// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';

import type { PublicJobActive } from '@/lib/api/publicJob';
import en from '@/messages/en.json';
import es from '@/messages/es.json';

/*
 * The shared-job page's navy band is the page's only chrome, so it is where a
 * visitor reports a problem from: the report entry sits beside the language
 * toggle, in the band's brand tone, on both the open and the closed job.
 * The entry itself is stubbed here (it is a client island tested on its own);
 * this suite pins where the page mounts it.
 */

vi.mock('@/components/report/ReportEntryButton', () => ({
    ReportEntryButton: ({ tone }: { tone?: string }) => <div data-testid="report-entry" data-tone={tone} />,
}));

const catalogues = { en, es } as const;

/**
 * `createTranslator`'s `namespace` is typed as a literal union over the
 * catalogue's own namespace paths, so a `string` variable cannot satisfy it --
 * the options object is cast once, here, rather than at each of the page's five
 * `getTranslations` call sites. The translator itself is real, so a missing key
 * still resolves the way it would in the browser.
 */
type CreateTranslatorOptions = Parameters<typeof createTranslator>[0];

vi.mock('next-intl/server', () => ({
    getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) =>
        createTranslator({
            locale,
            messages: catalogues[locale as keyof typeof catalogues],
            namespace,
            onError: () => {},
        } as unknown as CreateTranslatorOptions),
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('../ApplyButton', () => ({
    ApplyButton: () => <div data-testid="apply-button" />,
    ApplyButtonSkeleton: () => null,
}));

vi.mock('../WebApplyButton', () => ({
    WebApplyButton: () => <div data-testid="web-apply-button" />,
    WebApplyButtonSkeleton: () => null,
}));

vi.mock('../LocaleToggle', () => ({
    LocaleToggle: () => <div data-testid="locale-toggle" />,
    LocaleToggleFallback: () => null,
}));

vi.mock('../ReferralContext', () => ({
    ReferralContext: () => null,
    ReferralRibbonSkeleton: () => null,
}));

const getPublicJob = vi.fn();
vi.mock('@/lib/api/publicJob', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/publicJob')>()),
    getPublicJob: (...args: unknown[]) => getPublicJob(...args),
}));

// Below every `vi.mock` on purpose (they hoist).
import PublicJobPage from '../page';

function fullJob(over: Partial<PublicJobActive> = {}): PublicJobActive {
    return {
        code: 'ABC123',
        id: 'job-1',
        title: 'Drywall Finisher',
        company: 'NB Construction',
        location: 'Austin, TX',
        city: 'Austin',
        state_region: 'TX',
        job_type: 'full-time',
        description: 'Framing and drywall on a new build.',
        pay_min: 22,
        pay_max: 26,
        pay_interval: 'hourly',
        start_date: '2026-06-15',
        expected_duration_bucket: '1_3m',
        work_days: ['mon', 'tue', 'wed'],
        shift_start: '07:00',
        shift_end: '16:00',
        trade_category: 'drywall',
        required_experience_years: 3,
        // The canonical total the server derives for 3 years (job-fields.ts
        // sets months = years * 12), not null: this is what the API returns.
        required_experience_months: 36,
        language_preference: ['es'],
        transportation_required: true,
        work_authorization_required: true,
        number_of_workers_needed: 3,
        required_docs: ['resume'],
        certification_requirements: [
            { name: 'OSHA 10', tier: 'required', proof_required: true },
            { name: 'Scaffold', tier: 'optional', proof_required: false },
        ],
        status: 'active',
        created_at: '2026-06-01T15:00:00.000Z',
        ...over,
    };
}

async function renderPage(job: PublicJobActive) {
    getPublicJob.mockResolvedValue(job);
    const ui = await PublicJobPage({ params: Promise.resolve({ locale: 'en', code: 'ABC123' }) });
    return render(ui);
}

describe('public job page: the report entry', () => {
    it('sits in the brand band, beside the language toggle', async () => {
        await renderPage(fullJob());
        const entry = screen.getByTestId('report-entry');
        expect(entry).toHaveAttribute('data-tone', 'brand');
        const band = entry.closest('header');
        expect(band).not.toBeNull();
        expect(band?.contains(screen.getByTestId('locale-toggle'))).toBe(true);
    });

    it('is there on a closed job too', async () => {
        getPublicJob.mockResolvedValue({
            code: 'ABC123',
            title: 'Drywall Finisher',
            company: 'NB Construction',
            location: 'Austin, TX',
            status: 'closed',
            applications_closed: true,
        });
        render(await PublicJobPage({ params: Promise.resolve({ locale: 'en', code: 'ABC123' }) }));
        expect(screen.getByTestId('report-entry')).toBeInTheDocument();
    });
});
