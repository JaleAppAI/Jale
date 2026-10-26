// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';

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
import { message, renderIntl, type TestLocale } from './render-intl';

/*
 * A city typed but never picked from the list is not a location: Continue
 * stays off, as before. What changed is that the worker is now TOLD, once they
 * leave the field with that text in it, the way the employer's job form tells
 * an employer after Next: a message where the hint was, and a ring on the box.
 */

const START: OnboardingDraft = {
    firstName: 'Ana', lastName: 'Lopez', location: { ...EMPTY_LOCATION_DRAFT },
    trade: null, customTrade: '', experience: null, transportation: null, availability: null,
    answers: ['', '', ''],
};

function Screen() {
    const [draft, setDraft] = useState(START);
    return (
        <>
            <AboutYouStep
                draft={draft}
                stepKey="profile.name"
                onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                pendingConfirm={null}
                rejection={null}
                saving={false}
                error={null}
                onBack={vi.fn()}
                onSubmit={vi.fn()}
            />
            <button type="button">Elsewhere</button>
        </>
    );
}

function setup(locale: TestLocale = 'en') {
    renderIntl(<Screen />, locale);
    const box = screen.getByRole('combobox');
    const cta = screen.getByRole('button', { name: message('worker_onboarding.about.cta', locale) });
    return { box, cta };
}

async function typeAndLeave(box: HTMLElement, text: string) {
    act(() => box.focus());
    fireEvent.change(box, { target: { value: text } });
    // Past the picker's 150 ms debounce, so its list has come and gone.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    fireEvent.blur(box, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
}

describe('AboutYouStep: a city typed but not picked', () => {
    it('says so once the worker leaves the field, and Continue stays off', async () => {
        const { box, cta } = setup();
        await typeAndLeave(box, 'El Paso');

        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.about.location_pick'));
        expect(box).toHaveAttribute('aria-invalid', 'true');
        expect(cta).toBeDisabled();
    });

    it('says so in Spanish too', async () => {
        const { box } = setup('es');
        await typeAndLeave(box, 'El Paso');
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_onboarding.about.location_pick', 'es'));
    });

    it('says nothing while the worker is still typing in the field', () => {
        const { box } = setup();
        act(() => box.focus());
        fireEvent.change(box, { target: { value: 'El Paso' } });
        expect(screen.queryByText(message('worker_onboarding.about.location_pick'))).not.toBeInTheDocument();
        expect(screen.getByText(message('worker_onboarding.about.location_help'))).toBeInTheDocument();
    });

    it('says nothing for an empty field the worker only passed through', () => {
        const { box } = setup();
        act(() => box.focus());
        fireEvent.blur(box);
        expect(screen.queryByText(message('worker_onboarding.about.location_pick'))).not.toBeInTheDocument();
    });

    it('counts a typed 5-digit ZIP and says nothing', async () => {
        const { box, cta } = setup();
        await typeAndLeave(box, '79901');
        expect(screen.queryByText(message('worker_onboarding.about.location_pick'))).not.toBeInTheDocument();
        expect(cta).toBeEnabled();
    });

    it('clears once a city is picked from the list', async () => {
        const { box, cta } = setup();
        await typeAndLeave(box, 'El Paso');
        expect(screen.getByText(message('worker_onboarding.about.location_pick'))).toBeInTheDocument();

        act(() => box.focus());
        fireEvent.change(box, { target: { value: 'El Pa' } });
        const option = await screen.findByRole('option', { name: 'El Paso, TX 79901' });
        fireEvent.mouseDown(option);

        expect(screen.queryByText(message('worker_onboarding.about.location_pick'))).not.toBeInTheDocument();
        expect(cta).toBeEnabled();
    });
});
