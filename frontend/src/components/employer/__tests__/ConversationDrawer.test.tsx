// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
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
  loading?: boolean;
  errorKind?: string | null;
};
vi.mock('@/contexts/UnreadMessagesContext', () => ({
  useUnreadMessages: () => ({
    ...unreadState,
    loading: unreadState.loading ?? false,
    errorKind: unreadState.errorKind ?? null,
    retry: vi.fn(),
    refresh: refreshInbox,
    markRead,
  }),
  useUnreadCount: () => unreadState.unreadCount,
}));

/*
 * The messages tutorial (E4) as a recording handle. In 'pass' mode it opens
 * the host at once, as the real hook does when a tutorial does not play; in
 * 'hold' mode it keeps the host waiting, as a playing tutorial does, until the
 * test lets it through.
 */
const tutorial = vi.hoisted(() => {
  const state = {
    mode: 'pass' as 'pass' | 'hold',
    held: [] as (() => void)[],
    latestDone: {} as Record<string, boolean | undefined>,
    ids: new Set<string>(),
  };
  const handle = {
    maybeAutoOpen: vi.fn(),
    runBeforeHost: vi.fn((openHost: () => void) => {
      if (state.mode === 'hold') state.held.push(openHost);
      else openHost();
    }),
    replay: vi.fn(),
  };
  return { state, handle };
});
vi.mock('@/lib/tutorials/use-tutorial', () => ({
  useTutorial: (id: string, options: { done: boolean | undefined }) => {
    tutorial.state.ids.add(id);
    tutorial.state.latestDone[id] = options.done;
    return tutorial.handle;
  },
}));

