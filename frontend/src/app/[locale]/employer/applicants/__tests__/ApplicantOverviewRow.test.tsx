// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// `next-intl`'s navigation factory reaches into `next/navigation` internals
// that jsdom + vitest can't resolve outside a real Next.js app (the other
// employer component suites in this repo hit the same wall and stub it the
// same way -- see `components/employer/__tests__/ConversationThread.test.tsx`).
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token', isAuthenticated: true, userType: 'employer' }),
}));

const openConversation = vi.fn();
vi.mock('@/contexts/ConversationDrawerContext', () => ({
  useConversationDrawer: () => ({ openConversation, openRequest: null }),
}));

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
}));

const updateApplicantStatus = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  updateApplicantStatus: (...args: unknown[]) => updateApplicantStatus(...args),
}));

import { interpolate, message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ApplicantOverviewRow } from '../ApplicantOverviewRow';
import type { ApplicantOverviewItem } from '@/lib/api/employer';
import { ApiError } from '@/lib/api/errors';

const item: ApplicantOverviewItem = {
  application_id: 'app-1',
  worker_id: 'w-1',
  worker_name: 'Maria Garcia',
  job_id: 'j-1',
  job_title: 'Line Cook',
  job_city: 'Austin',
  job_status: 'active',
  application_status: 'pending',
  applied_at: '2026-08-30T00:00:00Z',
  skills: ['grill', 'prep', 'safety', 'inventory', 'plating'],
  availability: 'weekdays',
  years_experience: 4,
  match_score: 72,
  score_band: 'strong',
  trust_score: 78,
};

describe('ApplicantOverviewRow', () => {
  it('shows name, job with city, status, match badge, and capped skills', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    expect(screen.getByText('Maria Garcia')).toBeInTheDocument();
    expect(screen.getByText('Line Cook · Austin')).toBeInTheDocument();
    // Twice since B4: the badge that STATES the status, and the option for it
    // in the inline status select beside it.
    expect(screen.getAllByText(message('employer_dashboard.applicants.status.pending'))).toHaveLength(2);
    expect(screen.getByText(/Strong match/)).toBeInTheDocument();
    expect(screen.getByText('grill')).toBeInTheDocument();
    // 5 skills, 4 shown. B8 replaced the dead `+1` badge with a labelled
    // toggle -- the count still has to be visible, but as something an
    // employer can act on. See the overflow suite below.
    expect(screen.getByRole('button', {
      name: interpolate(message('employer_applicants.skills_show_all'), { count: 5 }),
    })).toBeInTheDocument();
  });

  it('says "not scored" instead of showing a zero when there is no cached score', () => {
    renderIntl(<ApplicantOverviewRow item={{ ...item, match_score: null, score_band: null }} />);
    expect(screen.getByText(message('employer_applicants.not_scored'))).toBeInTheDocument();
    expect(screen.queryByText(/strong match|good match|fair match/i)).not.toBeInTheDocument();
  });

  it('links to the worker profile scoped to the job', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    const link = screen.getByRole('link', { name: message('employer_dashboard.applicants.view_profile') });
    expect(link.getAttribute('href')).toContain('/employer/workers/w-1');
    expect(link.getAttribute('href')).toContain('job_id=j-1');
  });
});

// ---------------------------------------------------------------------------
// B8 (sprint 24) -- the row showed name, job, date, status, match badge and 4
// skills. The API had already been returning availability, years_experience
// and (now) trust_score, so an employer scanning the cross-job list had to
// open every profile to learn anything about the worker.
// ---------------------------------------------------------------------------

describe('ApplicantOverviewRow qualifications', () => {
  it('shows the availability badge, translated through the shared filter labels', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    // `weekdays` is not one of the seven known values, so the badge is absent
    // rather than showing a raw API string.
    expect(screen.queryByText('weekdays')).not.toBeInTheDocument();

    renderIntl(<ApplicantOverviewRow item={{ ...item, availability: 'weekends' }} />);
    expect(screen.getByText(message('employer_job_listing.filters.availability_weekends')))
      .toBeInTheDocument();
  });

  it('normalizes the API spellings the per-job list already accepts', () => {
    renderIntl(<ApplicantOverviewRow item={{ ...item, availability: 'Full-Time' }} />);
    expect(screen.getByText(message('employer_job_listing.filters.availability_full_time')))
      .toBeInTheDocument();
  });

  it('shows years of experience', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    expect(screen.getByText('4 yrs exp')).toBeInTheDocument();
  });

  it('omits the experience badge entirely when the profile has no number', () => {
    // Not "0 yrs exp": a worker who never filled it in has not told us they
    // are a beginner.
    renderIntl(<ApplicantOverviewRow item={{ ...item, years_experience: null }} />);
    expect(screen.queryByText(/yrs? exp/)).not.toBeInTheDocument();
  });

  it('shows the trust pill, reusing the per-job component', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    expect(screen.getByText('Trust 78/100')).toBeInTheDocument();
  });

  it('renders no trust pill for a worker who was never assessed', () => {
    renderIntl(<ApplicantOverviewRow item={{ ...item, trust_score: null }} />);
    expect(screen.queryByText(/^Trust /)).not.toBeInTheDocument();
    // Absent (old API) must behave like null, never like a zero.
    renderIntl(<ApplicantOverviewRow item={{ ...item, trust_score: undefined }} />);
    expect(screen.queryByText(/^Trust /)).not.toBeInTheDocument();
  });
});

