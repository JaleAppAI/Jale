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

const routerPush = vi.fn();
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
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
const updateJobPublicListing = vi.fn();
const shareEmployerJob = vi.fn();

// Partial mock: `ApiError` and `EMPLOYER_PRO_PLAN_CODE` must stay real -- both
// this modal and `lib/plan-limit` import them from here.
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
  getBilling: (...args: unknown[]) => getBilling(...args),
  createJob: (...args: unknown[]) => createJob(...args),
  saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
  updateJobPublicListing: (...args: unknown[]) => updateJobPublicListing(...args),
  shareEmployerJob: (...args: unknown[]) => shareEmployerJob(...args),
}));

import { message, renderIntl } from './render-intl';
import { PostJobModal } from '../PostJobModal';
import { ApiError } from '@/lib/api/employer';
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

/*
 * Analytics #18 (K3.6): a job started from a saved template says so, even
 * after the employer edited the prefilled fields -- "started from a template"
 * is what reuse means.
 */
describe('PostJobModal template id', () => {
  const titleField = () => screen.getByPlaceholderText(message('employer_dashboard.modal.job_title_placeholder'));
  const next = () => screen.getByRole('button', { name: message('employer_dashboard.modal.next') });
  const submit = () => screen.getByRole('button', { name: message('employer_dashboard.post_job_docs.submit') });

  async function walkToSubmit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(next());
    await waitFor(() => expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.details')));
    await user.click(next());
    await waitFor(() => expect(submit()).toBeInTheDocument());
    await user.click(submit());
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
  }

  beforeEach(() => {
    createJob.mockResolvedValue({ id: 'job-new', title: 'Roofer lead' });
    saveJobTemplate.mockResolvedValue({ id: 'tpl-saved', name: 'Mine', payload: {}, updated_at: '2026-10-14T00:00:00Z' });
  });

  it('sends template_id after a template was applied and then edited (T-e)', async () => {
    const user = userEvent.setup();
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    await user.type(titleField(), ' lead');

    await walkToSubmit(user);

    expect(createJob.mock.calls[0][1]).toMatchObject({ title: 'Roofer lead', template_id: 'tpl-city' });
  });

  it('sends the LAST template applied when the employer switches templates', async () => {
    const user = userEvent.setup();
    const second: JobTemplate = { ...withCity, id: 'tpl-city-2', name: 'Roofer (second)' };
    await openWithTemplates([withCity, second]);
    applyTemplate(withCity.id);
    applyTemplate(second.id);

    await walkToSubmit(user);

    expect(createJob.mock.calls[0][1]).toMatchObject({ template_id: 'tpl-city-2' });
  });

  it('posts a job from a template stored with a null shift list without the key (K2)', async () => {
    const user = userEvent.setup();
    const nullShifts = {
      ...withCity,
      id: 'tpl-null-shifts',
      payload: { ...withCity.payload, shift_periods: null },
    } as unknown as JobTemplate;
    await openWithTemplates([nullShifts]);
    applyTemplate(nullShifts.id);

    await walkToSubmit(user);

    expect('shift_periods' in createJob.mock.calls[0][1]).toBe(false);
  });

  it('never puts template_id into a template it saves', async () => {
    const user = userEvent.setup();
    // Not `openWithTemplates`: its billing fixture caps templates at 1, and with
    // one template loaded the cap pre-check would stop the submit before any save.
    listJobTemplates.mockResolvedValue([withCity]);
    getBilling.mockResolvedValue({
      planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 5, activeJobUsage: 0, subscription: null,
      display_price_minor: 2000, currency: 'usd', billing_interval: 'month',
    });
    renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(withCity.name)).toBeInTheDocument());
    applyTemplate(withCity.id);
    await user.click(next());
    await user.click(next());
    await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
    await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
    await user.click(submit());

    await waitFor(() => expect(saveJobTemplate).toHaveBeenCalledTimes(1));
    expect(saveJobTemplate.mock.calls[0][1].payload).not.toHaveProperty('template_id');
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
    expect(createJob.mock.calls[0][1]).toHaveProperty('template_id', 'tpl-city');
  });
});

/*
 * A failed Next or Post names the field, moves to it and marks it (sprint 29).
 * The demo employer saw one "Complete the required fields." under the footer
 * and had to hunt for which one. New copy, so asserted as literals.
 */
