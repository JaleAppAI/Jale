// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/*
 * The applicants guide (E3) and the messages guide (E4), drawn by the real
 * GuideHost over the real rows, thread and composer, branch by branch
 * (GUIDE-EDGE-CASES Part B). The page-level marks of the job page and the
 * applicant profile are checked over those real pages in their own suites;
 * here their steps are walked over the same marks.
 */

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => '/employer/applicants',
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ idToken: 'test-token', isAuthenticated: true, userType: 'employer' }) }));
vi.mock('@/contexts/ConversationDrawerContext', () => ({ useConversationDrawer: () => ({ openConversation: vi.fn(), openRequest: null }) }));
vi.mock('@/hooks/useRequireAuth', () => ({
    useRequireAuth: () => ({
        handleLegalWall: (err: unknown) => {
            throw err;
        },
    }),
}));

import { Link } from '@/i18n/navigation';
import { ApplicantOverviewRow } from '@/app/[locale]/employer/applicants/ApplicantOverviewRow';
import type { ApplicantOverviewItem, EmployerConversationDetail } from '@/lib/api/employer';
import { ConversationThread } from '@/components/employer/ConversationThread';
import { EmptyThreadComposer } from '@/components/employer/EmptyThreadComposer';
import applicantsGuide from '../employer-applicants';
import messagesGuide from '../employer-messages';
import { counter, currentStep, fakeLayout, flush, message, press, reach, renderWithGuide } from './guide-kit';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    fakeLayout();
    document.body.style.overflow = '';
});
afterEach(() => vi.restoreAllMocks());

/** Walks the guide with Next from its first step, and returns the steps it showed. */
async function walk(first: string): Promise<string[]> {
    await reach('intro');
    await press('start');
    await reach(first);
    return nextToTheEnd();
}

/** Presses Next from the step on screen until the guide ends (or stops moving); returns the steps shown. */
async function nextToTheEnd(): Promise<string[]> {
    const seen: string[] = [];
    for (let turn = 0; turn < 20 && currentStep() !== null; turn += 1) {
        const at = currentStep() as string;
        seen.push(at);
        await press('next');
        // Generous for a loaded run: the next step (or the end) can take a few turns.
        const until = Date.now() + 5000;
        while (currentStep() === at && Date.now() < until) await flush(10);
        if (currentStep() === at) break;
    }
    return seen;
}

/** The cutout lets the pointer through to the control (an interactive step), or blocks it. */
const pressable = () => document.querySelector('[data-spotlight-blocker="hole"]') === null;

/** Walks to `id` with Next and reports whether its control can be pressed. */
async function pressableAt(first: string, id: string): Promise<boolean> {
    await reach('intro');
    await press('start');
    await reach(first);
    while (currentStep() !== id) {
        const at = currentStep();
        await press('next');
        const until = Date.now() + 5000;
        while (currentStep() === at && Date.now() < until) await flush(10);
        if (currentStep() === at || currentStep() === null) throw new Error(`never reached ${id}`);
    }
    return pressable();
}

const row: ApplicantOverviewItem = {
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: 'Maria Garcia',
    job_id: 'j-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_status: 'active',
    application_status: 'pending',
    applied_at: '2026-08-30T00:00:00Z',
    skills: ['grill'],
    availability: 'full_time',
    years_experience: 4,
    match_score: 72,
    score_band: 'strong',
    trust_score: 78,
    hire_details: null,
    hire_details_needed: false,
};

function Board({ items, jobs = 1 }: { items: ApplicantOverviewItem[]; jobs?: number }) {
    return (
        <main>
            {jobs > 1 ? (
                <div data-guide="apps.board_jobs">
                    <button type="button">All jobs</button>
                </div>
            ) : null}
            <div data-guide="apps.board">
                {items.map((item) => (
                    <ApplicantOverviewRow key={item.application_id} item={item} />
                ))}
            </div>
        </main>
    );
}

