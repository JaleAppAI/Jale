// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

/*
 * The employer guides over the page's own dialogs: a step whose control opens
 * a dialog stays pressable, the guide steps aside while that dialog is up
 * (nothing drawn, the dialog's keys), and picks up the same step when it
 * closes, with the page's scroll lock back as it was. Over the real board row
 * (Hired asks first; Add Start Details), the real thread (Close asks first)
 * and a Not interested confirm like the Conversations page's.
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
const updateApplicantStatus = vi.fn();
const updateHireDetails = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/api/employer')>()),
    updateApplicantStatus: (...args: unknown[]) => updateApplicantStatus(...args),
    updateHireDetails: (...args: unknown[]) => updateHireDetails(...args),
}));

import { ApplicantOverviewRow } from '@/app/[locale]/employer/applicants/ApplicantOverviewRow';
import type { ApplicantOverviewItem, EmployerConversationDetail } from '@/lib/api/employer';
import { ConversationThread } from '@/components/employer/ConversationThread';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { currentStep, fakeLayout, flush, mark, message, press, reach, renderWithGuide } from './guide-kit';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    fakeLayout();
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    updateApplicantStatus.mockReset();
    updateHireDetails.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const locks = () => ({ body: document.body.style.overflow, page: document.documentElement.style.overflow });
const named = (text: string, name: string) => text.replace('{name}', name);
const click = (name: string) =>
    act(() => {
        fireEvent.click(screen.getByRole('button', { name }));
    });

/** Walks Next from the intro to `id`. */
async function walkTo(first: string, id: string) {
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
}

const NAME = 'Maria Garcia';
const row: ApplicantOverviewItem = {
    application_id: 'app-1',
    worker_id: 'w-1',
    worker_name: NAME,
    job_id: 'j-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_status: 'active',
    application_status: 'contacted',
    applied_at: '2026-08-30T00:00:00Z',
    skills: ['grill'],
    availability: 'full_time',
    years_experience: 4,
    match_score: 72,
    score_band: 'strong',
    trust_score: 78,
    hire_details: null,
    hire_details_needed: false,
    details_status: 'complete',
} as ApplicantOverviewItem;

function Board({ item }: { item: ApplicantOverviewItem }) {
    return (
        <main data-guide="apps.board">
            <ApplicantOverviewRow item={item} />
        </main>
    );
}

function pickHired() {
    const select = mark('apps.row_status')?.querySelector('select') as HTMLSelectElement;
    act(() => {
        fireEvent.change(select, { target: { value: 'hired' } });
    });
}

