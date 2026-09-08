// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { WorkerProfileData, WorkerVaultDoc, WorkerPost } from '@/lib/api/worker';

/*
 * The worker profile's read-only body is a `FactsCard`, not a `KVList`.
 *
 * Three sections: the "Datos" tiles, the chip facts (skills, certifications,
 * preferred cities), and the bio paragraph. The chips are LEFT-aligned inside a
 * tile -- a tile's label sits ABOVE its value, so right-aligned chips would
 * drift away from the label naming them.
 *
 * Everything the reader can act on is unchanged: the panel heading is still the
 * worker's name and the Edit button still opens `ProfileEditForm`.
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
  usePathname: () => '/worker/profile',
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}));

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The document slots and the media board own their own fetches and are not what
// this suite is about; markers keep a change in either from turning it red.
vi.mock('@/components/worker/DocumentSlot', () => ({
  DocumentSlot: ({ doc_type }: { doc_type: string }) => <div data-doc-slot={doc_type} />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({
  MediaBoardGrid: () => <div data-media-board="grid" />,
}));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));
vi.mock('@/components/media-board/NewPostModal', () => ({ NewPostModal: () => null }));

// `PayReferenceHint` fetches BLS data and renders null without a trade+city.
// Mocked to a marker so "the hint stays beneath the preferred cities" is
// assertable without standing up the pay-reference endpoint.
vi.mock('@/components/PayReferenceHint', () => ({
  PayReferenceHint: () => <div data-pay-hint="worker-profile" />,
}));

/** Assigned by each test before rendering; the fake hook serves it as-is. */
let seed: {
  profile: WorkerProfileData;
  docs: WorkerVaultDoc[];
  posts: WorkerPost[];
  next_before: string | null;
  next_before_id: string | null;
};

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
import WorkerProfilePage from '../page';

const FULL: WorkerProfileData = {
  id: '3f1c9a52-6d2b-4e18-9a44-7c0e5b8d1f23',
  phone: '+15125550143',
  full_name: 'Marta Reyes',
  skills: ['Conduit bending', 'Panel wiring'],
  availability: 'full_time',
  years_experience: 9,
  location: 'Austin, TX',
  bio: 'Nine years of residential rewires.\nComfortable running my own crew.',
  certifications: ['OSHA 10'],
  preferred_cities: [
    { city: 'Austin', state: 'TX', city_key: 'austin-tx' },
    { city: 'Round Rock', state: 'TX', city_key: 'round-rock-tx' },
  ],
  main_trade: 'electrician',
  main_trade_other: null,
};

/** Everything optional left unset -- the shape a brand-new worker has. */
const SPARSE: WorkerProfileData = {
  id: FULL.id,
  phone: '+15125550143',
  full_name: null,
  skills: [],
  availability: null,
  years_experience: null,
  location: null,
  bio: null,
  certifications: [],
  preferred_cities: [],
  main_trade: null,
  main_trade_other: null,
};

function seedWith(profile: WorkerProfileData) {
  seed = { profile, docs: [], posts: [], next_before: null, next_before_id: null };
}