describe('the applicants guide on the board', () => {
    it('shows the rows, the status that saves on the pick, and Message; never Request details', async () => {
        renderWithGuide(<Board items={[row]} />, { id: 'employer_applicants' });
        const seen = await walk('board_row');
        expect(seen).toEqual(['board_row', 'board_status', 'board_message']);
        expect(message('tutorial.employer_applicants.guide.steps.board_status.body')).toContain(message('employer_dashboard.applicants.status.hired'));
    });

    it('adds the job chips when there are several jobs', async () => {
        renderWithGuide(<Board items={[row]} jobs={2} />, { id: 'employer_applicants' });
        const seen = await walk('board_row');
        expect(seen).toEqual(['board_row', 'board_jobs', 'board_status', 'board_message']);
    });

    it('says why Hired is greyed out when the details are not complete', async () => {
        renderWithGuide(<Board items={[{ ...row, details_status: 'not_requested' } as ApplicantOverviewItem]} />, { id: 'employer_applicants' });
        const seen = await walk('board_row');
        expect(seen).toEqual(['board_row', 'board_status', 'board_hire_blocked', 'board_message']);
    });

    it('shows Message without letting it be pressed (the drawer it opens is under the guide); the status stays pressable', async () => {
        renderWithGuide(<Board items={[row]} />, { id: 'employer_applicants' });
        await reach('intro');
        await press('start');
        await reach('board_row');
        await press('next');
        await reach('board_status');
        expect(pressable()).toBe(true);
        await press('next');
        await reach('board_message');
        expect(pressable()).toBe(false);
    });

    it('ends on the board after Message, with no other page’s steps waited for', async () => {
        const view = renderWithGuide(<Board items={[row]} />, { id: 'employer_applicants' });
        await walk('board_row');
        expect(currentStep()).toBeNull();
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
    });

    it('points at start details only on a Hired row', async () => {
        renderWithGuide(<Board items={[{ ...row, application_status: 'hired' }]} />, { id: 'employer_applicants' });
        const seen = await walk('board_row');
        expect(seen).toEqual(['board_row', 'board_status', 'board_start', 'board_message']);
    });
});

/** The job page's applicants panel, as its marks lay it out. */
function JobPanel({ request = true, filteredEmpty = false }: { request?: boolean; filteredEmpty?: boolean }) {
    return (
        <section data-guide="apps.job_panel">
            <div data-guide="apps.filters">
                <label>
                    Status
                    <select defaultValue="">
                        <option value="">All</option>
                    </select>
                </label>
            </div>
            {filteredEmpty ? (
                <div data-guide="apps.filtered_empty">
                    <button type="button">Clear filters</button>
                </div>
            ) : (
                <ul>
                    <li data-guide="apps.job_row">
                        {request ? (
                            <button type="button" data-guide="apps.request">
                                Request details
                            </button>
                        ) : null}
                        <Link href="/employer/workers/w-1?job_id=j-1" data-guide="apps.job_profile">
                            View profile
                        </Link>
                        <button type="button" data-guide="apps.job_message">
                            Message Worker
                        </button>
                    </li>
                </ul>
            )}
        </section>
    );
}

describe('the applicants guide on a job’s page', () => {
    it('shows the filters, one applicant, Request details, Message Worker and View profile; no status step', async () => {
        renderWithGuide(<JobPanel />, { id: 'employer_applicants' });
        const seen = await walk('job_filters');
        expect(seen).toEqual(['job_filters', 'job_row', 'job_request', 'job_message', 'job_profile']);
    });

    it('counts this page’s steps only, and ends here: the profile’s steps are not waited for', async () => {
        const view = renderWithGuide(<JobPanel />, { id: 'employer_applicants' });
        await reach('intro');
        await press('start');
        await reach('job_filters');
        expect(counter()).toMatch(/1 of 5$/);
        expect(await nextToTheEnd()).toHaveLength(5);
        expect(currentStep()).toBeNull();
        expect(view.onDismiss).toHaveBeenCalledWith('completed');
    });

    it('shows Message Worker and View profile without letting them be pressed (both leave the page)', async () => {
        renderWithGuide(<JobPanel />, { id: 'employer_applicants' });
        expect(await pressableAt('job_filters', 'job_request')).toBe(true);
        await press('next');
        await reach('job_message');
        expect(pressable()).toBe(false);
        await press('next');
        await reach('job_profile');
        expect(pressable()).toBe(false);
    });

    it('leaves out Request details for someone hired, not selected or complete (no button)', async () => {
        renderWithGuide(<JobPanel request={false} />, { id: 'employer_applicants' });
        const seen = await walk('job_filters');
        expect(seen).toEqual(['job_filters', 'job_row', 'job_message', 'job_profile']);
    });

    it('points at Clear filters when the filters hide everyone, and waits for it', async () => {
        renderWithGuide(<JobPanel filteredEmpty />, { id: 'employer_applicants' });
        await reach('intro');
        await press('start');
        await reach('job_filters');
        await press('next');
        await reach('job_filtered_empty');
        expect(document.querySelector('[data-spotlight-action="next"]')).toBeDisabled();
    });
});