describe('ApplicantOverviewRow skill overflow', () => {
  it('expands the +N overflow inline and collapses again', async () => {
    const user = userEvent.setup();
    renderIntl(<ApplicantOverviewRow item={item} />);

    // 5 skills, 4 shown -> a real button, not a dead badge.
    const toggle = screen.getByRole('button', {
      name: interpolate(message('employer_applicants.skills_show_all'), { count: 5 }),
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('plating')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByText('plating')).toBeInTheDocument();
    const collapse = screen.getByRole('button', {
      name: message('employer_applicants.skills_show_fewer'),
    });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapse);
    expect(screen.queryByText('plating')).not.toBeInTheDocument();
  });

  it('offers no toggle when every skill already fits', () => {
    renderIntl(<ApplicantOverviewRow item={{ ...item, skills: ['grill', 'prep'] }} />);
    // Named rather than "no button at all": the row has action buttons of its
    // own since B4, and this assertion is about the skills toggle.
    expect(screen.queryByRole('button', {
      name: interpolate(message('employer_applicants.skills_show_all'), { count: 2 }),
    })).not.toBeInTheDocument();
    expect(screen.getByText('grill')).toBeInTheDocument();
    expect(screen.getByText('prep')).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// B4 (sprint 26) -- the row's only action was "View Profile". Triaging a list
// of applicants therefore meant opening every one of them: two clicks and a
// page load to move somebody to "talking", and no way at all to write to them
// from here.
// ---------------------------------------------------------------------------

describe('ApplicantOverviewRow actions', () => {
  beforeEach(() => {
    openConversation.mockReset();
    toastError.mockReset();
    updateApplicantStatus.mockReset();
  });

  it('opens the drawer for THIS applicant', async () => {
    const user = userEvent.setup();
    renderIntl(<ApplicantOverviewRow item={item} />);

    await user.click(screen.getByRole('button', { name: message('employer_applicants.message_action') }));

    // The application, not a conversation: whether a thread exists is the
    // drawer's question to answer against the inbox.
    expect(openConversation).toHaveBeenCalledWith({
      application_id: 'app-1',
      worker_id: 'w-1',
      job_id: 'j-1',
    });
  });

  it('saves a status change against the job and worker, with no Save button', async () => {
    const user = userEvent.setup();
    updateApplicantStatus.mockResolvedValue({ status: 'talking' });
    renderIntl(<ApplicantOverviewRow item={item} />);

    const select = screen.getByRole('combobox', { name: message('employer_applicants.status_label') });
    await user.selectOptions(select, 'talking');

    expect(updateApplicantStatus).toHaveBeenCalledWith('test-token', 'j-1', 'w-1', 'talking');
    // Optimistic: the row shows the new status without waiting for the PATCH.
    expect((select as HTMLSelectElement).value).toBe('talking');
  });

  it('puts the old status back and says so when the save fails', async () => {
    const user = userEvent.setup();
    updateApplicantStatus.mockRejectedValue(new Error('boom'));
    renderIntl(<ApplicantOverviewRow item={item} />);

    const select = screen.getByRole('combobox', { name: message('employer_applicants.status_label') });
    await user.selectOptions(select, 'talking');

    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('pending'));
    expect(toastError).toHaveBeenCalled();
  });

  it('never sends a PATCH for the status the row already has', async () => {
    const user = userEvent.setup();
    // `details_requested` is offered ONLY because it is the current value (a
    // <select> whose value matches no option shows the first one instead), and
    // the ruling in lib/hire-gate is that the dropdown must never MOVE an
    // application into it -- that transition notifies the worker and belongs
    // to the "Request details" button. On the detail page the disabled Save
    // enforces that; here the guard is the only thing that can.
    renderIntl(<ApplicantOverviewRow item={{ ...item, application_status: 'details_requested' }} />);

    const select = screen.getByRole('combobox', { name: message('employer_applicants.status_label') });
    await user.selectOptions(select, 'details_requested');

    expect(updateApplicantStatus).not.toHaveBeenCalled();
  });

  it('offers hired, and explains the refusal the database owns', async () => {
    const user = userEvent.setup();
    updateApplicantStatus.mockRejectedValue(
      new ApiError(409, 'details_incomplete', { missing: { fields: ['ssn'], docs: [], certifications: [] } }),
    );
    renderIntl(<ApplicantOverviewRow item={item} />);

    const select = screen.getByRole('combobox', { name: message('employer_applicants.status_label') });
    // The row carries no `details_status`, so the gate FAILS OPEN here exactly
    // as `hireBlockReason` does: the option is offered and the 409 is the
    // authority -- the same arrangement the worker detail page relies on.
    await user.selectOptions(select, 'hired');

    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('pending'));
    expect(toastError).toHaveBeenCalledWith(message('employer_applicants.hire_blocked'));
  });

  it('keeps View Profile', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    expect(screen.getByRole('link', { name: message('employer_dashboard.applicants.view_profile') }))
      .toBeInTheDocument();
  });
});
