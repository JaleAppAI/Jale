// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { EmployerProfileData } from '@/lib/api/employer';

/*
 * The employer profile's read-only body is a `FactsCard`, not a `KVList`.
 *
 * Four sections: company tiles, contact tiles, the hiring chip facts, and the
 * company description. The chips are LEFT-aligned inside their tiles for the
 * same reason as on the worker profile -- a tile labels its value from above.
 *
 * The section labels are deliberately NOT byte-identical to any tile label
 * inside them ("Company details" over a "Company" tile): `FactsCard` styles an
 * `h3` section label and a `dt` tile label with the same class list, so a
 * repeated word would render as the same eyebrow twice in a row.
 */

// `@/i18n/navigation` builds next-intl's navigation shims at module scope, and
// next-intl's ESM build resolves `next/navigation` in a way vitest cannot. Every
// component suite in this repo stubs it for that reason.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  redirect: vi.fn(),
  usePathname: () => '/employer/profile',
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The digest panel owns its own fetch and its own error surface; it is not part
// of the profile card and would only add a second network dependency here.
vi.mock('@/components/employer/DigestSettingsPanel', () => ({
  DigestSettingsPanel: () => <div data-digest-panel="stub" />,
}));

/** Assigned by each test before rendering; the fake hook serves it as-is. */
let seed: EmployerProfileData;

vi.mock('@/hooks/usePageData', () => ({
  usePageData: () => ({
    phase: 'ready' as const,
    data: seed,
    empty: false,
    errorKind: null,
    refreshing: false,
    refreshError: null,
    retry: vi.fn(),
    refresh: vi.fn(),
    setData: vi.fn(),
  }),
}));

import {
  expectNoRawMessageKeys,
  message,
  renderIntl,
} from '@/components/worker/onboarding/__tests__/render-intl';
import EmployerProfilePage from '../page';

const FULL: EmployerProfileData = {
  id: '9c2f7b41-8e3d-4a56-b107-5d4e9f2a6c38',
  user_type: 'employer',
  email: 'ops@bravo-construccion.com',
  phone: '+15125550188',
  full_name: 'Bravo Construccion LLC',
  tenant_id: null,
  created_at: '2026-01-14T10:00:00.000Z',
  company_name: 'Bravo Construccion LLC',
  contact_name: 'Ivan Bravo',
  city: 'Austin, TX',
  service_area: 'Greater Austin and San Marcos',
  hiring_trades: ['electrician', 'concrete'],
  typical_job_types: ['full-time', 'contract'],
  company_size: '11-50',
  company_description: 'Commercial concrete and electrical.\nCrews of six to twelve.',
};

/** Only what signup guarantees -- everything the employer never filled in. */
const SPARSE: EmployerProfileData = {
  ...FULL,
  phone: null,
  full_name: null,
  company_name: null,
  contact_name: null,
  city: null,
  service_area: null,
  hiring_trades: [],
  typical_job_types: [],
  company_size: null,
  company_description: null,
};

/**
 * The `FactsCard` body: every section shares one parent, so the first section's
 * parent IS the card.
 */
function factsCard(): HTMLElement {
  const first = document.querySelector('[data-section="0"]');
  if (!first?.parentElement) throw new Error('no FactsCard body rendered');
  return first.parentElement as HTMLElement;
}

/** A tile, located by its `dt`, returned as the `dt`/`dd` pair. */
function tile(label: string): { term: HTMLElement; value: HTMLElement } {
  const term = within(factsCard()).getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!value || value.tagName !== 'DD') throw new Error(`"${label}" has no dd beside its dt`);
  return { term, value: value as HTMLElement };
}

const K = {
  sectionCompany: message('employer.profile.section_company'),
  sectionContact: message('employer.profile.section_contact'),
  sectionHiring: message('employer.profile.section_hiring'),
  sectionDescription: message('employer.profile.field_description'),
  company: message('employer.profile.field_company'),
  size: message('employer.profile.field_company_size'),
  city: message('employer.profile.field_city'),
  serviceArea: message('employer.profile.field_service_area'),
  contact: message('employer.profile.field_contact'),
  email: message('employer.profile.field_email'),
  phone: message('employer.profile.field_phone'),
  trades: message('employer.profile.field_hiring_trades'),
  jobTypes: message('employer.profile.field_job_types'),
  edit: message('employer.profile.edit_button'),
};