function ProfilePanel({ status = 'pending', hint = false, request = true }: { status?: string; hint?: boolean; request?: boolean }) {
    return (
        <main>
            <section data-guide="apps.profile_docs">Documents</section>
            <div data-guide="apps.profile_status" data-status={status}>
                <select aria-label="Application Status" defaultValue={status}>
                    <option value={status}>{status}</option>
                </select>
                {hint ? <p data-guide="apps.profile_hint">To mark as hired, request their details first.</p> : null}
                <button type="button">Save</button>
                {request ? (
                    <button type="button" data-guide="apps.profile_request">
                        Request details
                    </button>
                ) : null}
            </div>
        </main>
    );
}

describe('the applicants guide on the applicant profile', () => {
    it('shows the status with Save, Request details and the documents', async () => {
        renderWithGuide(<ProfilePanel />, { id: 'employer_applicants' });
        const seen = await walk('profile_status');
        expect(seen).toEqual(['profile_status', 'profile_request', 'profile_docs']);
    });

    it('says why Hired is greyed out', async () => {
        renderWithGuide(<ProfilePanel hint />, { id: 'employer_applicants' });
        const seen = await walk('profile_status');
        expect(seen).toEqual(['profile_status', 'profile_hire_blocked', 'profile_request', 'profile_docs']);
    });

    it('sends a hire to the Applicants page for start details', async () => {
        renderWithGuide(<ProfilePanel status="hired" request={false} />, { id: 'employer_applicants' });
        const seen = await walk('profile_status');
        expect(seen).toEqual(['profile_status', 'profile_docs', 'profile_hired']);
        expect(message('tutorial.employer_applicants.guide.steps.profile_hired.body')).toContain(message('employer_applicants.hire_details.add'));
    });
});

describe('the applicants guide’s copy', () => {
    it.each(['en', 'es'] as const)('names each surface’s own labels in %s', (locale) => {
        const step = (id: string) => message(`tutorial.employer_applicants.guide.steps.${id}.body`, locale);
        expect(step('board_row')).toContain(message('employer_dashboard.applicants.view_profile', locale));
        expect(step('board_message')).toContain(message('employer_applicants.message_action', locale));
        expect(step('board_start')).toContain(message('employer_applicants.hire_details.add', locale));
        expect(step('job_request')).toContain(message('employer_job_listing.applicants.request_details', locale));
        expect(step('job_request')).toContain(message('employer_job_listing.applicants.request_details_resend', locale));
        expect(step('job_message')).toContain(message('employer_messages.message_worker', locale));
        expect(step('job_profile')).toContain(message('employer_job_listing.applicants.view_profile', locale));
        expect(step('job_filters')).toContain(message('employer_job_listing.filters.clear', locale));
        expect(step('profile_status')).toContain(message('employer_worker_profile.save_status', locale));
        expect(step('profile_docs')).toContain(message('employer_worker_profile.share_upload_link', locale));
    });

    it('puts every step on one surface only', () => {
        const ids = applicantsGuide.steps.map((s) => s.id);
        expect(ids.filter((id) => id.startsWith('board_'))).toHaveLength(7);
        expect(ids.filter((id) => id.startsWith('job_'))).toHaveLength(6);
        expect(ids.filter((id) => id.startsWith('profile_'))).toHaveLength(5);
    });
});

const conversation: EmployerConversationDetail = {
    id: 'c-1',
    job_id: 'j-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_state_region: 'TX',
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: 'Maria Garcia',
    status: 'open',
    last_message_at: null,
    last_worker_message_at: null,
    last_message_preview: null,
    updated_at: '2026-09-01T00:00:00Z',
};

const messages = [
    { id: 'm1', sender_type: 'employer', body: 'Can you start Monday?', status: 'waiting_worker_reply', created_at: '2026-09-01T00:00:00Z' },
] as never;

