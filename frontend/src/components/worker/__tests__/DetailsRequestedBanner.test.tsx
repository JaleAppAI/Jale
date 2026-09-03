// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { interpolate, message, renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';

// The real `Link` reaches `next/navigation`, which has no resolvable entry
// under vitest -- the same mock the two auth-form suites already use. The
// stub keeps the href verbatim, so the assertions below check the destination
// the component ASKS for rather than the locale prefix the router adds.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const { DetailsRequestedBanner, DetailsRequestedMultiBanner } = await import('../DetailsRequestedBanner');

describe('DetailsRequestedBanner', () => {
  it('links to THIS application, not to the list', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-41f" companyName="Rucoba & Maya" />);
    expect(screen.getByRole('link', { name: message('worker_applications.details_banner.one_cta') }))
      .toHaveAttribute('href', '/worker/applications/app-41f');
  });

  it('names the employer', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Rucoba & Maya" />);
    expect(screen.getByText(
      interpolate(message('worker_applications.details_banner.row_body'), { company: 'Rucoba & Maya' }),
    )).toBeInTheDocument();
  });

  it('shows the remaining count when the caller knows it', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" remainingCount={3} />);
    expect(screen.getByText(
      interpolate(message('worker_applications.details_banner.row_left'), { count: 3 }),
    )).toBeInTheDocument();
  });

  it('claims NO count when the caller does not have one', () => {
    // The home banner has no `remaining_count`; inventing "0 items left" there
    // would be a false statement about the application.
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" />);
    expect(screen.queryByText(/items left/i)).not.toBeInTheDocument();
  });

  it('omits a zero count rather than saying "0 items left"', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" remainingCount={0} />);
    expect(screen.queryByText(/items left/i)).not.toBeInTheDocument();
  });

  it('still renders a sentence when the company name is missing', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName={null} />);
    expect(screen.getAllByText(message('worker_applications.details_banner.one_head')).length)
      .toBeGreaterThan(0);
  });

  it('drops the heading line in the compact row variant', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" compact />);
    expect(screen.queryByText(message('worker_applications.details_banner.one_head')))
      .not.toBeInTheDocument();
  });

  it('renders in Spanish from the real catalogue', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" />, 'es');
    expect(screen.getByRole('link', {
      name: message('worker_applications.details_banner.one_cta', 'es'),
    })).toBeInTheDocument();
  });
});

describe('DetailsRequestedMultiBanner', () => {
  it('counts the waiting applications and links to the list', () => {
    renderIntl(<DetailsRequestedMultiBanner count={2} />);
    expect(screen.getByText(
      interpolate(message('worker_applications.details_banner.many_head'), { count: 2 }),
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: message('worker_applications.details_banner.many_cta') }))
      .toHaveAttribute('href', '/worker/applications');
  });

  it('drops the link ON the list -- there is nowhere to send them', () => {
    renderIntl(<DetailsRequestedMultiBanner count={2} onList />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(message('worker_applications.details_banner.multi_body')))
      .toBeInTheDocument();
  });
});