/** What the drawer last told the overlay coordinator about itself. */
const overlay = vi.hoisted(() => ({ calls: [] as boolean[] }));
vi.mock('@/lib/tutorials/overlay', () => ({
  useOverlayPresence: (open: boolean) => {
    overlay.calls.push(open);
  },
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
  tutorial.handle.runBeforeHost.mockClear();
  tutorial.state.mode = 'pass';
  tutorial.state.held.length = 0;
  tutorial.state.ids.clear();
  for (const id of Object.keys(tutorial.state.latestDone)) delete tutorial.state.latestDone[id];
  overlay.calls.length = 0;
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

    expect(await screen.findByRole('heading', { level: 2, name: 'Ana Lopez' })).toBeInTheDocument();
    // Once in the list row, once in the composer header.
    expect(screen.getAllByText(/Concrete Finisher · Dallas/)).toHaveLength(2);
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
    await screen.findByRole('heading', { level: 2, name: 'Ana Lopez' });

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

// ---------------------------------------------------------------------------
// Round-2 review: `startedThreads` is keyed by application, so a thread
// started here survived the applicant leaving the inbox -- the drawer kept a
// transcript and a live composer pointed at somebody who had been dismissed.
// The board has guarded against exactly this since it shipped.
// ---------------------------------------------------------------------------

describe('an applicant who leaves the inbox', () => {
  it('is dropped, rather than left on screen as a live transcript', async () => {
    const user = userEvent.setup();
    // Picked from the drawer's OWN list, so nothing is describing this
    // applicant except the inbox row itself.
    const { rerender } = renderDrawer();
    await user.click(screen.getByRole('button', {
      name: new RegExp(message('employer_messages.drawer_button')),
    }));
    await user.click(screen.getByText('Maria Garcia'));
    await screen.findAllByText('I can start Monday');

    // Dismissed elsewhere: the next inbox read simply does not carry them.
    unreadState = { items: [neverMessaged], unreadCount: 0, unreadByConversation: {} };
    rerender(<ConversationDrawerProvider>{null}</ConversationDrawerProvider>);

    await waitFor(() =>
      expect(screen.getByText(message('employer_messages.empty_select'))).toBeInTheDocument(),
    );
    expect(screen.queryByText('I can start Monday')).not.toBeInTheDocument();
  });

  it('keeps an applicant the inbox never listed but the caller described', async () => {
    const user = userEvent.setup();
    // T8: the applicants board lists a never-messaged applicant of a paused
    // job, which the inbox does not carry. Absent from `items` is that
    // applicant's NORMAL state, not evidence that they are gone.
    renderDrawer(
      <OpenerPage
        target={{
          application_id: 'app-paused',
          worker_id: 'w-7',
          job_id: 'job-paused',
          worker_name: 'Ana Flores',
          job_title: 'Framer',
          job_city: 'El Paso',
          applied_at: '2026-09-12T00:00:00Z',
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Ana Flores' })).toBeInTheDocument();
    expect(screen.queryByText(message('employer_messages.empty_select'))).not.toBeInTheDocument();
  });
});

describe('the drawer list row', () => {
  it('says "unread" in words, not only in weight and colour', async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByRole('button', {
      name: new RegExp(message('employer_messages.drawer_button')),
    }));

    const row = screen.getByText('Maria Garcia').closest('button');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(message('employer_messages.unread'))).toBeInTheDocument();
  });

  it('says nothing for a thread that has been read', async () => {
    const user = userEvent.setup();
    unreadState = {
      items: [{ ...messaged, unread: false }],
      unreadCount: 0,
      unreadByConversation: { 'conv-1': false },
    };
    renderDrawer();

    await user.click(screen.getByRole('button', {
      name: new RegExp(message('employer_messages.drawer_button')),
    }));

    const row = screen.getByText('Maria Garcia').closest('button');
    expect(within(row as HTMLElement).queryByText(message('employer_messages.unread'))).not.toBeInTheDocument();
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

/*
 * Item 6. The drawer held ONE description -- the latest request -- so an
 * applicant the inbox does not list was forgotten the moment another one was
 * opened: no list row, and the vanish guard dropped them. Every described
 * applicant now keeps a "New conversation" row until the inbox lists them
 * with a thread.
 */
describe('several applicants the inbox does not list', () => {
  const describedA: ConversationTarget = {
    application_id: 'app-off-a',
    worker_id: 'w-a',
    job_id: 'job-paused',
    worker_name: 'Ana Prueba',
    job_title: 'Concrete Finisher',
    job_city: 'Dallas',
    applied_at: '2026-09-02T00:00:00Z',
  };
  const describedB: ConversationTarget = {
    application_id: 'app-off-b',
    worker_id: 'w-b',
    job_id: 'job-closed',
    worker_name: 'Beto Prueba',
    job_title: 'Framer',
    job_city: 'El Paso',
    applied_at: '2026-09-03T00:00:00Z',
  };

  function TwoOpeners() {
    const { openConversation } = useConversationDrawer();
    return (
      <>
        <button type="button" onClick={() => openConversation(describedA)}>open first</button>
        <button type="button" onClick={() => openConversation(describedB)}>open second</button>
      </>
    );
  }

  it('keeps the first applicant reachable after a second one is opened', async () => {
    const user = userEvent.setup();
    renderDrawer(<TwoOpeners />);

    await user.click(screen.getByRole('button', { name: 'open first' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ana Prueba' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'open second' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Beto Prueba' })).toBeInTheDocument();

    // A is still listed, and choosing the row draws A's composer again.
    await user.click(screen.getByRole('button', { name: /Ana Prueba/ }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Ana Prueba' })).toBeInTheDocument();
    expect(screen.queryByText(message('employer_messages.candidate_unavailable'))).not.toBeInTheDocument();
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('labels a described applicant with no thread "New conversation"', async () => {
    const user = userEvent.setup();
    renderDrawer(<TwoOpeners />);
    await user.click(screen.getByRole('button', { name: 'open first' }));
    await user.click(screen.getByRole('button', { name: 'open second' }));

    const rowA = screen.getByRole('button', { name: /Ana Prueba/ });
    expect(within(rowA).getByText(message('employer_messages.drawer_new_conversation'))).toBeInTheDocument();
  });

  it('drops the "New conversation" row once the inbox lists that applicant with a thread', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDrawer(<TwoOpeners />);
    await user.click(screen.getByRole('button', { name: 'open first' }));
    await user.click(screen.getByRole('button', { name: 'open second' }));

    unreadState = {
      items: [
        messaged,
        inboxItem({
          application_id: 'app-off-a',
          worker_id: 'w-a',
          worker_name: 'Ana Prueba',
          job_title: 'Concrete Finisher',
          job_city: 'Dallas',
          conversation_id: 'conv-a',
          conversation_status: 'open',
          last_message_at: '2026-09-16T11:00:00Z',
          last_message_preview: 'See you Monday',
        }),
      ],
      unreadCount: 1,
      unreadByConversation: { 'conv-1': true },
    };
    rerender(<ConversationDrawerProvider><TwoOpeners /></ConversationDrawerProvider>);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Ana Prueba/ })).toHaveLength(1));
    const rowA = screen.getByRole('button', { name: /Ana Prueba/ });
    expect(within(rowA).queryByText(message('employer_messages.drawer_new_conversation'))).not.toBeInTheDocument();
    expect(within(rowA).getByText('See you Monday')).toBeInTheDocument();
  });
});

/*
 * E4 (sprint 29): the messages tutorial plays before the drawer opens, for an
 * employer with no conversation yet (K1.5).
 */
describe('the messages tutorial', () => {
  const launcher = () =>
    screen.getByRole('button', { name: new RegExp(`${message('employer_messages.drawer_button')}|${message('employer_messages.drawer_close')}`) });

  it('passes done from the inbox: unknown while it loads, true once a thread exists', () => {
    unreadState = { items: [neverMessaged], unreadCount: 0, unreadByConversation: {}, loading: true };
    const { rerender } = renderDrawer();
    expect(tutorial.state.ids.has('employer_messages')).toBe(true);
    expect(tutorial.state.latestDone.employer_messages).toBeUndefined();

    unreadState = { items: [neverMessaged], unreadCount: 0, unreadByConversation: {} };
    rerender(<ConversationDrawerProvider>{null}</ConversationDrawerProvider>);
    expect(tutorial.state.latestDone.employer_messages).toBe(false);

    unreadState = { items: [messaged, neverMessaged], unreadCount: 1, unreadByConversation: {} };
    rerender(<ConversationDrawerProvider>{null}</ConversationDrawerProvider>);
    expect(tutorial.state.latestDone.employer_messages).toBe(true);
  });

  it('holds a requested drawer until the tutorial lets it through', async () => {
    tutorial.state.mode = 'hold';
    const user = userEvent.setup();
    renderDrawer(<OpenerPage target={{ application_id: 'app-1', worker_id: 'w-1', job_id: 'job-1' }} />);

    await user.click(screen.getByRole('button', { name: 'open thread' }));

    expect(tutorial.handle.runBeforeHost).toHaveBeenCalledTimes(1);
    expect(launcher()).toHaveAttribute('aria-expanded', 'false');

    act(() => tutorial.state.held[0]());

    expect(launcher()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(getConversation).toHaveBeenCalledWith('test-token', 'conv-1', expect.anything()));
    await waitFor(() => expect(screen.getAllByText('I can start Monday')).toHaveLength(2));
  });

  it('asks before the launcher opens the drawer, and not when it closes it', async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(launcher());
    expect(tutorial.handle.runBeforeHost).toHaveBeenCalledTimes(1);
    expect(launcher()).toHaveAttribute('aria-expanded', 'true');

    await user.click(launcher());
    expect(tutorial.handle.runBeforeHost).toHaveBeenCalledTimes(1);
    expect(launcher()).toHaveAttribute('aria-expanded', 'false');
  });
});

/*
 * The drawer is not a Modal or a Sheet, so it reports its own open state to
 * the overlay coordinator (sprint 29): no tutorial auto-opens on top of it.
 */
describe('overlay presence', () => {
  it('tells the overlay coordinator whether the drawer is open', async () => {
    const user = userEvent.setup();
    renderDrawer();
    const toggle = () =>
      screen.getByRole('button', { name: new RegExp(`${message('employer_messages.drawer_button')}|${message('employer_messages.drawer_close')}`) });
    expect(overlay.calls.at(-1)).toBe(false);

    await user.click(toggle());
    expect(overlay.calls.at(-1)).toBe(true);

    await user.click(toggle());
    expect(overlay.calls.at(-1)).toBe(false);
  });
});