describe('the messages guide', () => {
    it('on the Conversations page, a new applicant: the first message, the delivery rule, writing, Send and Not interested', async () => {
        renderWithGuide(
            <main>
                <p data-guide="msg.caption">{message('employer_messages.whatsapp_window_caption')}</p>
                <EmptyThreadComposer item={{ worker_name: 'Maria Garcia', job_title: 'Line Cook', job_city: 'Austin', applied_at: '2026-08-30T00:00:00Z' }} onSend={vi.fn()} onDismiss={vi.fn()} />
            </main>,
            { id: 'employer_messages' },
        );
        const seen = await walk('first');
        expect(seen).toEqual(['first', 'window', 'write', 'send', 'not_interested']);
    });

    it('in an open thread: the conversation, writing, Send and Close', async () => {
        renderWithGuide(<ConversationThread conversation={conversation} messages={messages} onSend={vi.fn()} onClose={vi.fn()} />, { id: 'employer_messages' });
        await reach('intro');
        await press('start');
        await reach('thread');
        expect(counter()).toMatch(/1 of 4$/);
        const seen = [currentStep()];
        for (const id of ['write', 'send', 'close']) {
            await press('next');
            await reach(id);
            seen.push(currentStep());
        }
        expect(seen).toEqual(['thread', 'write', 'send', 'close']);
    });

    it('in a closed thread: says it is closed and can’t be reopened, with no writing steps', async () => {
        renderWithGuide(<ConversationThread conversation={{ ...conversation, status: 'closed' }} messages={messages} onSend={vi.fn()} />, { id: 'employer_messages' });
        const seen = await walk('thread');
        expect(seen).toEqual(['thread', 'closed']);
    });

    it('in the drawer from its launcher: the list, then putting it away; the page’s caption is left out', async () => {
        renderWithGuide(
            <main>
                <p data-guide="msg.caption">{message('employer_messages.whatsapp_window_caption')}</p>
                <button type="button" data-guide="msg.launcher">
                    Close
                </button>
                <div data-guide="msg.drawer">
                    <aside data-guide="msg.list">No open conversations yet.</aside>
                </div>
            </main>,
            { id: 'employer_messages' },
        );
        const seen = await walk('list');
        expect(seen).toEqual(['list', 'put_away']);
    });

    it('points the list step at the first conversation in the drawer, or at the list when it is empty', () => {
        const list = messagesGuide.steps.find((step) => step.id === 'list');
        const resolve = () => (list?.target as () => HTMLElement | null)();
        const view = render(
            <div data-guide="msg.drawer">
                <aside data-guide="msg.list">
                    <ul>
                        <li data-testid="first">Test Worker Two</li>
                        <li>Test Worker Three</li>
                    </ul>
                </aside>
            </div>,
        );
        expect(resolve()).toBe(screen.getByTestId('first'));
        view.unmount();
        render(
            <div data-guide="msg.drawer">
                <aside data-guide="msg.list" data-testid="list">
                    No open conversations yet.
                </aside>
            </div>,
        );
        expect(resolve()).toBe(screen.getByTestId('list'));
    });

    it('points the thread step at the newest message, not the whole transcript', () => {
        const thread = messagesGuide.steps.find((step) => step.id === 'thread');
        renderWithGuide(
            <ConversationThread
                conversation={conversation}
                messages={[
                    { id: 'm1', sender_type: 'employer', body: 'Can you start Monday?', status: 'delivered', created_at: '2026-09-01T00:00:00Z' },
                    { id: 'm2', sender_type: 'worker', body: 'Yes, I can.', status: 'received', created_at: '2026-09-01T01:00:00Z' },
                ] as never}
                onSend={vi.fn()}
            />,
            { id: 'employer_messages' },
        );
        const target = (thread?.target as () => HTMLElement | null)();
        expect(target?.textContent).toContain('Yes, I can.');
        expect(target?.textContent).not.toContain('Can you start Monday?');
    });

    it('shows the drawer’s Close without letting it be pressed: putting the drawer away would end the guide’s page', async () => {
        renderWithGuide(
            <main>
                <button type="button" data-guide="msg.launcher">
                    Close
                </button>
                <div data-guide="msg.drawer">
                    <aside data-guide="msg.list">No open conversations yet.</aside>
                </div>
            </main>,
            { id: 'employer_messages' },
        );
        expect(await pressableAt('list', 'put_away')).toBe(false);
    });

    it('keeps Send, Not interested and Close pressable in a thread (they stay on the page or ask first)', async () => {
        renderWithGuide(
            <ConversationThread conversation={conversation} messages={messages} onSend={vi.fn()} onClose={vi.fn()} onDismiss={vi.fn()} />,
            { id: 'employer_messages' },
        );
        expect(await pressableAt('thread', 'send')).toBe(true);
        await press('next');
        await reach('not_interested');
        expect(pressable()).toBe(true);
        await press('next');
        await reach('close');
        expect(pressable()).toBe(true);
    });

    it('names the real labels, and only the static delivery rule', () => {
        for (const locale of ['en', 'es'] as const) {
            const step = (id: string) => message(`tutorial.employer_messages.guide.steps.${id}.body`, locale);
            expect(step('send')).toContain(message('employer_messages.send', locale));
            expect(step('not_interested')).toContain(message('employer_messages.not_interested', locale));
            expect(step('close')).toContain(message('employer_messages.close', locale));
            expect(step('thread')).toContain(message('employer_messages.message_status.waiting_worker_reply', locale));
            expect(step('window')).toBe(message('employer_messages.whatsapp_window_caption', locale));
        }
        expect(messagesGuide.steps.map((s) => s.id)).toEqual(['list', 'first', 'thread', 'window', 'write', 'send', 'closed', 'not_interested', 'close', 'put_away']);
    });
});