describe('employer profile -- the facts card', () => {
  it('renders the company tiles under their own section', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.sectionCompany }),
    ).toBeInTheDocument();
    expect(tile(K.company).value).toHaveTextContent('Bravo Construccion LLC');
    expect(tile(K.size).value).toHaveTextContent('11-50');
    expect(tile(K.city).value).toHaveTextContent('Austin, TX');
    expect(tile(K.serviceArea).value).toHaveTextContent('Greater Austin and San Marcos');
  });

  it('renders the contact tiles under their own section', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.sectionContact }),
    ).toBeInTheDocument();
    expect(tile(K.contact).value).toHaveTextContent('Ivan Bravo');
    expect(tile(K.email).value).toHaveTextContent('ops@bravo-construccion.com');
    expect(tile(K.phone).value).toHaveTextContent('+15125550188');
  });

  it('renders the hiring trades and job types as LEFT-aligned chips', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.sectionHiring }),
    ).toBeInTheDocument();

    for (const [label, chips] of [
      [
        K.trades,
        [message('auth.employer.trades.electrician'), message('auth.employer.trades.concrete')],
      ],
      [
        K.jobTypes,
        [
          message('auth.employer.job_types.full_time'),
          message('auth.employer.job_types.contract'),
        ],
      ],
    ] as const) {
      const { value } = tile(label);
      for (const chip of chips) expect(within(value).getByText(chip)).toBeInTheDocument();
      expect(value.querySelector('.justify-end')).toBeNull();
      expect(value.querySelector('.justify-start')).not.toBeNull();
    }

    expect(factsCard().querySelectorAll('.justify-end')).toHaveLength(0);
  });

  it('renders the description as a paragraph under its own section', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.sectionDescription }),
    ).toBeInTheDocument();
    expect(within(factsCard()).getByText(/Commercial concrete and electrical/)).toBeInTheDocument();
    // Four sections means exactly three dividers.
    expect(factsCard().querySelectorAll('[data-divider="true"]')).toHaveLength(3);
  });

  it('gives no section label the same words as a tile label inside it', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    const card = factsCard();
    // `Array.from`, not a spread: this tsconfig targets below es2015, where a
    // NodeList is not iterable.
    const sectionLabels = Array.from(card.querySelectorAll('h3'), (h) => h.textContent?.trim());
    const tileLabels = Array.from(card.querySelectorAll('dt'), (d) => d.textContent?.trim());
    for (const label of sectionLabels) expect(tileLabels).not.toContain(label);
  });

  it('mutes the unset tiles and drops the description on a sparse profile', () => {
    seed = SPARSE;
    renderIntl(<EmployerProfilePage />);

    // The page's own "not added"/"not set" wording, unchanged.
    for (const [label, empty] of [
      [K.company, message('employer.profile.empty_company')],
      [K.size, message('employer.profile.empty_company_size')],
      [K.city, message('employer.profile.empty_city')],
      [K.serviceArea, message('employer.profile.empty_service_area')],
      [K.contact, message('employer.profile.empty_contact')],
      [K.phone, message('employer.profile.empty_phone')],
      [K.trades, message('employer.profile.empty_hiring_trades')],
      [K.jobTypes, message('employer.profile.empty_job_types')],
    ] as const) {
      const { value } = tile(label);
      expect(value).toHaveTextContent(empty);
      expect(value.className).toContain('text-[var(--jale-ink-2)]');
    }

    // Email always exists, so it is never muted.
    expect(tile(K.email).value.className).not.toContain('text-[var(--jale-ink-2)]');

    expect(
      within(factsCard()).queryByRole('heading', { level: 3, name: K.sectionDescription }),
    ).not.toBeInTheDocument();
    expect(factsCard().querySelectorAll('[data-divider="true"]')).toHaveLength(2);
  });

  it('leaves the heading and the Edit button exactly as they were', () => {
    seed = FULL;
    renderIntl(<EmployerProfilePage />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Bravo Construccion LLC' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: K.edit })).toBeInTheDocument();
  });

  it('renders no raw message key, in either locale', () => {
    for (const locale of ['en', 'es'] as const) {
      seed = FULL;
      const { unmount } = renderIntl(<EmployerProfilePage />, locale);
      expectNoRawMessageKeys();
      unmount();
    }
  });
});
