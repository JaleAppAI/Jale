// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The floating drawer, after it stopped fetching its own list.
 *
 * Sprint 26 (B3/B4). Two behaviours are new and each replaces something that
 * could not work:
 *
 *  - the launcher printed a fixed WhatsApp-green dot, identical whether three
 *    workers were waiting on an answer or none were. It now prints the count;
 *  - `openConversation` arrives from the applicants board with an APPLICATION
 *    id and no conversation id, because a row on that board has none. The
 *    drawer resolves it against the inbox: an existing thread opens, and an
 *    applicant who has never been messaged lands on the first-message
 *    composer -- which the old `/employer/conversations` list could not even
 *    see.
 *
 * And the receipt: opening a thread marks it read ONCE, not once per poll.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  usePathname: () => '/employer/applicants',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token', isAuthenticated: true, userType: 'employer' }),
}));

vi.mock('@/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({
    handleLegalWall: (err: unknown) => {
      throw err;
    },
    idToken: 'test-token',
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const getConversation = vi.fn();
const startConversation = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  getConversation: (...args: unknown[]) => getConversation(...args),
  startConversation: (...args: unknown[]) => startConversation(...args),
  sendConversationMessage: vi.fn(),
  closeConversation: vi.fn(),
}));

const markRead = vi.fn();
const refreshInbox = vi.fn();
let unreadState: {
  items: import('@/lib/api/employer').InboxItem[];
  unreadCount: number;
  unreadByConversation: Record<string, boolean>;
};
vi.mock('@/contexts/UnreadMessagesContext', () => ({
  useUnreadMessages: () => ({
    ...unreadState,
    loading: false,
    errorKind: null,
    retry: vi.fn(),
    refresh: refreshInbox,
    markRead,
  }),
  useUnreadCount: () => unreadState.unreadCount,
}));

// Below the mocks (they hoist).
import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import {
  ConversationDrawerProvider,
  useConversationDrawer,
} from '@/contexts/ConversationDrawerContext';
import type { ConversationTarget } from '@/contexts/ConversationDrawerContext';
import type { InboxItem } from '@/lib/api/employer';

function inboxItem(overrides: Partial<InboxItem> & { application_id: string }): InboxItem {
  return {
    worker_id: 'w-1',
    worker_name: 'Maria Garcia',
    job_id: 'job-1',
    job_title: 'Line Cook',
    job_city: 'Austin',
    job_state_region: 'TX',
    job_status: 'active',
    application_status: 'contacted',
    applied_at: '2026-09-10T00:00:00Z',
    conversation_id: null,
    conversation_status: null,
    last_message_at: null,
    last_worker_message_at: null,
    last_message_preview: null,
    tab: 'active',
    unread: false,
    ...overrides,
  };
}

const messaged = inboxItem({
  application_id: 'app-1',
  conversation_id: 'conv-1',
  conversation_status: 'open',
  last_message_at: '2026-09-16T10:00:00Z',
  last_worker_message_at: '2026-09-16T10:00:00Z',
  last_message_preview: 'I can start Monday',
  unread: true,
});

const neverMessaged = inboxItem({
  application_id: 'app-2',
  worker_id: 'w-2',
  worker_name: 'Jose Ruiz',
  application_status: 'pending',
});

/** A page that does nothing but ask the drawer to open one applicant. */
function OpenerPage({ target }: { target: ConversationTarget }) {
  const { openConversation } = useConversationDrawer();
  return (
    <button type="button" onClick={() => openConversation(target)}>open thread</button>
  );
}

function renderDrawer(children: ReactNode = null) {
  return renderIntl(<ConversationDrawerProvider>{children}</ConversationDrawerProvider>);
}

afterEach(() => {
  // Unconditional: `useRealTimers` is a no-op when no fake clock is installed,
  // and the one test that installs one must not be able to leak it.
  vi.useRealTimers();
});

