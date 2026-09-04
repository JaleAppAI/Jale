// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

/*
 * Pausing was only reachable from a job's own page, which is the one place an
 * employer is NOT when they hit the active-job limit: the limit dialog's own
 * "Pause another job" CTA sends them to this board, where every row offered
 * Details and Delete and nothing in between. Owner report, 2026-09-03 release.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { interpolate, message, renderIntl } from './render-intl';
import { JobPostingCard } from '../JobPostingCard';
import type { Job } from '@/lib/api/employer';

const baseJob: Job = {
  id: 'job-1',
  title: 'Concrete Finisher',
  location: 'El Paso, TX',
  pay: null,
  pay_min: null,
  pay_max: null,
  pay_interval: null,
  job_type: 'full-time',
  status: 'active',
  applicant_count: 2,
  hired_count: 0,
  open_count: 1,
  number_of_workers_needed: 1,
  trade_category: 'concrete',
  created_at: '2026-08-01T00:00:00Z',
  start_date: null,
  expected_duration: null,
  shift_schedule: null,
  transportation_required: false,
  work_authorization_required: false,
  language_preference: ['any'],
  required_experience_years: null,
  required_experience_months: null,
  certifications: [],
};

const job = (over: Partial<Job> = {}): Job => ({ ...baseJob, ...over });

const pauseLabel = () =>
  interpolate(message('employer_dashboard.jobs.status_change.pause_aria'), { title: baseJob.title });
const resumeLabel = () =>
  interpolate(message('employer_dashboard.jobs.status_change.resume_aria'), { title: baseJob.title });

describe('JobPostingCard pause and resume', () => {
  it('offers Pause on an active job and hands the row back', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    renderIntl(
      <JobPostingCard job={job()} href="/employer/jobs/job-1" onPause={onPause} onResume={onResume} />,
    );
    const button = screen.getByRole('button', { name: pauseLabel() });
    expect(screen.queryByRole('button', { name: resumeLabel() })).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(onPause).toHaveBeenCalledWith(baseJob);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('offers Resume on a paused job', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const paused = job({ status: 'paused' });
    renderIntl(
      <JobPostingCard job={paused} href="/employer/jobs/job-1" onPause={onPause} onResume={onResume} />,
    );
    expect(screen.queryByRole('button', { name: pauseLabel() })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: resumeLabel() }));
    expect(onResume).toHaveBeenCalledWith(paused);
    expect(onPause).not.toHaveBeenCalled();
  });

  it.each(['filled', 'closed'] as const)('offers neither on a %s job', (status) => {
    renderIntl(
      <JobPostingCard job={job({ status })} href="/employer/jobs/job-1" onPause={vi.fn()} onResume={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: pauseLabel() })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: resumeLabel() })).not.toBeInTheDocument();
  });

  it('renders nothing when the caller wires no handler (the templates board)', () => {
    renderIntl(<JobPostingCard job={job()} href="/employer/jobs/job-1" />);
    expect(screen.queryByRole('button', { name: pauseLabel() })).not.toBeInTheDocument();
  });

  it('freezes the control and says so while the change is in flight', () => {
    const onPause = vi.fn();
    renderIntl(
      <JobPostingCard job={job()} href="/employer/jobs/job-1" onPause={onPause} statusPending />,
    );
    const button = screen.getByRole('button', { name: pauseLabel() });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(message('employer_dashboard.jobs.status_change.pause_pending'));
    fireEvent.click(button);
    expect(onPause).not.toHaveBeenCalled();
  });

  it('keeps Delete alongside the new control', () => {
    const onDelete = vi.fn();
    renderIntl(
      <JobPostingCard job={job()} href="/employer/jobs/job-1" onDelete={onDelete} onPause={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: interpolate(message('employer_dashboard.jobs.delete.button_aria'), { title: baseJob.title }),
      }),
    );
    expect(onDelete).toHaveBeenCalledWith(baseJob);
  });
});
