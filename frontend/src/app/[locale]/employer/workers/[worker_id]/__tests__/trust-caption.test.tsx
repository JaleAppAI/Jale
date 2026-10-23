// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import type { WorkerProfile } from '@/lib/api/employer';

/*
 * One line under the trust score saying where it comes from (sprint 29). The
 * score read as a black box in the employer demo. Copy from the approved E3
 * board, asserted as literals.
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

// The page reads the session-wide inbox for the applicants tutorial; the app
// mounts its provider in the root layout. Stubbed settled and empty here.
const inboxValue = {
  items: [],
  unreadCount: 0,
  unreadByConversation: {},
  loading: false,
  errorKind: null,
  retry: vi.fn(),
  refresh: vi.fn(),
  markRead: vi.fn(),
};
vi.mock('@/contexts/UnreadMessagesContext', () => ({
  useUnreadMessages: () => inboxValue,
  useUnreadCount: () => 0,
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

import { renderIntl } from '@/components/worker/onboarding/__tests__/render-intl';
import EmployerWorkerPage from '../page';

function profile(overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    worker_id: WORKER_ID,
    full_name: 'Test Worker',
    phone: null,
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

const scored: WorkerProfile['trust_assessment'] = {
  profession_key: 'electrician',
  status: 'scored',
  competency_score: 82,
  score_components: { specific_knowledge: 25, practical_experience: 24, safety_awareness: 17, communication_clarity: 16 },
  rubric_version: null,
  answers: [],
  scored_at: '2026-08-29T00:00:00.000Z',
};

describe('trust score caption', () => {
  it('says the score comes from their answers about their work', () => {
    seedWith(profile({ trust_assessment: scored }));
    renderIntl(<EmployerWorkerPage />);
    expect(screen.getByText('The score comes from their answers to questions about their work.')).toBeInTheDocument();
  });

  it('says it in Spanish', () => {
    seedWith(profile({ trust_assessment: scored }));
    renderIntl(<EmployerWorkerPage />, 'es');
    expect(screen.getByText('El puntaje viene de sus respuestas a preguntas sobre su trabajo.')).toBeInTheDocument();
  });

  it('says nothing about a score that is not there', () => {
    seedWith(profile({ trust_assessment: null }));
    renderIntl(<EmployerWorkerPage />);
    expect(screen.queryByText('The score comes from their answers to questions about their work.')).not.toBeInTheDocument();
  });
});

/*
 * One line under the status select saying which statuses reach the worker
 * (sprint 29, A11). Both "Request details" and "Hired" send a message
 * (`employer-application-status-update.ts`), so the line names both.
 */
describe('status select caption', () => {
  const EN = 'Only “Request details” and “Hired” message the worker. The other statuses are just for you.';
  const ES = 'Solo “Solicitar datos” y “Contratado” le envían un mensaje al trabajador. Los demás estados son solo para usted.';

  it('says which statuses message the worker, and describes the select with it', () => {
    seedWith(profile());
    renderIntl(<EmployerWorkerPage />);
    expect(screen.getByText(EN)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAccessibleDescription(expect.stringContaining(EN));
  });

  it('says it in Spanish', () => {
    seedWith(profile());
    renderIntl(<EmployerWorkerPage />, 'es');
    expect(screen.getByText(ES)).toBeInTheDocument();
  });
});
