// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * The third door into the same city-identity gap.
 *
 * `JobFormFields` draws a warning ring and a "pick a city" helper whenever its
 * caller says the location is not backed by a real city, and PostJobModal's
 * step 1 and TemplateEditModal both feed it. The EDIT modal never did: a job
 * whose row has no `city_key` opened with the location text prefilled and the
 * picker looking settled, and the save was then refused with a sentence under
 * the footer that pointed at no field at all.
 *
 * Same prop, same ring, same helper key -- this suite is what stops the edit
 * form drifting away from the other two again.
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

const updateJob = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    updateJob: (...args: unknown[]) => updateJob(...args),
}));

import { message, renderIntl } from './render-intl';
import { EditJobModal } from '../EditJobModal';
import type { EmployerJobDetail } from '@/lib/api/employer';

const withCity = {
    id: 'job-1',
    title: 'Roofer',
    location: 'El Paso, TX',
    city_key: 'el-paso-tx',
    city: 'El Paso',
    state: 'TX',
    state_region: 'TX',
    pay: null,
    pay_min: 25,
    pay_max: 30,
    pay_interval: 'hourly',
    job_type: 'full-time',
    status: 'active',
    applicant_count: 0,
    hired_count: 0,
    open_count: 1,
    start_date: null,
    expected_duration: null,
    shift_schedule: null,
    transportation_required: false,
    work_authorization_required: false,
    language_preference: ['any'],
    number_of_workers_needed: 1,
    trade_category: 'concrete',
    required_experience_years: null,
    required_experience_months: null,
    certifications: [],
    created_at: '2026-09-01T00:00:00Z',
} as unknown as EmployerJobDetail;

const withoutCity = {
    ...withCity,
    id: 'job-2',
    location: 'Somewhere Unlisted',
    city_key: null,
    city: null,
    state: null,
    state_region: '',
} as unknown as EmployerJobDetail;

const helperText = () => message('employer_dashboard.modal.location_pick_helper');
/*
 * Structural queries, for the reason TemplateEditModal's suite spells out:
 * `JobFormFields`' `Field` renders a bare `<label>` with no `htmlFor`, and
 * `aria-autocomplete="list"` is unique to `LocationPicker`'s input.
 */
const locationField = () => document.querySelector('input[aria-autocomplete="list"]') as HTMLInputElement;

beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = function scrollIntoView() {};
    }
});

describe('EditJobModal city gap', () => {
    it('rings the location and explains it when the job has no city', () => {
        renderIntl(
            <EditJobModal open job={withoutCity} onClose={vi.fn()} onJobUpdated={vi.fn()} />,
        );

        expect(screen.getByText(helperText())).toBeInTheDocument();
        expect(locationField()).toHaveAttribute('aria-invalid', 'true');
    });

    it('says nothing when the job kept its city', () => {
        renderIntl(
            <EditJobModal open job={withCity} onClose={vi.fn()} onJobUpdated={vi.fn()} />,
        );

        expect(screen.queryByText(helperText())).not.toBeInTheDocument();
        expect(locationField()).not.toHaveAttribute('aria-invalid');
    });

    it('rings the location when a save is refused for a missing city', async () => {
        // Starts from a job that HAS a city, so the ring is off; the employer
        // then retypes the location as free text, which clears `city_key`
        // under it. The refused save is the second route into the same state.
        renderIntl(<EditJobModal open job={withCity} onClose={vi.fn()} onJobUpdated={vi.fn()} />);
        expect(screen.queryByText(helperText())).not.toBeInTheDocument();

        fireEvent.change(locationField(), { target: { value: 'Somewhere Unlisted' } });
        fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.modal.edit_save') }));

        await waitFor(() => expect(screen.getByText(helperText())).toBeInTheDocument());
        expect(screen.getByText(message('employer_dashboard.modal.location_pick_required'))).toBeInTheDocument();
        expect(updateJob).not.toHaveBeenCalled();
    });
});
