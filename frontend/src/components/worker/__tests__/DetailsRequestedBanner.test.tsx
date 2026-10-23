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

import { DetailsRequestedBanner, DetailsRequestedMultiBanner } from '../DetailsRequestedBanner';

describe('DetailsRequestedBanner', () => {
  it('links to THIS application, not to the list', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-41f" companyName="Northwind & Birch" />);
    expect(screen.getByRole('link', { name: message('worker_applications.details_banner.one_cta') }))
      .toHaveAttribute('href', '/worker/applications/app-41f');
  });

  it('names the employer', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Northwind & Birch" />);
    expect(screen.getByText(
      interpolate(message('worker_applications.details_banner.row_body'), { company: 'Northwind & Birch' }),
    )).toBeInTheDocument();
  });

  it('shows the remaining count when the caller knows it', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" remainingCount={3} />);
    expect(screen.getByText('3 items left')).toBeInTheDocument();
  });

  it('says one item, not "1 items", when one is left', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Sample Employer" remainingCount={1} />);
    expect(screen.getByText('1 item left')).toBeInTheDocument();
  });

  it('says one item in Spanish too, and many as many', () => {
    const { unmount } = renderIntl(
      <DetailsRequestedBanner applicationId="app-1" companyName="Sample Employer" remainingCount={1} />,
      'es',
    );
    expect(screen.getByText('Falta 1 cosa')).toBeInTheDocument();
    unmount();
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Sample Employer" remainingCount={3} />, 'es');
    expect(screen.getByText('Faltan 3 cosas')).toBeInTheDocument();
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

/*
 * What the employer wants, in a few words, and how long it takes: "2 questions
 * · 1 document · About 5 min". Built from the request's own counts; a caller
 * with only a total (the home page) keeps the "{count} items left" line.
 */
describe('DetailsRequestedBanner — what is asked and how long it takes', () => {
  const COUNTS = { prompts: 1, fields: 1, certifications: 0, docs: 1 };

  it('lists the asked-for items from the request, questions and fields together', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} />);
    expect(screen.getByText('2 questions')).toBeInTheDocument();
    expect(screen.getByText('1 document')).toBeInTheDocument();
    // A category with nothing in it is not mentioned.
    expect(screen.queryByText(/certification/)).not.toBeInTheDocument();
    // The list replaces the bare total.
    expect(screen.queryByText(/items left/)).not.toBeInTheDocument();
  });

  it('says it takes about 5 minutes, with or without a list', () => {
    const { unmount } = renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} />);
    expect(screen.getByText('About 5 min')).toBeInTheDocument();
    unmount();
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" remainingCount={3} />);
    expect(screen.getByText('About 5 min')).toBeInTheDocument();
    expect(screen.getByText('3 items left')).toBeInTheDocument();
  });

  it('still names the employer in the compact row variant', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} compact />);
    expect(screen.getByText(
      interpolate(message('worker_applications.details_banner.row_body'), { company: 'Acme' }),
    )).toBeInTheDocument();
    expect(screen.getByText('2 questions')).toBeInTheDocument();
  });

  it('says it all in Spanish', () => {
    renderIntl(
      <DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={{ ...COUNTS, certifications: 2 }} />,
      'es',
    );
    expect(screen.getByText('2 preguntas')).toBeInTheDocument();
    expect(screen.getByText('2 certificaciones')).toBeInTheDocument();
    expect(screen.getByText('1 documento')).toBeInTheDocument();
    expect(screen.getByText('Unos 5 min')).toBeInTheDocument();
  });
});

/*
 * The dots between the parts are decoration and hidden from assistive tech,
 * so the parts need a separator a screen reader can hear; otherwise the line
 * is announced as one run of words ("2 questions1 documentAbout 5 min").
 */
describe('DetailsRequestedBanner — summary read aloud', () => {
  const COUNTS = { prompts: 1, fields: 1, certifications: 0, docs: 1 };

  /** The text a screen reader reaches: everything except `aria-hidden` subtrees. */
  function spokenText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
    return Array.from(node.childNodes).map(spokenText).join('');
  }

  it('separates the parts in the text assistive tech reads', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} />);
    expect(spokenText(screen.getByRole('alert'))).toContain('2 questions, 1 document, About 5 min');
  });

  it('separates the count and the time when only a total is known', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" remainingCount={3} />);
    expect(spokenText(screen.getByRole('alert'))).toContain('3 items left, About 5 min');
  });

  it('separates the parts in Spanish too', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} />, 'es');
    expect(spokenText(screen.getByRole('alert'))).toContain('2 preguntas, 1 documento, Unos 5 min');
  });

  it('keeps the visible dots', () => {
    renderIntl(<DetailsRequestedBanner applicationId="app-1" companyName="Acme" counts={COUNTS} />);
    const dots = screen.getByRole('alert').querySelectorAll('[aria-hidden="true"]');
    expect(Array.from(dots).filter((dot) => dot.textContent?.includes('·'))).toHaveLength(2);
  });
});

describe('DetailsRequestedMultiBanner', () => {
  it('counts the waiting applications and links to the list', () => {
    renderIntl(<DetailsRequestedMultiBanner count={2} />);
    expect(screen.getByText('2 applications need your details')).toBeInTheDocument();
    expect(screen.getByText('2 employers want to move forward with you.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: message('worker_applications.details_banner.many_cta') }))
      .toHaveAttribute('href', '/worker/applications');
  });

  it('agrees with its count in both languages, one included', () => {
    // The pages render this banner only for two or more, but the sentence
    // itself must not depend on that to be grammatical.
    const { unmount } = renderIntl(<DetailsRequestedMultiBanner count={1} />);
    expect(screen.getByText('1 application needs your details')).toBeInTheDocument();
    expect(screen.getByText('1 employer wants to move forward with you.')).toBeInTheDocument();
    unmount();
    renderIntl(<DetailsRequestedMultiBanner count={3} />, 'es');
    expect(screen.getByText('3 postulaciones necesitan tus datos')).toBeInTheDocument();
    expect(screen.getByText('3 empleadores quieren seguir adelante contigo.')).toBeInTheDocument();
  });

  it('drops the link ON the list -- there is nowhere to send them', () => {
    renderIntl(<DetailsRequestedMultiBanner count={2} onList />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(message('worker_applications.details_banner.multi_body')))
      .toBeInTheDocument();
  });
});
