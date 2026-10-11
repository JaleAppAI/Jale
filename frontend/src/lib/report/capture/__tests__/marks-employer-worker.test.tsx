// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { WorkerProfile } from '@/lib/api/employer';
import { isMaskedForCapture } from './marks-helpers';

/*
 * The employer's view of a worker: the phone, the answers to the job's own
 * questions and the worker's three profile answers are hidden in a report
 * screenshot. The harness mirrors the page's facts-card suite. All values are
 * fake.
 */

const WORKER_ID = '3f6c2a91-7d4e-4b58-a1c3-9e2f5d7b8a64';
const JOB_ID = 'b4a9f215-6c37-4e80-9d52-1f7a3c8e6b09';

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
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token' }) }));
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
vi.mock('@/app/[locale]/employer/workers/[worker_id]/DocumentSlots', () => ({
    DocumentSlots: () => <div data-document-slots="stub" />,
}));
vi.mock('@/components/media-board/MediaBoardGrid', () => ({ MediaBoardGrid: () => <div /> }));
vi.mock('@/components/media-board/PostLightbox', () => ({ PostLightbox: () => null }));

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
import EmployerWorkerPage from '@/app/[locale]/employer/workers/[worker_id]/page';

function profile(): WorkerProfile {
    return {
        worker_id: WORKER_ID,
        full_name: 'Test Worker',
        phone: '+15555550143',
        skills: ['Conduit bending'],
        availability: 'full_time',
        years_experience: 9,
        experience_months: 112,
        certifications: [],
        location: 'Testville, TX',
        city: 'Testville, TX',
        main_trade: 'electrician',
        main_trade_other: null,
        has_transportation: true,
        application_status: 'pending',
        applied_at: '2026-08-28T00:00:00.000Z',
        trust_assessment: {
            profession_key: 'electrician',
            status: 'pending',
            competency_score: null,
            score_components: null,
            rubric_version: 1,
            answers: [
                { q_en: 'Fake question one?', answer_text: 'Fake trust answer words', answer_source: 'text', answered_at: '2026-08-28T00:00:00.000Z' },
            ],
            scored_at: null,
        },
        trust_extraction: {
            status: 'completed',
            extracted: { skills: [], tools: [], experience_signals: [], safety: [], notable: [] },
            summary_en: 'Fake summary of the answers',
            summary_es: 'Resumen falso',
            extractor_version: 'test',
        },
        prompt_answers: [{ prompt_id: 'p1', question: 'Fake employer question?', text: 'Fake prompt answer words' }],
    } as WorkerProfile;
}

describe('employer view of a worker: capture marks', () => {
    it('hides the phone, the prompt answers, the profile answers and their summary', () => {
        seed = { profile: profile(), documents: [], posts: [] };
        renderIntl(<EmployerWorkerPage />);
        for (const text of ['+15555550143', 'Fake prompt answer words', 'Fake trust answer words', 'Fake summary of the answers']) {
            expect(isMaskedForCapture(screen.getByText(text)), text).toBe(true);
        }
    });

    it('leaves the name and the questions visible', () => {
        seed = { profile: profile(), documents: [], posts: [] };
        renderIntl(<EmployerWorkerPage />);
        expect(isMaskedForCapture(screen.getByText('Fake employer question?'))).toBe(false);
        expect(isMaskedForCapture(screen.getAllByText('Test Worker')[0])).toBe(false);
    });
});