describe('the applicants guide over the board’s own dialogs', () => {
    it('Hired asks first: the guide steps aside, and Cancel or Confirm picks up the status step again', async () => {
        updateApplicantStatus.mockResolvedValue({ application_id: 'app-1', status: 'hired' });
        renderWithGuide(<Board item={row} />, { id: 'employer_applicants' });
        await walkTo('board_row', 'board_status');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        pickHired();
        await flush();
        const title = named(message('employer_applicants.hire_confirm.title'), NAME);
        expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
        // Nothing of the guide is drawn while the confirm is up, and the dialog holds the page.
        expect(currentStep()).toBeNull();
        expect(locks()).toEqual({ body: 'hidden', page: '' });

        click(message('employer_applicants.hire_confirm.cancel'));
        await reach('board_status');
        expect(updateApplicantStatus).not.toHaveBeenCalled();
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        pickHired();
        await flush();
        click(message('employer_applicants.hire_confirm.confirm'));
        await reach('board_status');
        expect(updateApplicantStatus).toHaveBeenCalledWith('test-token', 'j-1', 'w-1', 'hired');
        expect(locks()).toEqual({ body: '', page: 'hidden' });

        // Now hired: the row has Add Start Details, and the guide's next step is it.
        await press('next');
        await reach('board_start');
    });

    it('Add Start Details: the guide steps aside for the form, and saving picks up the same step', async () => {
        updateHireDetails.mockResolvedValue({
            start_date: null,
            report_location: 'North gate',
            contact_name: null,
            contact_phone: null,
            notes: null,
            updated_at: '2026-10-25T15:00:00Z',
        });
        renderWithGuide(<Board item={{ ...row, application_status: 'hired', hire_details_needed: true }} />, { id: 'employer_applicants' });
        await walkTo('board_row', 'board_start');

        click(message('employer_applicants.hire_details.add'));
        await flush();
        const form = screen.getByRole('dialog', { name: named(message('employer_applicants.hire_details.title'), NAME) });
        expect(currentStep()).toBeNull();
        act(() => {
            fireEvent.change(screen.getByLabelText(message('employer_applicants.hire_details.report_location')), {
                target: { value: 'North gate' },
            });
        });
        click(message('employer_applicants.hire_details.save'));
        await flush();
        await flush();
        expect(updateHireDetails).toHaveBeenCalledTimes(1);
        expect(form.isConnected).toBe(false);
        await reach('board_start');
        expect(locks()).toEqual({ body: '', page: 'hidden' });
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
    worker_name: NAME,
    status: 'open',
    last_message_at: null,
    last_worker_message_at: null,
    last_message_preview: null,
    updated_at: '2026-09-01T00:00:00Z',
};
const messages = [
    { id: 'm1', sender_type: 'employer', body: 'Can you start Monday?', status: 'waiting_worker_reply', created_at: '2026-09-01T00:00:00Z' },
] as never;

/** The thread as the Conversations page shows it: Not interested asks first, in the page's own dialog. */
function ConversationsPane({ onConfirmDismiss, onClose }: { onConfirmDismiss: () => void; onClose: () => Promise<void> }) {
    const [asking, setAsking] = useState(false);
    return (
        <main>
            <ConversationThread conversation={conversation} messages={messages} onSend={vi.fn()} onClose={onClose} onDismiss={() => setAsking(true)} />
            <Modal
                open={asking}
                onClose={() => setAsking(false)}
                title={message('employer_messages.dismiss_confirm_title')}
                size="sm"
                footer={
                    <>
                        <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
                            {message('employer_messages.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => {
                                setAsking(false);
                                onConfirmDismiss();
                            }}
                        >
                            {message('employer_messages.not_interested')}
                        </Button>
                    </>
                }
            >
                <p>{message('employer_messages.dismiss_confirm_title')}</p>
            </Modal>
        </main>
    );
}

describe('the messages guide over the thread’s own dialogs', () => {
    it('Close asks first: Cancel picks up the Close step again, and so does closing it', async () => {
        const onClose = vi.fn(async () => {});
        renderWithGuide(<ConversationsPane onClose={onClose} onConfirmDismiss={vi.fn()} />, { id: 'employer_messages' });
        await walkTo('thread', 'close');

        click(message('employer_messages.close'));
        await flush();
        expect(screen.getByRole('dialog', { name: message('employer_messages.close_confirm_title') })).toBeInTheDocument();
        expect(currentStep()).toBeNull();
        click(message('employer_messages.cancel'));
        await reach('close');
        expect(onClose).not.toHaveBeenCalled();

        click(message('employer_messages.close'));
        await flush();
        click(message('employer_messages.close_confirm_cta'));
        await flush();
        expect(onClose).toHaveBeenCalledTimes(1);
        await reach('close');
        expect(locks()).toEqual({ body: '', page: 'hidden' });
    });

    it('Not interested asks first: Cancel picks up the same step', async () => {
        const onConfirmDismiss = vi.fn();
        renderWithGuide(<ConversationsPane onClose={vi.fn(async () => {})} onConfirmDismiss={onConfirmDismiss} />, { id: 'employer_messages' });
        await walkTo('thread', 'not_interested');

        click(message('employer_messages.not_interested'));
        await flush();
        expect(screen.getByRole('dialog', { name: message('employer_messages.dismiss_confirm_title') })).toBeInTheDocument();
        expect(currentStep()).toBeNull();
        click(message('employer_messages.cancel'));
        await reach('not_interested');
        expect(onConfirmDismiss).not.toHaveBeenCalled();
        expect(locks()).toEqual({ body: '', page: 'hidden' });
    });
});
