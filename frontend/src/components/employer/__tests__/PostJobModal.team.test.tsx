// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { EmployerMembership } from '@/lib/employer-membership-store';

/*
 * Phase 3 (Task 14, fix round 1): the wizard's plan-limit copy speaks to who
 * is posting. A foreman cannot upgrade (only the owner pays) and an owner on
 * Pro has nothing to upgrade to, so neither is offered "Upgrade plan" -- not
 * in the publish 403's notice, the template pre-check, nor the posted screen.
 * Same stubs as PostJobModal.test.tsx, plus a controllable membership.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/employer/dashboard',
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

vi.mock('@/lib/location-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/location-search')>()),
  queryLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/api/payReference', () => ({
  getPayReference: vi.fn().mockResolvedValue(null),
}));

const { state, membershipCalls } = vi.hoisted(() => ({
  state: { membership: { status: 'loading' } as EmployerMembership },
  membershipCalls: { count: 0 },
}));
vi.mock('@/hooks/useEmployerMembership', () => ({
  useEmployerMembership: () => {
    membershipCalls.count += 1;
    return state.membership;
  },
}));

const listJobTemplates = vi.fn();
const getBilling = vi.fn();
const createJob = vi.fn();
const saveJobTemplate = vi.fn();

vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  listJobTemplates: (...args: unknown[]) => listJobTemplates(...args),
  getBilling: (...args: unknown[]) => getBilling(...args),
  createJob: (...args: unknown[]) => createJob(...args),
  saveJobTemplate: (...args: unknown[]) => saveJobTemplate(...args),
  updateJobPublicListing: vi.fn(),
  shareEmployerJob: vi.fn(),
}));

import { message, renderIntl } from './render-intl';
import { PostJobModal } from '../PostJobModal';
import { ApiError } from '@/lib/api/employer';
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

const ready = (role: 'owner' | 'foreman'): EmployerMembership => ({
  status: 'ready', role, companyName: 'Bravo', userId: 'u1', organizationId: 'o1',
});

function plan(planCode: 'employer_free' | 'employer_pro', templateLimit = 5) {
  return {
    planCode, activeJobLimit: 3, templateLimit, activeJobUsage: 0, subscription: null,
    display_price_minor: 2000, currency: 'usd', billing_interval: 'month',
  };
}

const next = () => screen.getByRole('button', { name: message('employer_dashboard.modal.next') });
const submit = () => screen.getByRole('button', { name: message('employer_dashboard.post_job_docs.submit') });
const billingLinks = () => document.querySelectorAll('a[href="/employer/billing"]');
const upgradeLink = () => screen.queryByRole('link', { name: message('billing.limit_dialog.cta_upgrade') });

function selectTemplate(id: string) {
  const placeholder = screen.getByRole('option', {
    name: message('employer_dashboard.modal.template_select_placeholder'),
  }) as HTMLOptionElement;
  const select = placeholder.closest('select') as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function toStepThree(user: ReturnType<typeof userEvent.setup>, billing: ReturnType<typeof plan>, templates = [withCity]) {
  listJobTemplates.mockResolvedValue(templates);
  getBilling.mockResolvedValue(billing);
  renderIntl(<PostJobModal open onClose={vi.fn()} onJobCreated={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(withCity.name)).toBeInTheDocument());
  await waitFor(() => expect(getBilling).toHaveBeenCalled());
  selectTemplate(withCity.id);
  await user.click(next());
  await user.click(next());
  await waitFor(() => expect(submit()).toBeInTheDocument());
}

const jobLimit403 = (planCode: string) =>
  new ApiError(403, 'job_limit_reached', { active_job_limit: 3, active_jobs: 3, plan_code: planCode });

beforeEach(() => {
  vi.clearAllMocks();
  membershipCalls.count = 0;
  vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
  state.membership = ready('owner');
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PostJobModal: plan-limit copy by who is posting', () => {
  it('a foreman\'s publish 403 shows the ask-your-owner copy and no Upgrade', async () => {
    const user = userEvent.setup();
    state.membership = ready('foreman');
    createJob.mockRejectedValue(jobLimit403('employer_free'));
    await toStepThree(user, plan('employer_free'));

    await user.click(submit());

    await waitFor(() =>
      expect(screen.getByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeInTheDocument());
    expect(upgradeLink()).toBeNull();
    expect(billingLinks()).toHaveLength(0);
    // The self-service way out stays.
    expect(screen.getByRole('link', { name: message('billing.limit_dialog.cta_pause_job') })).toBeInTheDocument();
  });

  it('a Pro owner\'s publish 403 says how to free a slot, with no Upgrade', async () => {
    const user = userEvent.setup();
    createJob.mockRejectedValue(jobLimit403('employer_pro'));
    await toStepThree(user, plan('employer_pro'));

    await user.click(submit());

    await waitFor(() => expect(screen.getByText(message('billing.limit_dialog.pro_owner_hint'))).toBeInTheDocument());
    expect(upgradeLink()).toBeNull();
  });

  it('a Free owner\'s publish 403 still offers Upgrade', async () => {
    const user = userEvent.setup();
    createJob.mockRejectedValue(jobLimit403('employer_free'));
    await toStepThree(user, plan('employer_free'));

    await user.click(submit());

    await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
    expect(screen.queryByText(message('billing.limit_dialog.foreman_body'), { exact: false })).toBeNull();
  });

  it('flag off: Phase 2 copy and no membership hook, even for a foreman row', async () => {
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'false');
    const user = userEvent.setup();
    state.membership = ready('foreman');
    createJob.mockRejectedValue(jobLimit403('employer_free'));
    await toStepThree(user, plan('employer_free'));

    await user.click(submit());

    await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
    expect(membershipCalls.count).toBe(0);
  });

  it('the template pre-check offers a foreman no Upgrade', async () => {
    const user = userEvent.setup();
    state.membership = ready('foreman');
    await toStepThree(user, plan('employer_free', 1));

    await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
    await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
    await user.click(submit());

    // The notice brings its own title (the job still posts), so it shows no
    // body sentence -- only the ways out, and Upgrade is not one of them.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: message('billing.limit_dialog.cta_manage_templates') })).toBeInTheDocument());
    expect(upgradeLink()).toBeNull();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('the template pre-check still offers a Free owner Upgrade', async () => {
    const user = userEvent.setup();
    await toStepThree(user, plan('employer_free', 1));

    await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
    await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
    await user.click(submit());

    await waitFor(() => expect(upgradeLink()).toBeInTheDocument());
  });

  it('the posted screen drops the Billing link for a foreman whose template hit the cap', async () => {
    const user = userEvent.setup();
    state.membership = ready('foreman');
    createJob.mockResolvedValue({ id: 'job-new', title: 'Roofer', location: 'El Paso, TX', status: 'active', shift_periods: [], public_listing_enabled: false });
    saveJobTemplate.mockRejectedValue(new ApiError(403, 'template_limit_reached', { template_limit: 5 }));
    await toStepThree(user, plan('employer_free', 5));

    await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
    await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
    await user.click(submit());

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: message('employer_dashboard.job_posted.title') })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: message('employer_dashboard.templates.manage_link') })).toBeInTheDocument();
    expect(billingLinks()).toHaveLength(0);
  });

  it('the posted screen keeps the Billing link for a Free owner', async () => {
    const user = userEvent.setup();
    createJob.mockResolvedValue({ id: 'job-new', title: 'Roofer', location: 'El Paso, TX', status: 'active', shift_periods: [], public_listing_enabled: false });
    saveJobTemplate.mockRejectedValue(new ApiError(403, 'template_limit_reached', { template_limit: 5 }));
    await toStepThree(user, plan('employer_free', 5));

    await user.click(screen.getByRole('checkbox', { name: message('employer_dashboard.modal.template_save_toggle') }));
    await user.type(screen.getByPlaceholderText(message('employer_dashboard.modal.template_name_placeholder')), 'Roofer copy');
    await user.click(submit());

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: message('employer_dashboard.job_posted.title') })).toBeInTheDocument());
    expect(billingLinks()).toHaveLength(1);
  });
});
