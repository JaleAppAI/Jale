// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * Two owner reports from the 2026-09-03 release live in this suite:
 *
 *  - Applying a template whose stored payload lost its city triple left the
 *    picker LOOKING filled (the location text prefills) with `city_key: null`
 *    underneath, and nothing on screen said so -- `cityPrefilled` is false in
 *    exactly that case, so the "check the city" nudge did not fire either. The
 *    employer only found out at the end of step 1.
 *  - The wizard had no `<form>`, so Enter did nothing at all: every step had to
 *    be advanced with the mouse.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({
    handleLegalWall: (err: unknown) => {
      throw err;
    },
  }),
}));

// The real dataset is a 3MB JSON chunk the picker code-splits and lazily
// imports; the suite never needs a suggestion, only for the debounce not to
// pull it in. `slugCityKey`/`locationDatasetFailed` stay REAL -- `lib/job-form`
// derives the city triple with them.
vi.mock('@/lib/location-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/location-search')>()),
  queryLocations: vi.fn().mockResolvedValue([]),
}));

// Step 2 mounts PayReferenceHint, which fetches on mount.
vi.mock('@/lib/api/payReference', () => ({
  getPayReference: vi.fn().mockResolvedValue(null),
}));

const listJobTemplates = vi.fn();
const getBilling = vi.fn();
const createJob = vi.fn();
const saveJobTemplate = vi.fn();

// Partial mock: `ApiError` and `EMPLOYER_PRO_PLAN_CODE` must stay real -- both
// this modal and `lib/plan-limit` import them from here.
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
  getBilling: (...args: unknown[]) => getBilling(...args),
  createJob: (...args: unknown[]) => createJob(...args),
  saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
}));

import { message, renderIntl } from './render-intl';
import { PostJobModal } from '../PostJobModal';
import type { JobTemplate } from '@/lib/api/employer';

/** A template that kept its city identity: applying it leaves step 1 valid. */
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

/**
 * The same template with the triple missing -- the shape a legacy template (or
 * one saved while the location dataset was unreachable) actually has on disk.
 */
const withoutCity: JobTemplate = {
  id: 'tpl-nocity',
  name: 'Roofer (no city)',
  updated_at: '2026-09-01T00:00:00Z',
  payload: {
    title: 'Roofer',
    location: 'Somewhere Unlisted',
    job_type: 'full-time',
    trade_category: 'concrete',
  },
};

const helperText = () => message('employer_dashboard.modal.location_pick_helper');
const locationField = () =>
  screen.getByPlaceholderText(message('employer_dashboard.modal.location_placeholder'));
const stepHeading = () => screen.getByRole('heading', { level: 3 });

async function openWithTemplates(templates: JobTemplate[]) {
  listJobTemplates.mockResolvedValue(templates);
  getBilling.mockResolvedValue({
    planCode: 'employer_free',
    activeJobLimit: 1,
    templateLimit: 1,
    activeJobUsage: 0,
    subscription: null,
    display_price_minor: 2000,
    currency: 'usd',
    billing_interval: 'month',
  });
  renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
  // The template picker only renders once the background load lands.
  await waitFor(() => expect(screen.getByText(templates[0].name)).toBeInTheDocument());
}

/** Pick a template out of the step-1 select. */
function applyTemplate(id: string) {
  const placeholder = screen.getByRole('option', {
    name: message('employer_dashboard.modal.template_select_placeholder'),
  }) as HTMLOptionElement;
  const select = placeholder.closest('select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: id } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements no layout, so it ships no `scrollIntoView`. The modal
  // scrolls its feedback banner into view whenever a failure is set, which is
  // exactly what the validation tests below provoke. Stubbed here rather than
  // in the shared `src/test/setup.ts` -- that file is edited by every lane.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
});

describe('PostJobModal template city gap', () => {
  it('marks the location invalid and explains it when the applied template has no city', async () => {
    await openWithTemplates([withoutCity]);
    expect(screen.queryByText(helperText())).not.toBeInTheDocument();

    applyTemplate(withoutCity.id);

    expect(screen.getByText(helperText())).toBeInTheDocument();
    expect(locationField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the check-the-city nudge, not the invalid helper, when the template kept its city', async () => {
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);

    expect(screen.getByText(message('employer_dashboard.modal.template_check_city'))).toBeInTheDocument();
    expect(screen.queryByText(helperText())).not.toBeInTheDocument();
    expect(locationField()).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the helper for free-typed text and drops it when a city arrives', async () => {
    await openWithTemplates([withoutCity, withCity]);
    applyTemplate(withoutCity.id);
    expect(screen.getByText(helperText())).toBeInTheDocument();

    // Typing is not picking: `LocationPicker`'s onChange sends a null cityKey
    // for free text, so the helper has to survive it.
    fireEvent.change(locationField(), { target: { value: 'El Pas' } });
    expect(screen.getByText(helperText())).toBeInTheDocument();

    // A suggestion cannot be clicked here (`queryLocations` is stubbed empty),
    // so the second template -- which carries a real triple -- stands in for
    // the state change a pick makes.
    applyTemplate(withCity.id);
    expect(screen.queryByText(helperText())).not.toBeInTheDocument();
  });
});

describe('PostJobModal Enter key', () => {
  it('advances to the next step when Enter is pressed in a step-1 field', async () => {
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.basics'));

    const user = userEvent.setup();
    const title = screen.getByPlaceholderText(message('employer_dashboard.modal.job_title_placeholder'));
    await user.click(title);
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.details')));
  });

  it('stays on step 1 and points at the location when Enter is pressed with no city picked', async () => {
    await openWithTemplates([withoutCity]);
    applyTemplate(withoutCity.id);

    const user = userEvent.setup();
    const title = screen.getByPlaceholderText(message('employer_dashboard.modal.job_title_placeholder'));
    await user.click(title);
    await user.keyboard('{Enter}');

    expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.basics'));
    expect(screen.getByText(message('employer_dashboard.modal.location_pick_required'))).toBeInTheDocument();
    expect(screen.getByText(helperText())).toBeInTheDocument();
  });

  it('leaves no VISIBLE submit button inside the step form', async () => {
    // The trap the `<form>` introduces: a native button with no `type`
    // submits. "Generate with AI", "Add a question", every requirement radio
    // and every day chip lives inside this form, and any one of them
    // defaulting to submit would publish the job on click.
    //
    // The one legitimate descendant submitter is the hidden default button
    // that makes Enter work; the visible primary control lives in the Modal
    // FOOTER and is associated by `form=`. Anything else that submits is a bug.
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    const buttons = Array.from(document.querySelectorAll('form button')) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    const visibleSubmitters = buttons.filter((btn) => btn.type === 'submit' && !btn.hidden);
    expect(visibleSubmitters).toHaveLength(0);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('keeps the hidden default button out of the tab order and the a11y tree', async () => {
    await openWithTemplates([withCity]);
    const hidden = document.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(hidden).toBeTruthy();
    expect(hidden.hidden).toBe(true);
    expect(hidden.tabIndex).toBe(-1);
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
  });
});
