// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

// `next-intl`'s navigation factory reaches into `next/navigation` internals
// that jsdom + vitest can't resolve outside a real Next.js app (the other
// employer component suites in this repo hit the same wall and stub it the
// same way -- see `components/employer/__tests__/ConversationThread.test.tsx`).
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import { ApplicantOverviewRow } from '../ApplicantOverviewRow';
import type { ApplicantOverviewItem } from '@/lib/api/employer';

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
};

describe('ApplicantOverviewRow', () => {
  it('shows name, job with city, status, match badge, and capped skills', () => {
    renderIntl(<ApplicantOverviewRow item={item} />);
    expect(screen.getByText('Maria Garcia')).toBeInTheDocument();
    expect(screen.getByText('Line Cook · Austin')).toBeInTheDocument();
    expect(screen.getByText(message('employer_dashboard.applicants.status.pending'))).toBeInTheDocument();
    expect(screen.getByText(/Strong match/)).toBeInTheDocument();
    expect(screen.getByText('grill')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument(); // 5 skills, 4 shown
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
