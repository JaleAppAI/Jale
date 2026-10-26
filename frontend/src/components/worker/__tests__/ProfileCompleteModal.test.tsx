// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import { message, renderIntl, type TestLocale } from '@/components/worker/onboarding/__tests__/render-intl';
import { ProfileCompleteModal, type ProfileCompleteValues } from '../ProfileCompleteModal';

/*
 * The profile gate that opens when a worker taps Apply with an incomplete
 * profile. Nothing is saved that the worker did not choose: an unset
 * availability starts empty and must be picked (it used to start on
 * Full-time, which "Save and apply" then saved unseen), and an empty years
 * box sends no number instead of 0. The same rule as the profile edit form.
 */

const m = (key: string, locale: TestLocale = 'en') => message(`worker_profile.complete_modal.${key}`, locale);

/** The profile as the server answers it: unset fields are null (the page passes it through as the prefill). */
type StoredProfile = Record<string, string | number | string[] | null>;

function renderGate(initial: StoredProfile, locale: TestLocale = 'en') {
    const onSubmit = vi.fn<(values: ProfileCompleteValues) => Promise<void>>(async () => {});
    const view = renderIntl(
        <ProfileCompleteModal open initial={initial as unknown as Partial<ProfileCompleteValues>} onClose={vi.fn()} onSubmit={onSubmit} />,
        locale,
    );
    return { ...view, onSubmit };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
const submit = (locale: TestLocale = 'en') => fireEvent.click(screen.getByRole('button', { name: m('submit', locale) }));
const lastValues = (onSubmit: ReturnType<typeof renderGate>['onSubmit']) => onSubmit.mock.calls.at(-1)?.[0] as ProfileCompleteValues;

const SPARSE: StoredProfile = { full_name: 'Test Worker', skills: [], availability: null, location: 'El Paso, TX', years_experience: null };

describe('ProfileCompleteModal — nothing is saved that the worker did not choose', () => {
    it('shows an unset availability as an empty choice, not as Full-time', () => {
        renderGate(SPARSE);
        const availability = field(m('availability_label')) as HTMLSelectElement;
        expect(availability.value).toBe('');
        expect(availability.selectedOptions[0]).toHaveTextContent(message('worker_profile.edit.availability_choose'));
    });

    it('does not save an unset availability as Full-time: it asks for one instead', () => {
        const { onSubmit } = renderGate(SPARSE);
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing, forms' } });
        submit();

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByText(`Please add: ${m('availability_label')}`)).toBeInTheDocument();
        expect(screen.getByText(message('worker_profile.errors.required'))).toBeInTheDocument();
    });

    it('saves the availability the worker then picks', () => {
        const { onSubmit } = renderGate(SPARSE);
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing, forms' } });
        fireEvent.change(field(m('availability_label')), { target: { value: 'weekends' } });
        submit();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(lastValues(onSubmit)).toMatchObject({ availability: 'weekends', skills: ['finishing', 'forms'] });
    });

    it('sends no years of experience when the box is empty, rather than 0', () => {
        const { onSubmit } = renderGate({ ...SPARSE, availability: 'part_time' });
        expect((field(m('years_experience')) as HTMLInputElement).value).toBe('');
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing' } });
        submit();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(lastValues(onSubmit)).not.toHaveProperty('years_experience');
    });

    it('keeps a stored availability and years as they were, with no empty choice', () => {
        const { onSubmit } = renderGate({ ...SPARSE, availability: 'part_time', years_experience: 3 });
        const availability = field(m('availability_label')) as HTMLSelectElement;
        expect(availability.value).toBe('part_time');
        expect([...availability.options].some((option) => option.value === '')).toBe(false);
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing' } });
        submit();

        expect(lastValues(onSubmit)).toMatchObject({ availability: 'part_time', years_experience: 3 });
    });

    it('still saves a typed 0 years as 0, and holds a typed number to 0 to 80', async () => {
        const { onSubmit } = renderGate({ ...SPARSE, availability: 'flexible' });
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing' } });
        fireEvent.change(field(m('years_experience')), { target: { value: '0' } });
        submit();
        expect(lastValues(onSubmit)).toMatchObject({ years_experience: 0 });

        // The button reads "Loading" until the save settles.
        await screen.findByRole('button', { name: m('submit') });
        fireEvent.change(field(m('years_experience')), { target: { value: '95' } });
        submit();
        expect(lastValues(onSubmit)).toMatchObject({ years_experience: 80 });
    });

    it('does not clear a stored number of years: it asks for a number (0 if none)', () => {
        const { onSubmit } = renderGate({ ...SPARSE, availability: 'flexible', years_experience: 6 });
        fireEvent.change(field(m('skills_placeholder')), { target: { value: 'finishing' } });
        fireEvent.change(field(m('years_experience')), { target: { value: '' } });
        submit();

        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getAllByText('Enter your years of experience (0 if none).').length).toBeGreaterThan(0);
        expect(field(m('years_experience'))).toHaveAttribute('aria-invalid', 'true');
    });

    it('offers the empty choice in Spanish, in tú', () => {
        renderGate(SPARSE, 'es');
        const availability = field(m('availability_label', 'es')) as HTMLSelectElement;
        expect(availability.selectedOptions[0]).toHaveTextContent('Elige tu disponibilidad');
    });
});
