// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The real dataset is a 3 MB JSON import; the picker's contract (debounced
// query -> suggestion list) is what this screen depends on, so that is what is
// faked. `location-search.test.ts` covers the search itself.
vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async (q: string) => (
        q.toLowerCase().startsWith('el p')
            ? [{
                label: 'El Paso, TX 79901', cityKey: 'el-paso-tx', zip: '79901',
                city: 'El Paso', state: 'TX', latitude: 31.7, longitude: -106.4,
                source: 'geocoded_zip' as const,
            }]
            : []
    )),
    locationDatasetFailed: () => false,
}));

import { AboutYouStep } from '@/components/worker/onboarding/AboutYouStep';
import { EMPTY_LOCATION_DRAFT, type OnboardingDraft } from '@/lib/onboarding-flow';
import { interpolate, message, renderIntl } from './render-intl';

const draft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
    firstName: '', lastName: '', location: { ...EMPTY_LOCATION_DRAFT },
    trade: null, customTrade: '', experience: null, transportation: null, availability: null,
    answers: ['', '', ''],
    ...overrides,
});

function props(overrides: Partial<Parameters<typeof AboutYouStep>[0]> = {}) {
    return {
        draft: draft(),
        // The engine's cursor: the first of this screen's two steps, so both
        // are still ahead of it and the batch is the full one.
        stepKey: 'profile.name',
        onDraftChange: vi.fn(),
        pendingConfirm: null,
        rejection: null,
        saving: false,
        error: null,
        onBack: vi.fn(),
        onSubmit: vi.fn(),
        ...overrides,
    } satisfies Parameters<typeof AboutYouStep>[0];
}

describe('AboutYouStep', () => {
    it('renders both name fields and the location field in English', () => {
        renderIntl(<AboutYouStep {...props()} />);
        expect(screen.getByRole('heading', { name: message('worker_onboarding.about.title') })).toBeInTheDocument();
        expect(screen.getByLabelText(message('worker_onboarding.about.first_name'))).toBeInTheDocument();
        expect(screen.getByLabelText(message('worker_onboarding.about.last_name'))).toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.about.location_help'))).toBeInTheDocument();
    });

    it('renders in Spanish', () => {
        renderIntl(<AboutYouStep {...props()} />, 'es');
        expect(screen.getByRole('heading', { name: message('worker_onboarding.about.title', 'es') })).toBeInTheDocument();
        expect(screen.getByLabelText(message('worker_onboarding.about.first_name', 'es'))).toBeInTheDocument();
    });

    it('keeps Continue disabled until both names AND a location are there', () => {
        const { rerender } = renderIntl(<AboutYouStep {...props()} />);
        const cta = () => screen.getByRole('button', { name: message('worker_onboarding.about.cta') });
        expect(cta()).toBeDisabled();

        rerender(
            <AboutYouStep {...props({ draft: draft({ firstName: 'David', lastName: 'Castellanos' }) })} />,
        );
        expect(cta()).toBeDisabled();
    });

    it('posts profile.name and profile.location as one batch', async () => {
        const onSubmit = vi.fn();
        renderIntl(<AboutYouStep {...props({
            draft: draft({
                firstName: 'David',
                lastName: 'Castellanos',
                location: { text: 'El Paso, TX 79901', city: 'El Paso', state: 'TX', zip: '79901' },
            }),
            onSubmit,
        })} />);
        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.about.cta') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'profile.name', value: 'David Castellanos' },
            { stepKey: 'profile.location', value: { kind: 'city_state', city: 'El Paso', state: 'TX' } },
        ]);
    });

    it('marks a bare 5-digit box as a ZIP', () => {
        renderIntl(<AboutYouStep {...props({
            draft: draft({ firstName: 'D', lastName: 'C', location: { text: '79901', city: null, state: null, zip: null } }),
        })} />);
        expect(screen.getByText(`· ${message('worker_onboarding.about.zip')}`)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: message('worker_onboarding.about.cta') })).toBeEnabled();
    });

    it('types into a name field through the draft callback', async () => {
        const onDraftChange = vi.fn();
        renderIntl(<AboutYouStep {...props({ onDraftChange })} />);
        await userEvent.type(screen.getByLabelText(message('worker_onboarding.about.first_name')), 'D');
        expect(onDraftChange).toHaveBeenCalledWith({ firstName: 'D' });
    });

    it('asks the engine\'s location confirmation instead of Continue when one is pending', async () => {
        const onSubmit = vi.fn();
        renderIntl(<AboutYouStep {...props({
            pendingConfirm: { city: 'San Antonio', state: 'Texas' },
            onSubmit,
        })} />);

        expect(screen.getByText(interpolate(
            message('worker_onboarding.about.confirm_title'),
            { city: 'San Antonio', state: 'Texas' },
        ))).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: message('worker_onboarding.about.confirm_yes') }));
        expect(onSubmit).toHaveBeenCalledWith([
            { stepKey: 'profile.location', value: { kind: 'confirm', accept: true } },
        ]);
    });

    it('shows a rejected step inline against the field that owns it', () => {
        renderIntl(<AboutYouStep {...props({
            rejection: { stepKey: 'profile.location', reason: 'unknown_city' },
        })} />);
        const alerts = screen.getAllByRole('alert');
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0]).toHaveTextContent(message('worker_onboarding.rejection.generic'));
    });
});
