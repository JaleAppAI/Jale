// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import type { WorkerProfileData, WorkerProfilePatch } from '@/lib/api/worker';
import { TRADE_KEYS } from '@/lib/worker-vocab';
import { message, renderIntl, type TestLocale } from '@/components/worker/onboarding/__tests__/render-intl';

/*
 * The worker's profile edit form.
 *
 * Two things here. The trade: the same six choices as onboarding, with Other
 * opening a box that takes 2 to 60 characters, trimmed, saved as
 * `main_trade` / `main_trade_other`. And nothing the worker did not choose is
 * saved for them: an unset availability must be picked, and an empty years
 * box sends no number at all (the server keeps what it has).
 */

import { ProfileEditForm } from '../ProfileEditForm';

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

const e = (key: string, locale: TestLocale = 'en') => message(`worker_profile.edit.${key}`, locale);

function renderForm(initial: WorkerProfileData, locale: TestLocale = 'en') {
    const onSave = vi.fn<(patch: WorkerProfilePatch) => Promise<void>>(async () => {});
    const view = renderIntl(<ProfileEditForm initial={initial} onCancel={vi.fn()} onSave={onSave} />, locale);
    return { ...view, onSave };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLSelectElement;
const save = (locale: TestLocale = 'en') => fireEvent.click(screen.getByRole('button', { name: e('save', locale) }));
const lastPatch = (onSave: ReturnType<typeof renderForm>['onSave']) => onSave.mock.calls.at(-1)?.[0] as WorkerProfilePatch;
const tradeSelect = () => field(e('trade_label')) as HTMLSelectElement;
const otherBox = () => screen.queryByLabelText(e('trade_other_label')) as HTMLInputElement | null;
const lengthMessage = () => message('worker_profile.edit.trade_other_length').replace('{min}', '2').replace('{max}', '60');

describe('ProfileEditForm — nothing is saved that the worker did not choose', () => {
    it('does not save an unset availability as Full-time: it asks for one instead', () => {
        const { onSave } = renderForm({ ...BASE, availability: null, years_experience: null });
        fireEvent.change(field(e('full_name')), { target: { value: 'Renamed Worker' } });
        save();

        expect(onSave).not.toHaveBeenCalled();
        const availability = field(e('availability_label')).closest('div.flex-col') as HTMLElement;
        expect(within(availability).getByText(message('worker_profile.errors.required'))).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(`Please add: ${e('availability_label')}`);
    });

    it('shows an unset availability as an empty choice, not as Full-time', () => {
        renderForm({ ...BASE, availability: null });
        const select = field(e('availability_label')) as HTMLSelectElement;
        expect(select.value).toBe('');
        expect(select.selectedOptions[0]).toHaveTextContent(e('availability_choose'));
    });

    it('saves the availability the worker then picks', async () => {
        const { onSave } = renderForm({ ...BASE, availability: null, years_experience: null });
        fireEvent.change(field(e('availability_label')), { target: { value: 'weekends' } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave).availability).toBe('weekends');
    });

    it('sends no years of experience when the box is empty, rather than 0', async () => {
        const { onSave } = renderForm({ ...BASE, years_experience: null });
        expect((field(e('years_experience')) as HTMLInputElement).value).toBe('');
        fireEvent.change(field(e('full_name')), { target: { value: 'Renamed Worker' } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const patch = lastPatch(onSave);
        expect(patch).not.toHaveProperty('years_experience');
        expect(patch.availability).toBe('part_time');
        expect(patch.full_name).toBe('Renamed Worker');
    });

    it('still saves a typed 0 years as 0', async () => {
        const { onSave } = renderForm({ ...BASE, years_experience: null });
        fireEvent.change(field(e('years_experience')), { target: { value: '0' } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave).years_experience).toBe(0);
    });

    it('keeps a stored number of years as it was', async () => {
        const { onSave } = renderForm(BASE);
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave).years_experience).toBe(4);
    });
});

describe('ProfileEditForm — Edit trade', () => {
    it('offers the same six trades as onboarding, in the same order', () => {
        renderForm(BASE);
        const offered = Array.from(tradeSelect().options)
            .filter((option) => option.value !== '')
            .map((option) => [option.value, option.textContent]);
        expect(offered).toEqual(TRADE_KEYS.map((key) => [key, message(`worker_vocab.trade.${key}`)]));
    });

    it('starts on the stored trade', () => {
        renderForm(BASE);
        expect(tradeSelect().value).toBe('carpenter');
        expect(otherBox()).toBeNull();
    });

    it('starts on Other with the stored text in the box', () => {
        renderForm({ ...BASE, main_trade: 'other', main_trade_other: 'Welder' });
        expect(tradeSelect().value).toBe('other');
        expect(otherBox()?.value).toBe('Welder');
    });

    it('offers an empty choice only while no trade is stored', () => {
        renderForm({ ...BASE, main_trade: null });
        expect(tradeSelect().value).toBe('');
        expect(tradeSelect().selectedOptions[0]).toHaveTextContent(e('trade_choose'));
    });

    it('offers no empty choice once a trade is stored', () => {
        renderForm(BASE);
        expect(Array.from(tradeSelect().options).map((option) => option.value)).not.toContain('');
    });

    it.each(['electrician', 'plumber', 'carpenter', 'concrete', 'painting'] as const)(
        'saves the standard trade %s with no other text',
        async (trade) => {
            const { onSave } = renderForm({ ...BASE, main_trade: 'other', main_trade_other: 'Welder' });
            fireEvent.change(tradeSelect(), { target: { value: trade } });
            save();

            await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
            expect(lastPatch(onSave)).toMatchObject({ main_trade: trade, main_trade_other: null });
        },
    );

    it('shows the Your trade box when Other is picked, and hides it again for a standard trade', () => {
        renderForm(BASE);
        expect(otherBox()).toBeNull();
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        expect(otherBox()).not.toBeNull();
        expect(otherBox()?.placeholder).toBe(e('trade_other_placeholder'));
        fireEvent.change(tradeSelect(), { target: { value: 'plumber' } });
        expect(otherBox()).toBeNull();
    });

    it('blocks Save on 1 character, with the length message', () => {
        const { onSave } = renderForm(BASE);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        fireEvent.change(otherBox() as HTMLInputElement, { target: { value: ' W ' } });
        // Said while typing, before any Save.
        expect(screen.getByText(lengthMessage())).toBeInTheDocument();
        save();

        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(lengthMessage())).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(`Please add: ${e('trade_other_label')}`);
        expect(otherBox()).toHaveAttribute('aria-invalid', 'true');
    });

    it('blocks Save on 61 characters, with the length message', () => {
        const { onSave } = renderForm(BASE);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        fireEvent.change(otherBox() as HTMLInputElement, { target: { value: 'x'.repeat(61) } });
        save();

        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(lengthMessage())).toBeInTheDocument();
    });

    it('blocks Save on an empty Your trade box', () => {
        const { onSave } = renderForm(BASE);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        expect(screen.queryByText(lengthMessage())).toBeNull();
        save();

        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText(lengthMessage())).toBeInTheDocument();
    });

    it('saves 2 characters, trimmed', async () => {
        const { onSave } = renderForm(BASE);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        fireEvent.change(otherBox() as HTMLInputElement, { target: { value: '  HV  ' } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave)).toMatchObject({ main_trade: 'other', main_trade_other: 'HV' });
    });

    it('saves 60 characters', async () => {
        const { onSave } = renderForm(BASE);
        const sixty = 'y'.repeat(60);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        fireEvent.change(otherBox() as HTMLInputElement, { target: { value: sixty } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave)).toMatchObject({ main_trade: 'other', main_trade_other: sixty });
    });

    it('sends no other text after switching back from Other', async () => {
        const { onSave } = renderForm(BASE);
        fireEvent.change(tradeSelect(), { target: { value: 'other' } });
        fireEvent.change(otherBox() as HTMLInputElement, { target: { value: 'Welder' } });
        fireEvent.change(tradeSelect(), { target: { value: 'painting' } });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(lastPatch(onSave)).toMatchObject({ main_trade: 'painting', main_trade_other: null });
    });

    it('sends no trade at all when none is chosen and none is stored', async () => {
        const { onSave } = renderForm({ ...BASE, main_trade: null, main_trade_other: null });
        save();

        await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const patch = lastPatch(onSave);
        expect(patch).not.toHaveProperty('main_trade');
        expect(patch).not.toHaveProperty('main_trade_other');
    });

    it('labels the control in Spanish, in tú', () => {
        renderForm(BASE, 'es');
        const select = screen.getByLabelText(e('trade_label', 'es')) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'other' } });
        const box = screen.getByLabelText(e('trade_other_label', 'es')) as HTMLInputElement;
        expect(box.placeholder).toBe('Escribe tu oficio, p. ej. soldador, drywall, techador');
        expect(Array.from(select.options).find((option) => option.value === 'other')?.textContent).toBe('Otro');
    });
});