beforeEach(() => {
  markRead.mockReset();
  // The context reports whether the stamp landed; a receipt that is refused is
  // retried (see `useThreadReadReceipt`), so the stub has to answer.
  markRead.mockResolvedValue(true);
  refreshInbox.mockReset();
  getConversation.mockReset();
  startConversation.mockReset();
  unreadState = {
    items: [messaged, neverMessaged],
    unreadCount: 2,
    unreadByConversation: { 'conv-1': true },
  };
  getConversation.mockResolvedValue({
    conversation: {
      id: 'conv-1',
      job_id: 'job-1',
      job_title: 'Line Cook',
      job_city: 'Austin',
      job_state_region: 'TX',
      worker_id: 'w-1',
      worker_name: 'Maria Garcia',
      status: 'open',
      last_message_at: '2026-09-16T10:00:00Z',
      last_worker_message_at: '2026-09-16T10:00:00Z',
      last_message_preview: 'I can start Monday',
    },
    messages: [
      {
        id: 'm-1',
        sender_type: 'worker',
        direction: 'inbound',
        body: 'I can start Monday',
        status: 'received',
        created_at: '2026-09-16T10:00:00Z',
        sent_at: '2026-09-16T10:00:00Z',
      },
    ],
  });
});

describe('the drawer launcher', () => {
  it('prints the unread count instead of a decorative dot', () => {
    renderDrawer();

    expect(screen.getByRole('button', { name: new RegExp(message('employer_messages.drawer_button')) })
      .textContent).toContain('2');
  });

  it('prints no number when nothing is waiting', () => {
    unreadState = { items: [], unreadCount: 0, unreadByConversation: {} };
    renderDrawer();

    const launcher = screen.getByRole('button', {
      name: new RegExp(message('employer_messages.drawer_button')),
    });
    expect(launcher.textContent).not.toMatch(/\d/);
  });
});

