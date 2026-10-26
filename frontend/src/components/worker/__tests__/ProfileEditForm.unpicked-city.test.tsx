// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

vi.mock('@/lib/location-search', () => ({
    queryLocations: vi.fn(async (q: string) => (
        q.toLowerCase().startsWith('el p')
            ? [{
                label: 'El Paso, TX', cityKey: 'el-paso-tx', zip: '79901',
                city: 'El Paso', state: 'TX', latitude: 31.7, longitude: -106.4,
                source: 'geocoded_zip' as const,
            }]
            : []
    )),
    locationDatasetFailed: () => false,
}));

import type { WorkerProfileData, WorkerProfilePatch } from '@/lib/api/worker';
import { message, renderIntl, type TestLocale } from '@/components/worker/onboarding/__tests__/render-intl';
import { ProfileEditForm } from '../ProfileEditForm';

/*
 * The cities a worker wants to work in are chips, and only a city picked from
 * the list becomes one. Text typed in the box and never picked used to be
 * dropped on Save with nothing said, so the worker believed the city was
 * added. Now the form says so when they leave the box, and Save refuses until
 * the city is picked or the box is cleared.
 */

const BASE: WorkerProfileData = {
    id: 'worker-1',
    phone: '+15555550100',
    full_name: 'Test Worker',
    skills: ['Framing'],
    availability: 'part_time',
    years_experience: 4,
    location: 'Austin, TX',
    bio: null,
    certifications: [],
    preferred_cities: [],
    main_trade: 'carpenter',
    main_trade_other: null,
};

function renderForm(locale: TestLocale = 'en') {
    const onSave = vi.fn<(patch: WorkerProfilePatch) => Promise<void>>(async () => {});
    renderIntl(
        <>
            <ProfileEditForm initial={BASE} onCancel={vi.fn()} onSave={onSave} />
            <button type="button">Elsewhere</button>
        </>,
        locale,
    );
    return { onSave };
}

const citiesBox = (locale: TestLocale = 'en') =>
    screen.getByPlaceholderText(message('common.city_multi_placeholder', locale));
const unpicked = (locale: TestLocale = 'en') => message('common.city_multi_unpicked', locale);
const save = (locale: TestLocale = 'en') =>
    fireEvent.click(screen.getByRole('button', { name: message('worker_profile.edit.save', locale) }));

async function type(box: HTMLElement, text: string) {
    act(() => box.focus());
    fireEvent.change(box, { target: { value: text } });
    // Past the picker's 150 ms debounce, so its list has arrived.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
}

describe('ProfileEditForm: a city typed but not picked', () => {
    it('refuses Save and says to pick the city or clear the box', async () => {
        const { onSave } = renderForm();
        await type(citiesBox(), 'El Paso');
        save();

        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(unpicked())).toBeInTheDocument();
        expect(citiesBox()).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByRole('alert')).toHaveTextContent(message('worker_profile.edit.preferred_cities_label'));
    });

    it('says so once the worker leaves the box, and not while they type', async () => {
        renderForm();
        await type(citiesBox(), 'El Paso');
        expect(screen.queryByText(unpicked())).not.toBeInTheDocument();

        fireEvent.blur(citiesBox(), { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
        expect(screen.getByText(unpicked())).toBeInTheDocument();
    });

    it('saves the city once it is picked from the list', async () => {
        const { onSave } = renderForm();
        await type(citiesBox(), 'El Paso');
        fireEvent.mouseDown(screen.getByRole('option', { name: 'El Paso, TX' }));
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].preferred_cities).toEqual([
            expect.objectContaining({ city_key: 'el-paso-tx', city: 'El Paso', state: 'TX' }),
        ]);
        expect(screen.queryByText(unpicked())).not.toBeInTheDocument();
    });

    it('saves once the box is cleared instead', async () => {
        const { onSave } = renderForm();
        await type(citiesBox(), 'El Paso');
        save();
        expect(onSave).not.toHaveBeenCalled();

        await type(citiesBox(), '');
        save();
        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0][0].preferred_cities).toEqual([]);
    });

    it('says it in Spanish too', async () => {
        renderForm('es');
        await type(citiesBox('es'), 'El Paso');
        save('es');
        expect(screen.getByText(unpicked('es'))).toBeInTheDocument();
    });
});
