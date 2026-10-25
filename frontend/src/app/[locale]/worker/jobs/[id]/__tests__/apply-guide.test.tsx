// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { JobDetail } from '@/lib/api/worker';
import { ApiError } from '@/lib/api/errors';
import { markWorkerTourDue } from '@/lib/tutorials/tour-marker';
import { accountKeyFromIdToken } from '@/lib/account-key';
import { auth, resetHarness, route, serveTutorials, signIn, watchDialogs } from '@/lib/tutorials/__tests__/harness';
import { recordsPosted, settle, workerProviders } from '@/components/tutorials/content/__tests__/worker-player';
import { WorkerTourGate } from '@/components/tutorials/WorkerTourGate';

/*
 * W2's step-by-step guide over the REAL job page, the REAL profile gate, the
 * REAL apply screen and the real progress store and guide host: it plays
 * where applying starts (the gate for an incomplete profile, carrying on
 * through "Save and apply" into the apply screen; otherwise the apply screen
 * as it opens), on every way in (Apply, an `?apply=1` arrival), and walks the
 * branches: the gate's fields, a failed or cancelled gate, questions or none,
 * the 1 to 1000 character rule, "documents come later", Send, applied, a
 * failed send, a job that closed meanwhile, and "Back to the job" before
 * sending. After an `?apply=1` arrival the app tour waits for the guide and
 * never overlaps it.
 */

const { worker, profile } = vi.hoisted(() => ({
    worker: { applyToJob: vi.fn(), getApplications: vi.fn() },
    profile: { current: {} as Record<string, unknown> },
}));

vi.mock('@/contexts/AuthContext', async () => ({
    useAuth: (await import('@/lib/tutorials/__tests__/harness')).useAuthMock,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'job-1', locale: 'en' }) }));
vi.mock('@/i18n/navigation', async () => ({
    usePathname: (await import('@/lib/tutorials/__tests__/harness')).usePathnameMock,
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>{children}</a>
    ),
    useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({ handleLegalWall: (err: unknown) => { throw err; } }),
}));
// The shell: what the tour gate looks for (Help and a nav link), around the page.
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({ children }: { children: ReactNode }) => (
        <div>
            <button type="button" data-tour="help">Help</button>
            <span data-nav-key="find_jobs">Jobs</span>
            {children}
        </div>
    ),
}));
vi.mock('@/components/PayReferenceHint', () => ({ PayReferenceHint: () => null }));
vi.mock('@/components/worker/ShareJobPanel', () => ({ ShareJobPanel: () => null }));
vi.mock('@/lib/api', async (importOriginal) => {
    const harness = await import('@/lib/tutorials/__tests__/harness');
    return {
        ...(await importOriginal<typeof import('@/lib/api')>()),
        apiFetch: (path: string, init?: RequestInit, token?: string) =>
            path === '/worker/profile'
                ? Promise.resolve(harness.jsonResponse(200, profile.current))
                : harness.apiFetch(path, init, token),
    };
});
vi.mock('@/lib/api/worker', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/worker')>()),
    getJob: vi.fn(),
    applyToJob: (...args: unknown[]) => worker.applyToJob(...args),
    updateWorkerProfile: vi.fn(async () => ({})),
    getVaultDocuments: vi.fn(async () => ({ documents: [] })),
    recordJobView: vi.fn(),
    getApplications: (...args: unknown[]) => worker.getApplications(...args),
}));

/** The page's data: a real state, so the page's own local updates (applied) show. */
const page = { seed: null as unknown as JobDetail, afterRefresh: null as Partial<JobDetail> | null };
vi.mock('@/hooks/usePageData', async () => {
    const React = await import('react');
    return {
        usePageData: () => {
            const [data, setData] = React.useState<JobDetail>(page.seed);
            return {
                phase: 'ready' as const,
                data,
                errorKind: null,
                refreshing: false,
                refreshError: false,
                retry: vi.fn(),
                refresh: async () => {
                    const next = page.afterRefresh;
                    if (next) setData((current) => ({ ...current, ...next }));
                },
                setData,
            };
        },
    };
});

import { updateWorkerProfile } from '@/lib/api/worker';
import WorkerJobDetailPage from '../page';

const COMPLETE_PROFILE = { full_name: 'Test Worker', skills: ['framing'], availability: 'full_time', location: 'San Antonio, TX' };
/** What the gate opens for: no skills, no availability, no location (the name is there). */
const INCOMPLETE_PROFILE = { full_name: 'Test Worker', skills: [], availability: null, location: null, years_experience: null };