/**
 * The `FactsCard` body: every section shares one parent, so the first section's
 * parent IS the card. Anchoring on `data-section` rather than climbing out of a
 * heading survives any change to the panel's wrapper markup.
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
  basics: message('worker_profile.section_basics'),
  skillsSection: message('worker_profile.section_skills'),
  bioSection: message('worker_profile.field_bio'),
  name: message('worker_profile.field_name'),
  phone: message('worker_profile.field_phone'),
  location: message('worker_profile.field_location'),
  years: message('worker_profile.field_years_experience'),
  availability: message('worker_profile.field_availability'),
  skills: message('worker_profile.field_skills'),
  certifications: message('worker_profile.field_certifications'),
  cities: message('worker_profile.edit.preferred_cities_label'),
  edit: message('worker_profile.edit_button'),
};

describe('worker profile -- the facts card', () => {
  it('renders the five Datos tiles as dt/dd pairs', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.basics }),
    ).toBeInTheDocument();
    expect(tile(K.name).value).toHaveTextContent('Marta Reyes');
    expect(tile(K.phone).value).toHaveTextContent('+15125550143');
    expect(tile(K.location).value).toHaveTextContent('Austin, TX');
    expect(tile(K.years).value).toHaveTextContent('9');
    expect(tile(K.availability).value).toHaveTextContent(
      message('worker_profile.availability.full_time'),
    );
    // Three sections (tiles, chips, bio) means exactly two dividers.
    expect(factsCard().querySelectorAll('[data-divider="true"]')).toHaveLength(2);
  });

  it('renders skills, certifications and preferred cities as LEFT-aligned chips', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.skillsSection }),
    ).toBeInTheDocument();

    for (const [label, chips] of [
      [K.skills, ['Conduit bending', 'Panel wiring']],
      [K.certifications, ['OSHA 10']],
      [K.cities, ['Austin, TX', 'Round Rock, TX']],
    ] as const) {
      const { value } = tile(label);
      for (const chip of chips) expect(within(value).getByText(chip)).toBeInTheDocument();
      // The chip row starts at the tile's left edge, under its label.
      expect(value.querySelector('.justify-end')).toBeNull();
      expect(value.querySelector('.justify-start')).not.toBeNull();
    }

    // Nothing in the card keeps the KV-row right alignment.
    expect(factsCard().querySelectorAll('.justify-end')).toHaveLength(0);
  });

  it('keeps the pay reference hint beneath the preferred cities', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);
    expect(tile(K.cities).value.querySelector('[data-pay-hint="worker-profile"]')).not.toBeNull();
  });

  it('renders the bio as a paragraph under its own section', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.bioSection }),
    ).toBeInTheDocument();
    // `whitespace-pre-wrap` text: the newline survives into the DOM, so match a
    // line rather than the whole two-line string.
    expect(within(factsCard()).getByText(/Nine years of residential rewires/)).toBeInTheDocument();
  });

  it('keeps the bio section on an empty bio, showing the placeholder muted', () => {
    // The section is NOT dropped: "About / No description added" is the prompt
    // to write one, and this is the worker's own profile -- the one surface
    // where that nudge is the point. Muted, so it does not read as a fact.
    seedWith(SPARSE);
    renderIntl(<WorkerProfilePage />);

    expect(
      within(factsCard()).getByRole('heading', { level: 3, name: K.bioSection }),
    ).toBeInTheDocument();
    const empty = within(factsCard()).getByText(message('worker_profile.empty_bio'));
    expect(empty.className).toContain('text-[var(--jale-ink-2)]');
  });

  it('renders a real bio in full ink, not muted', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);

    const body = within(factsCard()).getByText(/Nine years of residential rewires/);
    expect(body.className).toContain('text-[var(--jale-ink)]');
    expect(body.className).not.toContain('text-[var(--jale-ink-2)]');
  });

  it('mutes the unset tiles on a sparse profile', () => {
    seedWith(SPARSE);
    renderIntl(<WorkerProfilePage />);

    // The page's own "not set" wording, unchanged from the KVList era.
    for (const [label, empty] of [
      [K.name, message('worker_profile.empty_name')],
      [K.location, message('worker_profile.empty_location')],
      [K.years, message('worker_profile.empty_experience')],
      [K.availability, message('worker_profile.empty_availability')],
      [K.skills, message('worker_profile.empty_skills')],
      [K.certifications, message('worker_profile.empty_certifications')],
      [K.cities, message('worker_profile.empty_preferred_cities')],
    ] as const) {
      const { value } = tile(label);
      expect(value).toHaveTextContent(empty);
      expect(value.className).toContain('text-[var(--jale-ink-2)]');
    }

    // The three sections are unconditional now, so the divider count does not
    // move between a full and a sparse profile.
    expect(factsCard().querySelectorAll('[data-divider="true"]')).toHaveLength(2);
  });

  it('treats zero years of experience as an answer, not an absence', () => {
    // The muted flag tests `=== null`, never falsiness: a worker who answered
    // "0 years" has answered, and greying that out with the "not added" copy
    // would lose a real fact.
    seedWith({ ...FULL, years_experience: 0 });
    renderIntl(<WorkerProfilePage />);

    const { value } = tile(K.years);
    expect(value).toHaveTextContent('0');
    expect(value).not.toHaveTextContent(message('worker_profile.empty_experience'));
    expect(value.className).not.toContain('text-[var(--jale-ink-2)]');
  });

  // BOTH locales: the clash is between two pieces of COPY, so it can exist in
  // one language and not the other. An en-only check would pass a Spanish
  // wording that happens to collide.
  it.each(['en', 'es'] as const)(
    'gives no section label the same words as a tile label inside it (%s)',
    (locale) => {
      // `FactsCard` styles an `h3` section label and a `dt` tile label with the
      // same class list, so a repeated word renders as the same eyebrow twice
      // in a row -- which reads as a bug. The bio section reuses `field_bio`,
      // so this also guards against a future tile claiming that label too.
      seedWith(FULL);
      renderIntl(<WorkerProfilePage />, locale);

      const card = factsCard();
      const sectionLabels = Array.from(card.querySelectorAll('h3'), (h) => h.textContent?.trim());
      const tileLabels = Array.from(card.querySelectorAll('dt'), (d) => d.textContent?.trim());
      for (const label of sectionLabels) expect(tileLabels).not.toContain(label);
    },
  );

  it('leaves the heading and the Edit button exactly as they were', () => {
    seedWith(FULL);
    renderIntl(<WorkerProfilePage />);

    expect(screen.getByRole('heading', { level: 2, name: 'Marta Reyes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: K.edit })).toBeInTheDocument();
  });

  it('renders no raw message key, in either locale', () => {
    for (const locale of ['en', 'es'] as const) {
      seedWith(FULL);
      const { unmount } = renderIntl(<WorkerProfilePage />, locale);
      expectNoRawMessageKeys();
      unmount();
    }
  });
});
