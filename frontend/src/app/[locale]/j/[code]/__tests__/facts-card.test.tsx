// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';

import type { PublicJobActive } from '@/lib/api/publicJob';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { expectNoRawMessageKeys, message } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The public page's half of lane D2, and the only one of the three that is a
 * SERVER component.
 *
 * That is why this file exists at all rather than leaning on the shared
 * `JobFactsCard` unit test: this page had three stacked `KVList` cards (about /
 * "What you need" / "Details") whose fact list had quietly drifted away from
 * the two signed-in pages, and it is rendered for search engines and for a
 * referred stranger who has no account. Nothing else here renders it.
 *
 * An async server component cannot be handed to RTL directly, so it is called
 * and its returned element rendered -- and `getTranslations` is faked with
 * next-intl's own `createTranslator` over the REAL catalogues, so a section
 * label asked of the wrong namespace still fails here rather than shipping.
 * The four client islands are stubbed: each needs `useSearchParams`, which has
 * no meaning outside a request.
 */

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
        company: 'RM Construction',
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
        required_experience_months: null,
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

function sparseJob(over: Partial<PublicJobActive> = {}): PublicJobActive {
    return {
        code: 'ABC123',
        title: 'Helper',
        company: 'RM Construction',
        location: 'Austin, TX',
        job_type: 'full-time',
        description: null,
        required_docs: [],
        status: 'active',
        created_at: '2026-06-01T15:00:00.000Z',
        ...over,
    };
}

async function renderPage(job: PublicJobActive, locale: 'en' | 'es' = 'en') {
    getPublicJob.mockResolvedValue(job);
    // An async server component: call it, then render what it returned.
    const ui = await PublicJobPage({ params: { locale, code: 'ABC123' } });
    return render(ui);
}

/** Every tile in the facts card, in DOM order, as `[label, value]`. */
function tiles(container: HTMLElement): [string, string][] {
    return Array.from(container.querySelectorAll('dl > div')).map((tile) => [
        tile.querySelector('dt')?.textContent ?? '',
        tile.querySelector('dd')?.textContent ?? '',
    ]);
}

const t = (key: string) => message(`public_job.${key}`);

describe('public job page — the facts card', () => {
    it('keeps the hero: status, title, company and location', async () => {
        await renderPage(fullJob());

        expect(screen.getByText(t('eyebrow'))).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: 'Drywall Finisher' })).toBeInTheDocument();
        expect(screen.getByText('RM Construction · Austin, TX · Austin, TX')).toBeInTheDocument();
    });

    it('sets pay as the one headline figure inside the card, not a hero strip', async () => {
        const { container } = await renderPage(fullJob());

        expect(screen.getAllByText('$22–$26/hr')).toHaveLength(1);
        // The figure now lives in the card, under its panel header -- not in
        // the `<article>` hero it used to have its own tinted strip in.
        expect(container.querySelector('article')?.textContent).not.toContain('$22–$26/hr');
        expect(tiles(container).map(([label]) => label)).not.toContain(t('pay_range'));
    });

    it('renders the eight facts as dt/dd tiles in the same locked order the app shows', async () => {
        const { container } = await renderPage(fullJob());

        expect(tiles(container)).toEqual([
            [t('shift_schedule'), 'Mon, Tue, Wed · 7:00 AM – 4:00 PM'],
            [t('duration'), message('common.duration_bucket.1_3m')],
            [t('start_date'), 'June 15, 2026'],
            [t('openings'), '3'],
            [t('facts.location'), 'Austin, TX'],
            // Was the raw `drywall` slug title-cased by CSS: `public_job` had no
            // per-slug catalogue, so this page could not translate a trade at all.
            [t('trade_category'), message('employer_dashboard.modal.trade.drywall')],
            [t('required_experience'), '3 years'],
            [t('language_preference'), t('language_es')],
        ]);
    });

    it('renders the section labels as h3s under one panel title', async () => {
        await renderPage(fullJob());

        expect(screen.getByRole('heading', { level: 2, name: t('facts.panel_title') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('facts.schedule') })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: t('facts.where') })).toBeInTheDocument();
    });

    it('states requirements, certifications and documents as chips, each with a readable state', async () => {
        await renderPage(fullJob());

        const chips = screen.getByRole('heading', { level: 3, name: t('facts.requirements') })
            .parentElement!.querySelectorAll('li');
        const required = message('common.requirement_state.required');
        expect(Array.from(chips).map((chip) => chip.textContent)).toEqual([
            `${t('transportation')}, ${required}`,
            `${t('work_authorization')}, ${required}`,
            // The proof demand survives the move to a chip: it is a second,
            // independent ask that "Required" does not say.
            `OSHA 10 · ${message('worker_job_detail.what_you_need.proof_needed')}, ${required}`,
            `Scaffold, ${message('common.requirement_state.optional')}`,
            `${t('doc_resume')}, ${required}`,
        ]);
    });

    it('renders the description under an About label carrying the posted date', async () => {
        await renderPage(fullJob());

        expect(screen.getByText('Framing and drywall on a new build.')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', { level: 3, name: /About the job · posted Jun 1, 2026/ }),
        ).toBeInTheDocument();
    });

    it('keeps the apply CTAs and the trust footer', async () => {
        await renderPage(fullJob());

        expect(screen.getByTestId('apply-button')).toBeInTheDocument();
        expect(screen.getByTestId('web-apply-button')).toBeInTheDocument();
        expect(screen.getByText(t('about_jale'))).toBeInTheDocument();
    });

    it('renders no raw message key, in either locale', async () => {
        await renderPage(fullJob());
        expectNoRawMessageKeys();
        document.body.innerHTML = '';

        await renderPage(fullJob(), 'es');
        expect(
            screen.getByRole('heading', { level: 3, name: message('public_job.facts.schedule', 'es') }),
        ).toBeInTheDocument();
        expectNoRawMessageKeys();
    });

    describe('a sparse job', () => {
        it('omits the pay headline, the requirement chips and the About section', async () => {
            await renderPage(sparseJob());

            expect(screen.queryByText(t('pay_range'))).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: t('facts.requirements') })).toBeNull();
            expect(screen.queryByRole('heading', { level: 3, name: /About the job/ })).toBeNull();
        });

        it('still shows the start tile, muted, saying the date is unconfirmed', async () => {
            const { container } = await renderPage(sparseJob());

            expect(tiles(container)).toEqual([
                [t('start_date'), t('facts.start_unknown')],
                [t('facts.location'), 'Austin, TX'],
            ]);
            const dd = container.querySelector('dl > div dd');
            expect(dd?.className).toContain('--jale-ink-2');
        });
    });
});