function job(over: Partial<JobDetail> = {}): JobDetail {
    return {
        id: 'job-1',
        title: 'Concrete Finisher',
        location: 'San Antonio, TX',
        job_type: 'full-time',
        company_name: 'NB Construction',
        required_docs: [],
        missing_docs: [],
        created_at: '2026-06-01T15:00:00.000Z',
        description: null,
        status: 'active',
        already_applied: false,
        application_status: null,
        pre_application_prompts: [],
        ...over,
    } as JobDetail;
}

const TWO_QUESTIONS = [
    { id: 'p1', text: 'What concrete work have you done?' },
    { id: 'p2', text: 'When can you start?' },
];

function visit(search: string) {
    window.history.replaceState(null, '', `/en/worker/jobs/job-1${search}`);
}

function callout(): HTMLElement | null {
    const layer = document.querySelector('[data-spotlight="worker_apply"]');
    const dialogs = layer ? Array.from(layer.querySelectorAll<HTMLElement>('[role="dialog"]')) : [];
    return dialogs.at(-1) ?? null;
}

async function expectStep(id: string) {
    await vi.waitFor(() => expect(callout()?.getAttribute('data-step')).toBe(id), { timeout: 3000 });
}

function guideButton(name: string): HTMLElement {
    return within(callout()!).getByRole('button', { name });
}