describe('PostJobModal: a refused step points at its field', () => {
  const nextButton = () => screen.getByRole('button', { name: message('employer_dashboard.modal.next') });
  const titleField = () => screen.getByPlaceholderText(message('employer_dashboard.modal.job_title_placeholder'));
  const tradeSelect = () =>
    (screen.getByRole('option', { name: message('employer_dashboard.modal.select_placeholder') }) as HTMLOptionElement)
      .closest('select') as HTMLSelectElement;
  const workersField = () => document.querySelector('input[type="number"][min="1"]') as HTMLInputElement;
  const timeFields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="time"]'));

  async function openEmpty() {
    listJobTemplates.mockResolvedValue([]);
    getBilling.mockResolvedValue(null);
    renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
  }

  it('marks, describes and focuses a missing title, and the banner names it', async () => {
    await openEmpty();
    fireEvent.click(nextButton());

    await waitFor(() => expect(titleField()).toHaveFocus());
    expect(titleField()).toHaveAttribute('aria-invalid', 'true');
    expect(titleField()).toHaveAccessibleDescription('Add a job title');
    expect(screen.getByRole('alert')).toHaveTextContent('Add a job title');
  });

  it('points at the trade when only the trade is missing', async () => {
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    fireEvent.change(tradeSelect(), { target: { value: '' } });
    fireEvent.click(nextButton());

    await waitFor(() => expect(tradeSelect()).toHaveFocus());
    expect(tradeSelect()).toHaveAttribute('aria-invalid', 'true');
    expect(tradeSelect()).toHaveAccessibleDescription('Pick a trade');
    expect(titleField()).not.toHaveAttribute('aria-invalid');
  });

  it('points at the missing end time of a half-filled shift', async () => {
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    fireEvent.click(nextButton());
    await waitFor(() => expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.details')));

    fireEvent.change(timeFields()[0], { target: { value: '07:00' } });
    fireEvent.click(nextButton());

    const end = timeFields()[1];
    await waitFor(() => expect(end).toHaveFocus());
    expect(end).toHaveAttribute('aria-invalid', 'true');
    expect(end).toHaveAccessibleDescription(expect.stringContaining('Add the end time too, or clear the start time'));
    expect(screen.getByRole('alert')).toHaveTextContent('Add the end time too, or clear the start time');
  });

  it('lands on step 2 with the headcount focused when a jump past it is refused', async () => {
    const zeroWorkers: JobTemplate = { ...withCity, id: 'tpl-zero', payload: { ...withCity.payload, number_of_workers_needed: 0 } };
    await openWithTemplates([zeroWorkers]);
    applyTemplate(zeroWorkers.id);
    fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.modal.steps.documents') }));

    await waitFor(() => expect(workersField()).toHaveFocus());
    expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.details'));
    expect(workersField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter how many workers you need, 1 or more');
  });

  it('points at the blank question when Post is refused', async () => {
    await openWithTemplates([withCity]);
    applyTemplate(withCity.id);
    fireEvent.click(nextButton());
    await waitFor(() => expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.details')));
    fireEvent.click(nextButton());
    await waitFor(() => expect(stepHeading()).toHaveTextContent(message('employer_dashboard.modal.steps.documents')));

    fireEvent.click(screen.getByRole('button', { name: new RegExp(message('job_requirements.prompts.add')) }));
    fireEvent.click(screen.getByRole('button', { name: message('employer_dashboard.post_job_docs.submit') }));

    const question = document.querySelector('textarea[aria-labelledby^="prompt-label-"]') as HTMLTextAreaElement;
    await waitFor(() => expect(question).toHaveFocus());
    expect(question).toHaveAttribute('aria-invalid', 'true');
    expect(question).toHaveAccessibleDescription(message('job_requirements.prompts.validation_blank'));
    expect(createJob).not.toHaveBeenCalled();
  });

  it('clears the mark once the field is edited', async () => {
    await openEmpty();
    fireEvent.click(nextButton());
    await waitFor(() => expect(titleField()).toHaveAttribute('aria-invalid', 'true'));

    fireEvent.change(titleField(), { target: { value: 'Roofer' } });
    expect(titleField()).not.toHaveAttribute('aria-invalid');
  });
});

/*
 * After a successful post the wizard shows a "Job posted" screen inside the
 * SAME dialog (sprint 29): the confirmation, a one-tap share link, what happens
 * next, and a way back to the dashboard. New copy, so asserted through the
 * catalogue.
 */
describe('PostJobModal: the job posted screen', () => {
  const next = () => screen.getByRole('button', { name: message('employer_dashboard.modal.next') });
  const submit = () => screen.getByRole('button', { name: message('employer_dashboard.post_job_docs.submit') });
  const turnOn = () => screen.getByRole('button', { name: message('employer_dashboard.job_posted.turn_on') });
  const postedHeading = () =>
    screen.getByRole('heading', { name: message('employer_dashboard.job_posted.title') });

  const postedJob = {
    id: 'job-new-0001',
    title: 'Roofer',
    location: 'El Paso, TX',
    status: 'active',
    shift_periods: ['night', 'day'],
    public_listing_enabled: false,
  };

  async function postJob(
    user: ReturnType<typeof userEvent.setup>,
    props: {
      onClose?: () => void;
      onJobCreated?: () => void;
      beforeSubmit?: () => Promise<void>;
    } = {},
  ) {
    listJobTemplates.mockResolvedValue([withCity]);
    getBilling.mockResolvedValue({
      planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 5, activeJobUsage: 0, subscription: null,
      display_price_minor: 2000, currency: 'usd', billing_interval: 'month',
    });
    renderIntl(
      <PostJobModal open onClose={props.onClose ?? vi.fn()} onJobCreated={props.onJobCreated ?? vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText(withCity.name)).toBeInTheDocument());
    applyTemplate(withCity.id);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(next());
    await user.click(next());
    await waitFor(() => expect(submit()).toBeInTheDocument());
    await props.beforeSubmit?.();
    await user.click(submit());
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(1));
  }

  beforeEach(() => {
    createJob.mockResolvedValue(postedJob);
    updateJobPublicListing.mockResolvedValue({
      id: postedJob.id, public_code: 'AB12CD', public_listing_enabled: true,
    });
    shareEmployerJob.mockResolvedValue({ share_url: 'https://example.test/j/AB12CD?ref=test' });
  });

  it('shows the posted screen in the same dialog instead of closing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onJobCreated = vi.fn();
    await postJob(user, { onClose, onJobCreated });

    await waitFor(() => expect(postedHeading()).toBeInTheDocument());
    expect(onJobCreated).toHaveBeenCalledWith(postedJob, undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    // Title, place and shifts in one line; shifts in canonical order.
    expect(screen.getByText('Roofer · El Paso, TX · Day, Night')).toBeInTheDocument();
    expect(screen.getByText(message('employer_dashboard.job_posted.n1'))).toBeInTheDocument();
    // The wizard's own controls are gone.
    expect(screen.queryByRole('button', { name: message('employer_dashboard.post_job_docs.submit') })).not.toBeInTheDocument();
    expect(postedHeading()).toHaveFocus();
  });

  it('turns the share link on, then shows the link, Copy and the QR download', async () => {
    const user = userEvent.setup();
    await postJob(user);
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    await user.click(turnOn());

    await waitFor(() => expect(shareEmployerJob).toHaveBeenCalledTimes(1));
    expect(updateJobPublicListing).toHaveBeenCalledWith('test-token', postedJob.id, true);
    expect(shareEmployerJob).toHaveBeenCalledWith('test-token', postedJob.id);
    expect(updateJobPublicListing.mock.invocationCallOrder[0])
      .toBeLessThan(shareEmployerJob.mock.invocationCallOrder[0]);
    expect(await screen.findByDisplayValue('https://example.test/j/AB12CD?ref=test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: message('employer_job_listing.copy_link') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: message('employer_job_listing.download_qr') })).toBeInTheDocument();
    expect(screen.getByText(message('employer_dashboard.job_posted.crew'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message('employer_dashboard.job_posted.turn_on') })).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('keeps the job private and says so inline when turning the link on fails', async () => {
    const user = userEvent.setup();
    updateJobPublicListing.mockRejectedValue(new ApiError(418, 'something_unexpected'));
    await postJob(user);
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    await user.click(turnOn());

    expect(await screen.findByText(message('employer_job_listing.toggle_error'))).toBeInTheDocument();
    expect(shareEmployerJob).not.toHaveBeenCalled();
    expect(turnOn()).toBeEnabled();
  });

  it('offers to fetch the link again, without a second switch, when only the link failed', async () => {
    const user = userEvent.setup();
    shareEmployerJob.mockRejectedValueOnce(new ApiError(418, 'something_unexpected'));
    await postJob(user);
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    await user.click(turnOn());

    expect(await screen.findByText(message('employer_job_listing.error_generic'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: message('employer_job_listing.get_link') }));

    expect(await screen.findByDisplayValue('https://example.test/j/AB12CD?ref=test')).toBeInTheDocument();
    expect(updateJobPublicListing).toHaveBeenCalledTimes(1);
    expect(shareEmployerJob).toHaveBeenCalledTimes(2);
  });

  it('closes and goes to the dashboard from Back to dashboard', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await postJob(user, { onClose });
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: message('employer_dashboard.job_posted.back') }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/employer/dashboard');
  });

  it('closes in place on Escape, without navigating', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await postJob(user, { onClose });
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('carries the template-not-saved note onto the posted screen', async () => {
    const user = userEvent.setup();
    saveJobTemplate.mockRejectedValue(
      new ApiError(403, 'template_limit_reached', { template_limit: 5 }),
    );
    await postJob(user, {
      beforeSubmit: async () => {
        await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
        await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
      },
    });
    await waitFor(() => expect(postedHeading()).toBeInTheDocument());

    expect(screen.getByText(message('employer_dashboard.jobs.template_not_saved_after_post').replace('{limit}', '5'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: message('employer_dashboard.templates.manage_link') }))
      .toHaveAttribute('href', '/employer/templates');
  });
});
