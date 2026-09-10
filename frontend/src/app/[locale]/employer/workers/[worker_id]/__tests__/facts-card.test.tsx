// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import type { WorkerProfile } from '@/lib/api/employer';

/*
 * The applicant card's facts are a `FactsCard`, not a `KVList`.
 *
 * ONE unlabelled tiles section: this card's heading is the worker's name in the
 * panel head above it, and a single group has nothing to be distinguished from,
 * so a section label would only repeat the panel.
 *
 * Transportation keeps its existing behaviour: the tile is OMITTED when the
 * worker never answered, because a blank value reads as "no transportation".
 *
 * `AnswerHighlights`, `DocumentSlots` and the trust panel are untouched by this
 * lane and are stubbed out below.
 */

const WORKER_ID = '7d1e4c86-2b93-4f57-a0c1-9e83b5d2740a';
const JOB_ID = 'b4a9f215-6c37-4e80-9d52-1f7a3c8e6b09';

// The page validates BOTH ids against a UUID shape and short-circuits to its
// invalid-link state otherwise -- with a fake id the facts card never renders.
vi.mock('next/navigation', () => ({
  useParams: () => ({ worker_id: WORKER_ID }),
  useSearchParams: () => new URLSearchParams(`job_id=${JOB_ID}`),
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
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

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/AppShellSkeleton', () => ({
  AppShellSkeleton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../DocumentSlots', () => ({
  DocumentSlots: () => <div data-document-slots="stub" />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({
  MediaBoardGrid: () => <div data-media-board="grid" />,
}));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));

/** Assigned by each test before rendering; the fake hook serves it as-is. */
let seed: { profile: WorkerProfile; documents: never[]; posts: never[] };

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
import EmployerWorkerPage from '../page';

function profile(overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    worker_id: WORKER_ID,
    full_name: 'Marta Reyes',
    phone: '+15125550143',
    skills: ['Conduit bending'],
    availability: 'full_time',
    years_experience: 9,
    experience_months: 112,
    certifications: ['OSHA 10'],
    location: 'Austin, TX',
    city: 'Austin, TX',
    main_trade: 'electrician',
    main_trade_other: null,
    has_transportation: true,
    application_status: 'pending',
    applied_at: '2026-08-28T00:00:00.000Z',
    trust_assessment: null,
    trust_extraction: null,
    ...overrides,
  };
}

function seedWith(p: WorkerProfile) {
  seed = { profile: p, documents: [], posts: [] };
}

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
  phone: message('employer_worker_profile.phone'),
  location: message('employer_worker_profile.location'),
  experience: message('employer_worker_profile.experience'),
  availability: message('employer_worker_profile.availability_label'),
  trade: message('employer_worker_profile.trade'),
  transportation: message('employer_worker_profile.transportation'),
};

describe('employer applicant detail -- the facts card', () => {
  it('renders the six applicant tiles as dt/dd pairs', () => {
    seedWith(profile());
    renderIntl(<EmployerWorkerPage />);

    expect(tile(K.phone).value).toHaveTextContent('+15125550143');
    expect(tile(K.location).value).toHaveTextContent('Austin, TX');
    expect(tile(K.availability).value).toHaveTextContent(
      message('employer_worker_profile.availability.full_time'),
    );
    expect(tile(K.trade).value).toHaveTextContent(message('common.trades.electrician'));
    expect(tile(K.transportation).value).toHaveTextContent(
      message('employer_worker_profile.transportation_yes'),
    );
    // Years AND months, side by side -- both figures were always on the wire.
    expect(tile(K.experience).value).toHaveTextContent('9');
    expect(tile(K.experience).value).toHaveTextContent('112');
  });

  it('is one unlabelled section, so it draws no divider and no h3', () => {
    seedWith(profile());
    renderIntl(<EmployerWorkerPage />);

    const card = factsCard();
    expect(card.querySelectorAll('[data-section]')).toHaveLength(1);
    expect(card.querySelectorAll('[data-divider="true"]')).toHaveLength(0);
    expect(card.querySelectorAll('h3')).toHaveLength(0);
  });

  it('omits the transportation tile when the worker never answered', () => {
    seedWith(profile({ has_transportation: null }));
    renderIntl(<EmployerWorkerPage />);

    expect(
      within(factsCard()).queryByText(K.transportation, { selector: 'dt' }),
    ).not.toBeInTheDocument();
    // The other five stay.
    expect(factsCard().querySelectorAll('dt')).toHaveLength(5);
  });

  it('falls back to the existing unavailable wording on a sparse applicant', () => {
    seedWith(
      profile({
        phone: null,
        location: null,
        city: null,
        availability: null,
        years_experience: null,
        experience_months: null,
        main_trade: null,
        main_trade_other: null,
        has_transportation: null,
      }),
    );
    renderIntl(<EmployerWorkerPage />);

    for (const [label, empty] of [
      [K.phone, message('employer_worker_profile.fallback_phone')],
      [K.location, message('employer_worker_profile.fallback_location')],
      [K.experience, message('employer_worker_profile.fallback_experience')],
      [K.availability, message('employer_worker_profile.fallback_availability')],
      [K.trade, message('common.trades.unspecified')],
    ] as const) {
      const { value } = tile(label);
      expect(value).toHaveTextContent(empty);
      expect(value.className).toContain('text-[var(--jale-ink-2)]');
    }
  });

  it('treats a zero experience figure as an answer, not an absence', () => {
    // `experienceKnown` tests `=== null`, never falsiness. The years go through
    // an ICU plural (`one {# yr exp} other {# yrs exp}`), where 0 takes the
    // `other` branch -- so this also pins that 0 does not fall through to a raw
    // key path.
    seedWith(profile({ years_experience: 0, experience_months: 0 }));
    renderIntl(<EmployerWorkerPage />);

    const { value } = tile(K.experience);
    expect(value).toHaveTextContent('0');
    expect(value).not.toHaveTextContent(message('employer_worker_profile.fallback_experience'));
    expect(value.className).not.toContain('text-[var(--jale-ink-2)]');
    expectNoRawMessageKeys();
  });

  it('keeps the worker name as the panel heading', () => {
    seedWith(profile());
    renderIntl(<EmployerWorkerPage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Marta Reyes' })).toBeInTheDocument();
  });

  it('renders no raw message key, in either locale', () => {
    for (const locale of ['en', 'es'] as const) {
      seedWith(profile());
      const { unmount } = renderIntl(<EmployerWorkerPage />, locale);
      expectNoRawMessageKeys();
      unmount();
    }
  });
});