function guided(name: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-guide="${name}"]`);
    if (!element) throw new Error(`no [data-guide="${name}"]`);
    return element;
}

async function openAndStart(locale: 'en' | 'es' = 'en') {
    render(<WorkerJobDetailPage />, { wrapper: workerProviders(locale) });
    await settle();
    const apply = locale === 'en' ? en.worker_job_detail.apply : es.worker_job_detail.apply;
    fireEvent.click(screen.getByRole('button', { name: apply }));
    await startGuide(locale);
}

async function startGuide(locale: 'en' | 'es' = 'en') {
    const catalogue = locale === 'en' ? en : es;
    const intro = await screen.findByRole('dialog', { name: catalogue.tutorial.worker_apply.guide.intro_title });
    act(() => within(intro).getByRole('button', { name: catalogue.tutorial.common.guide.worker.start }).click());
}

let rects: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
    rects = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
    await import('@/components/tutorials/GuideHost');
    await import('@/components/tutorials/TutorialHost');
    await import('@/components/tutorials/AppTourHost');
});
afterAll(() => rects.mockRestore());

beforeEach(() => {
    vi.clearAllMocks();
    resetHarness();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    route.path = '/worker/jobs/job-1';
    signIn('worker');
    serveTutorials([]);
    profile.current = COMPLETE_PROFILE;
    page.seed = job();
    page.afterRefresh = null;
    worker.getApplications.mockResolvedValue({ applications: [], next_cursor: null, attention: { details_requested: [], unacknowledged_hires: [] } });
    worker.applyToJob.mockResolvedValue({ status: 'pending' });
    visit('');
});

describe('W2 guide: applying, inside the apply screen', () => {
    it('opens nothing over the job page; the guide opens with the apply screen, alone', async () => {
        const watch = watchDialogs();
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: en.worker_job_detail.apply }));
        await startGuide();
        await expectStep('no_questions');
        watch.stop();
        expect(watch.most()).toBe(1);
    });

    it('walks a job with no questions: nothing to answer, documents later, Send, applied', async () => {
        await openAndStart();
        await expectStep('no_questions');
        // "You applied!" is counted from the start: the total never ends on Send.
        expect(callout()).toHaveTextContent('Applying · 1 of 4');
        act(() => guideButton('Next').click());
        await expectStep('later');
        act(() => guideButton('Next').click());
        await expectStep('send');
        expect(callout()).toHaveTextContent('Applying · 3 of 4');
        act(() => guided('apply.send').click());

        await expectStep('sent');
        expect(callout()).toHaveTextContent('Applying · 4 of 4');
        expect(guided('apply.applied')).toHaveTextContent(en.worker_job_detail.already_applied);
        act(() => guideButton('Got it').click());
        await settle();
        expect(callout()).toBeNull();
        expect(recordsPosted()).toEqual([{ tutorial_id: 'worker_apply', outcome: 'completed' }]);
    });

    it('walks each employer question, needing 1 to 1000 characters', async () => {
        page.seed = job({ pre_application_prompts: TWO_QUESTIONS });
        await openAndStart();

        await expectStep('answer_1');
        const first = within(guided('apply.answer.1')).getByRole('textbox');
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(first, { target: { value: '   ' } });
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(first, { target: { value: 'x'.repeat(1001) } });
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(first, { target: { value: 'Driveways and slabs.' } });
        act(() => guideButton('Next').click());

        await expectStep('answer_2');
        expect(within(callout()!).getByText(en.tutorial.worker_apply.guide.steps.answer_more.title)).toBeInTheDocument();
        fireEvent.change(within(guided('apply.answer.2')).getByRole('textbox'), { target: { value: 'Monday' } });
        act(() => guideButton('Next').click());
        await expectStep('later');
        act(() => guideButton('Next').click());
        await expectStep('send');
        expect(guided('apply.send')).toBeEnabled();
        act(() => guided('apply.send').click());
        await expectStep('sent');
        expect(worker.applyToJob).toHaveBeenCalledWith(expect.any(String), 'job-1', { p1: 'Driveways and slabs.', p2: 'Monday' });
    });

    it('walks the profile gate, then "Save and apply", then the apply screen through Send', async () => {
        profile.current = INCOMPLETE_PROFILE;
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();
        fireEvent.click(screen.getByRole('button', { name: en.worker_job_detail.apply }));
        await startGuide();

        // The name is there, so the gate starts at the skills; the screen's steps are counted ahead.
        await expectStep('gate_skills');
        expect(callout()).toHaveTextContent('Applying · 1 of 10');
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(guided('apply.gate.skills'), { target: { value: ' , ' } });
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(guided('apply.gate.skills'), { target: { value: 'framing, drywall' } });
        act(() => guideButton('Next').click());

        // An unset availability starts empty and holds the step until one is picked.
        await expectStep('gate_availability');
        expect((guided('apply.gate.availability') as HTMLSelectElement).value).toBe('');
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(guided('apply.gate.availability'), { target: { value: 'weekends' } });
        act(() => guideButton('Next').click());

        await expectStep('gate_location');
        expect(guideButton('Next')).toBeDisabled();
        fireEvent.change(guided('apply.gate.location'), { target: { value: 'San Antonio, TX' } });
        act(() => guideButton('Next').click());

        await expectStep('gate_years');
        expect(guideButton('Next')).toBeEnabled();
        act(() => guideButton('Next').click());

        await expectStep('gate_save');
        expect(within(callout()!).getByText(/you send it on the next screen/)).toBeInTheDocument();
        await act(async () => { guided('apply.gate.save').click(); });

        // Saved, not applied: the screen says so, and Send is still to come.
        await expectStep('from_gate');
        expect(updateWorkerProfile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            skills: ['framing', 'drywall'], availability: 'weekends', location: 'San Antonio, TX',
        }));
        expect(vi.mocked(updateWorkerProfile).mock.calls[0][1]).not.toHaveProperty('years_experience');
        expect(within(callout()!).getByText(/Send application to apply/)).toBeInTheDocument();
        expect(worker.applyToJob).not.toHaveBeenCalled();
        act(() => guideButton('Next').click());
        await expectStep('no_questions');
        act(() => guideButton('Next').click());
        await expectStep('later');
        act(() => guideButton('Next').click());
        await expectStep('send');
        act(() => guided('apply.send').click());
        await expectStep('sent');
        expect(callout()).toHaveTextContent('Applying · 10 of 10');
        expect(worker.applyToJob).toHaveBeenCalledTimes(1);
    });

    it('keeps the Save and apply step up when the profile save fails, with the gate and its error', async () => {
        // Only the name is missing, so the gate opens on it and the rest is already filled in.
        profile.current = { full_name: '', skills: ['framing'], availability: 'part_time', location: 'Austin, TX', years_experience: null };
        vi.mocked(updateWorkerProfile).mockRejectedValueOnce(new ApiError(500, 'internal'));
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();
        fireEvent.click(screen.getByRole('button', { name: en.worker_job_detail.apply }));
        await startGuide();
        await expectStep('gate_name');
        fireEvent.change(guided('apply.gate.name'), { target: { value: 'Ana Ruiz' } });
        act(() => guideButton('Next').click());
        for (const step of ['gate_skills', 'gate_availability', 'gate_location', 'gate_years']) {
            await expectStep(step);
            act(() => guideButton('Next').click());
        }
        await expectStep('gate_save');
        await act(async () => { guided('apply.gate.save').click(); });
        await settle();
        expect(updateWorkerProfile).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-guide="apply.gate"]')).not.toBeNull();
        expect(callout()?.getAttribute('data-step')).toBe('gate_save');
        expect(document.querySelector('[data-guide="apply.screen"]')).toBeNull();
    });

    it('ends when the gate is closed without saving, with no step left over', async () => {
        profile.current = INCOMPLETE_PROFILE;
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await settle();
        fireEvent.click(screen.getByRole('button', { name: en.worker_job_detail.apply }));
        await startGuide();
        await expectStep('gate_skills');
        act(() => screen.getByRole('button', { name: en.worker_profile.complete_modal.cancel }).click());

        await vi.waitFor(() => expect(callout()).toBeNull(), { timeout: 3000 });
        await settle();
        expect(callout()).toBeNull();
        expect(updateWorkerProfile).not.toHaveBeenCalled();
        expect(worker.applyToJob).not.toHaveBeenCalled();
    });

    it('keeps the Send step up when the send fails, with the screen and its error', async () => {
        worker.applyToJob.mockRejectedValueOnce(new ApiError(500, 'internal'));
        await openAndStart();
        await expectStep('no_questions');
        act(() => guideButton('Next').click());
        act(() => guideButton('Next').click());
        await expectStep('send');
        await act(async () => { guided('apply.send').click(); });
        await settle();
        expect(callout()?.getAttribute('data-step')).toBe('send');
        expect(screen.getByText(en.worker_job_detail.errors.server_error)).toBeInTheDocument();
    });

    it('says the job closed when it closes while the worker is applying', async () => {
        worker.applyToJob.mockRejectedValueOnce(new ApiError(410, 'job_closed'));
        page.afterRefresh = { status: 'closed' };
        await openAndStart();
        await expectStep('no_questions');
        act(() => guideButton('Next').click());
        act(() => guideButton('Next').click());
        await expectStep('send');
        await act(async () => { guided('apply.send').click(); });

        await expectStep('closed');
        expect(guided('apply.closed')).toHaveTextContent(en.worker_job_detail.errors.job_closed);
    });

    it('points back at the application after "Back to the job", with what was typed kept', async () => {
        page.seed = job({ pre_application_prompts: TWO_QUESTIONS });
        await openAndStart();
        await expectStep('answer_1');
        fireEvent.change(within(guided('apply.answer.1')).getByRole('textbox'), { target: { value: 'Driveways.' } });
        // The screen's own way back.
        act(() => screen.getByRole('button', { name: en.worker_job_detail.apply_flow.back_to_details }).click());

        await expectStep('left');
        expect(guided('apply.button')).toHaveTextContent(en.worker_job_detail.apply_flow.continue_button);
    });

    it('speaks Spanish with tú', async () => {
        await openAndStart('es');
        await expectStep('no_questions');
        expect(within(callout()!).getByText(es.tutorial.worker_apply.guide.steps.no_questions.body)).toBeInTheDocument();
        expect(es.tutorial.worker_apply.guide.steps.send.body).toMatch(/Toca/);
    });
});

describe('W2 guide: ?apply=1 after onboarding, and the app tour', () => {
    it('starts at the gate when the arrival finds the profile incomplete', async () => {
        profile.current = INCOMPLETE_PROFILE;
        visit('?apply=1');
        render(<WorkerJobDetailPage />, { wrapper: workerProviders() });
        await startGuide();
        await expectStep('gate_skills');
        expect(document.querySelector('[data-guide="apply.gate"]')).not.toBeNull();
    });

    it('plays the guide inside the flow the arrival opens, and the tour only after it, never both', async () => {
        markWorkerTourDue(accountKeyFromIdToken(auth.state.idToken));
        visit('?apply=1');
        const watch = watchDialogs();
        render(<><WorkerJobDetailPage /><WorkerTourGate /></>, { wrapper: workerProviders() });

        await startGuide();
        await expectStep('no_questions');
        expect(document.querySelector('[data-spotlight="worker_app_tour"]')).toBeNull();

        act(() => guideButton('End guide').click());
        await settle();
        // Still on the apply screen: the flow counts as an overlay, so the tour waits.
        expect(document.querySelector('[data-guide="apply.screen"]')).not.toBeNull();
        await settle();
        expect(document.querySelector('[data-spotlight="worker_app_tour"]')).toBeNull();

        act(() => screen.getByRole('button', { name: en.worker_job_detail.apply_flow.back_to_details }).click());
        await vi.waitFor(() => expect(document.querySelector('[data-spotlight="worker_app_tour"]')).not.toBeNull(), { timeout: 3000 });
        watch.stop();
        expect(watch.most()).toBe(1);
    });
});
