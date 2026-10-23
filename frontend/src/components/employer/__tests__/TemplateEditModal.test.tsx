// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The template editor is the other half of the city-identity gap: a template
 * whose stored payload lost its `city_key` opens here with the location text
 * prefilled and nothing saying the city is gone, and the save is then refused
 * by `validateFullJobForm` with a sentence under the footer that points at no
 * field. Same ring, same helper, same reason as PostJobModal's step 1.
 *
 * It also had no `<form>`, so Enter in the name field did nothing.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/lib/location-search', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/location-search')>()),
    queryLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/api/payReference', () => ({
    getPayReference: vi.fn().mockResolvedValue(null),
}));

const saveJobTemplate = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
}));

import { message, renderIntl } from './render-intl';
import { TemplateEditModal } from '../TemplateEditModal';
import type { JobTemplate } from '@/lib/api/employer';

const withCity: JobTemplate = {
    id: 'tpl-city',
    name: 'Roofer (El Paso)',
    updated_at: '2026-09-01T00:00:00Z',
    payload: {
        title: 'Roofer',
        location: 'El Paso, TX',
        job_type: 'full-time',
        trade_category: 'concrete',
        city_key: 'el-paso-tx',
        city: 'El Paso',
        state: 'TX',
    },
};

const withoutCity: JobTemplate = {
    ...withCity,
    id: 'tpl-nocity',
    name: 'Roofer (no city)',
    payload: {
        title: 'Roofer',
        location: 'Somewhere Unlisted',
        job_type: 'full-time',
        trade_category: 'concrete',
    },
};

const helperText = () => message('employer_dashboard.modal.location_pick_helper');
/*
 * Structural queries, deliberately.
 *
 * `JobFormFields`' own `Field` renders a bare `<label>` with no `htmlFor`, so
 * none of these controls has an accessible name to query by -- and the modal
 * holds three elements with role `combobox` (the location input plus the job
 * type and trade selects) and several textboxes. `aria-autocomplete="list"` is
 * unique to `LocationPicker`'s input, and `maxLength={80}` to the template
 * name. Associating those labels is a broader change than this lane owns.
 */
const locationField = () => document.querySelector('input[aria-autocomplete="list"]') as HTMLInputElement;
const nameField = () => document.querySelector('input[maxlength="80"]') as HTMLInputElement;

beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
});

describe('TemplateEditModal city gap', () => {
    it('rings the location and explains it when the stored template has no city', () => {
        renderIntl(
            <TemplateEditModal open template={withoutCity} onClose={vi.fn()} onSaved={vi.fn()} />,
        );
        expect(screen.getByText(helperText())).toBeInTheDocument();
        expect(locationField()).toHaveAttribute('aria-invalid', 'true');
    });

    it('says nothing when the stored template kept its city', () => {
        renderIntl(
            <TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />,
        );
        expect(screen.queryByText(helperText())).not.toBeInTheDocument();
        expect(locationField()).not.toHaveAttribute('aria-invalid');
    });

    it('rings the location when a save is refused for a missing city', async () => {
        // Starts from a template that HAS a city, so the ring is off; the
        // employer then retypes the location as free text, which clears
        // `city_key` under it. That is the second route into the same state --
        // a refused save rather than a bad seed.
        renderIntl(<TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />);
        expect(screen.queryByText(helperText())).not.toBeInTheDocument();

        fireEvent.change(locationField(), { target: { value: 'Somewhere Unlisted' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.templates.save') }));

        await waitFor(() => expect(screen.getByText(helperText())).toBeInTheDocument());
        expect(screen.getByText(message('employer_dashboard.modal.location_pick_required'))).toBeInTheDocument();
        expect(saveJobTemplate).not.toHaveBeenCalled();
    });
});

describe('TemplateEditModal Enter key', () => {
    it('saves on Enter from the name field', async () => {
        saveJobTemplate.mockResolvedValue({ ...withCity });
        const onSaved = vi.fn();
        renderIntl(
            <TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={onSaved} />,
        );
        const user = userEvent.setup();
        await user.click(nameField());
        await user.keyboard('{Enter}');
        await waitFor(() => expect(saveJobTemplate).toHaveBeenCalledTimes(1));
    });

    it('leaves no visible submit button inside the form', () => {
        renderIntl(
            <TemplateEditModal open template={withCity} onClose={vi.fn()} onSaved={vi.fn()} />,
        );
        const buttons = Array.from(document.querySelectorAll('form button')) as HTMLButtonElement[];
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.filter((btn) => btn.type === 'submit' && !btn.hidden)).toHaveLength(0);
    });
});

/*
 * Date of birth is no longer offered (sprint 29). A template saved before that
 * opens here without it -- no hidden selection -- and saving writes it back
 * without it, so the next job started from the template cannot ask for it.
 */
describe('TemplateEditModal: a template that asked for date of birth', () => {
    it('opens without it and saves without it', async () => {
        saveJobTemplate.mockResolvedValue({ ...withCity });
        const oldTemplate: JobTemplate = {
            ...withCity,
            id: 'tpl-dob',
            payload: { ...withCity.payload, required_fields: ['date_of_birth', 'home_address'], optional_fields: ['date_of_birth'] },
        };
        renderIntl(<TemplateEditModal open template={oldTemplate} onClose={vi.fn()} onSaved={vi.fn()} />);

        expect(screen.queryByRole('radiogroup', { name: message('job_requirements.fields.date_of_birth') }))
            .not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.templates.save') }));

        await waitFor(() => expect(saveJobTemplate).toHaveBeenCalledTimes(1));
        const sent = saveJobTemplate.mock.calls[0][1] as { payload: { required_fields: string[]; optional_fields: string[] } };
        expect(sent.payload.required_fields).toEqual(['home_address']);
        expect(sent.payload.optional_fields).not.toContain('date_of_birth');
    });
});

/*
 * K2 (2026-10-22): an explicit `shift_periods: null` is a 400 on template save.
 * A template stored with no shift choice, or with a null, saves without the key.
 */
describe('TemplateEditModal: a template with no shift choices', () => {
    for (const [name, payload] of [
        ['none stored', { ...withCity.payload }],
        ['a stored null', { ...withCity.payload, shift_periods: null }],
    ] as const) {
        it(`saves without a shift_periods key (${name})`, async () => {
            saveJobTemplate.mockResolvedValue({ ...withCity });
            const template = { ...withCity, id: 'tpl-shifts', payload } as unknown as JobTemplate;
            renderIntl(<TemplateEditModal open template={template} onClose={vi.fn()} onSaved={vi.fn()} />);

            fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.templates.save') }));

            await waitFor(() => expect(saveJobTemplate).toHaveBeenCalledTimes(1));
            const sent = saveJobTemplate.mock.calls[0][1] as { payload: Record<string, unknown> };
            expect('shift_periods' in sent.payload).toBe(false);
        });
    }
});