describe('openConversation', () => {
  it('opens the applicant’s existing thread', async () => {
    const user = userEvent.setup();
    renderDrawer(<OpenerPage target={{ application_id: 'app-1', worker_id: 'w-1', job_id: 'job-1' }} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    await waitFor(() => expect(getConversation).toHaveBeenCalledWith('test-token', 'conv-1', expect.anything()));
    // Twice on screen on purpose: the list row's preview and the transcript
    // bubble itself.
    expect(await screen.findAllByText('I can start Monday')).toHaveLength(2);
    // The inbox is re-read on open: the applicant may have been messaged from
    // another device since the last poll.
    expect(refreshInbox).toHaveBeenCalled();
  });

  it('lands an applicant with no thread on the first-message composer', async () => {
    const user = userEvent.setup();
    renderDrawer(<OpenerPage target={{ application_id: 'app-2', worker_id: 'w-2', job_id: 'job-1' }} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    // `EmptyThreadComposer`'s header: the applicant, marked as one nobody has
    // written to yet. No conversation is fetched, because there is none.
    expect(await screen.findByText('Jose Ruiz')).toBeInTheDocument();
    expect(screen.getByText(message('employer_messages.new_applicant'))).toBeInTheDocument();
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('starts the conversation from that composer', async () => {
    const user = userEvent.setup();
    startConversation.mockResolvedValue({
      conversation: { id: 'conv-9', status: 'open' },
      messages: [],
    });
    renderDrawer(<OpenerPage target={{ application_id: 'app-2', worker_id: 'w-2', job_id: 'job-1' }} />);
    await user.click(screen.getByRole('button', { name: 'open thread' }));
    await screen.findByText('Jose Ruiz');

    await user.type(
      screen.getByPlaceholderText(message('employer_messages.composer_placeholder')),
      'Are you available Monday?',
    );
    await user.click(screen.getByRole('button', { name: message('employer_messages.send') }));

    await waitFor(() => expect(startConversation).toHaveBeenCalledWith('test-token', {
      job_id: 'job-1',
      worker_id: 'w-2',
      initial_message: 'Are you available Monday?',
    }));
  });

  it('says so when the applicant is not in the inbox and the caller sent no name', async () => {
    const user = userEvent.setup();
    renderDrawer(<OpenerPage target={{ application_id: 'gone', worker_id: 'w-9', job_id: 'job-9' }} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    expect(await screen.findByText(message('employer_messages.candidate_unavailable'))).toBeInTheDocument();
  });
});

/*
 * The applicants board lists applicants of paused, filled and closed jobs; the
 * inbox lists a never-messaged applicant only while their job is active (and
 * stops at 200 rows either way). Every such row used to open on "This candidate
 * is no longer available" -- while `POST /employer/conversations` would have
 * accepted the message. The row now hands over what it already shows, and the
 * composer is drawn from that.
 */
describe('an applicant the inbox does not list', () => {
  const offBoard: ConversationTarget = {
    application_id: 'app-paused',
    worker_id: 'w-7',
    job_id: 'job-paused',
    worker_name: 'Ana Lopez',
    job_title: 'Concrete Finisher',
    job_city: 'Dallas',
    applied_at: '2026-09-02T00:00:00Z',
  };

  it('opens the first-message composer from the fields the caller passed', async () => {
    const user = userEvent.setup();
    renderDrawer(<OpenerPage target={offBoard} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText(/Concrete Finisher · Dallas/)).toBeInTheDocument();
    expect(screen.getByText(message('employer_messages.new_applicant'))).toBeInTheDocument();
    expect(screen.queryByText(message('employer_messages.candidate_unavailable'))).not.toBeInTheDocument();
    // There is no thread to fetch, and no inbox row to fetch one from.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('starts the conversation from it and lands on the thread it just created', async () => {
    const user = userEvent.setup();
    startConversation.mockResolvedValue({
      conversation: { id: 'conv-7', status: 'open' },
      messages: [],
    });
    renderDrawer(<OpenerPage target={offBoard} />);
    await user.click(screen.getByRole('button', { name: 'open thread' }));
    await screen.findByText('Ana Lopez');

    await user.type(
      screen.getByPlaceholderText(message('employer_messages.composer_placeholder')),
      'Still hiring for this one?',
    );
    await user.click(screen.getByRole('button', { name: message('employer_messages.send') }));

    // The ids come from the target, not from an inbox row that does not exist.
    await waitFor(() => expect(startConversation).toHaveBeenCalledWith('test-token', {
      job_id: 'job-paused',
      worker_id: 'w-7',
      initial_message: 'Still hiring for this one?',
    }));
    // And the drawer moves onto the new thread without waiting for the inbox
    // poll that will eventually carry it.
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith('test-token', 'conv-7', expect.anything()));
    expect(refreshInbox).toHaveBeenCalled();
  });
});

describe('the read receipt', () => {
  it('marks a thread read once per open, not once per poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDrawer(<OpenerPage target={{ application_id: 'app-1', worker_id: 'w-1', job_id: 'job-1' }} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('conv-1'));
    expect(markRead).toHaveBeenCalledTimes(1);

    // Two thread polls later: still one receipt. A POST per tick would be a
    // write loop for as long as the drawer stays open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(markRead).toHaveBeenCalledTimes(1);
    // The clock is restored in `afterEach`, not here: a failing assertion
    // above would otherwise leave fake timers installed for every suite that
    // ran after it in this file.
  });

  it('marks again when the worker writes while the thread is on screen', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDrawer(
      <OpenerPage target={{ application_id: 'app-1', worker_id: 'w-1', job_id: 'job-1' }} />,
    );
    await user.click(screen.getByRole('button', { name: 'open thread' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));

    // What the next inbox poll would publish: a newer worker message.
    unreadState = {
      ...unreadState,
      items: [{ ...messaged, last_worker_message_at: '2026-09-16T11:30:00Z' }, neverMessaged],
    };
    rerender(
      <ConversationDrawerProvider>
        <OpenerPage target={{ application_id: 'app-1', worker_id: 'w-1', job_id: 'job-1' }} />
      </ConversationDrawerProvider>,
    );

    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
  });

  it('marks nothing while the drawer is shut', async () => {
    renderDrawer();

    await act(async () => {
      await Promise.resolve();
    });
    expect(markRead).not.toHaveBeenCalled();
  });
});
