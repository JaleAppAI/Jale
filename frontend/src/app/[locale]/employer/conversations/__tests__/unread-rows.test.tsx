// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/*
 * The Messages board's inbox rows, and which of them are waiting on a reply.
 *
 * Sprint 26 (B3) shipped the badge before this: an employer could see "3" on
 * the nav item, land here, and then have no way to tell WHICH three of a long
 * list to open. The rows carried `unread` from the API all along and rendered
 * nothing with it.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  usePathname: () => '/employer/conversations',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ idToken: 'test-token', isAuthenticated: true, userType: 'employer' }),
}));

// The real `usePageData` runs (both of the page's lifecycles depend on its
// fencing); only its auth gate is resolved here.
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

// `actions` deliberately dropped: the real slot holds `PostJobButton`, whose
// context this suite has nothing to do with.
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const markRead = vi.fn();
vi.mock('@/contexts/UnreadMessagesContext', () => ({
  useUnreadMessages: () => ({
    items: [],
    unreadCount: 0,
    unreadByConversation: {},
    loading: false,
    errorKind: null,
    retry: vi.fn(),
    refresh: vi.fn(),
    markRead,
  }),
  useUnreadCount: () => 0,
}));

const getInbox = vi.fn();
const getConversation = vi.fn();
vi.mock('@/lib/api/employer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/employer')>()),
  getInbox: (...args: unknown[]) => getInbox(...args),
  getConversation: (...args: unknown[]) => getConversation(...args),
  sendConversationMessage: vi.fn(),
  startConversation: vi.fn(),
  closeConversation: vi.fn(),
  updateApplicantStatus: vi.fn(),
}));

// Below the mocks (they hoist).
import { message, renderIntl } from '@/components/employer/__tests__/render-intl';
import EmployerConversationsPage from '../page';
import type { EmployerInboxResponse, InboxItem } from '@/lib/api/employer';

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

const unreadItem = inboxItem({
  application_id: 'app-1',
  conversation_id: 'conv-1',
  conversation_status: 'open',
  last_message_at: '2026-09-16T10:00:00Z',
  last_worker_message_at: '2026-09-16T10:00:00Z',
  last_message_preview: 'I can start Monday',
  unread: true,
});

const readItem = inboxItem({
  application_id: 'app-2',
  worker_id: 'w-2',
  worker_name: 'Jose Ruiz',
  conversation_id: 'conv-2',
  conversation_status: 'open',
  last_message_at: '2026-09-15T10:00:00Z',
  last_worker_message_at: '2026-09-15T10:00:00Z',
  last_message_preview: 'Thanks',
});

const inbox: EmployerInboxResponse = {
  items: [unreadItem, readItem],
  jobs: [{ job_id: 'job-1', title: 'Line Cook', city: 'Austin', status: 'active' }],
  unread_count: 1,
};

/** The list row for one worker, found by the name it prints. */
function rowFor(name: string): HTMLElement {
  const label = screen.getAllByText(name)[0];
  const row = label.closest('button');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

const UNREAD = () => message('employer_messages.unread');

beforeEach(() => {
  markRead.mockReset();
  markRead.mockResolvedValue(true);
  getInbox.mockReset();
  getConversation.mockReset();
  getInbox.mockResolvedValue(inbox);
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
    messages: [],
  });
});

describe('unread rows on the Messages board', () => {
  it('marks the row the worker is waiting on, and says so in words', async () => {
    renderIntl(<EmployerConversationsPage />);

    await waitFor(() => expect(rowFor('Maria Garcia')).toBeInTheDocument());
    // Not colour alone: the marker carries text for a screen reader, and the
    // employer arriving from a "3" badge needs to see which three these are.
    expect(within(rowFor('Maria Garcia')).getByText(UNREAD())).toBeInTheDocument();
  });

  it('leaves an answered row unmarked', async () => {
    renderIntl(<EmployerConversationsPage />);

    await waitFor(() => expect(rowFor('Jose Ruiz')).toBeInTheDocument());
    expect(within(rowFor('Jose Ruiz')).queryByText(UNREAD())).not.toBeInTheDocument();
  });

  it('clears the marker as the thread opens, without waiting for a refetch', async () => {
    const user = userEvent.setup();
    renderIntl(<EmployerConversationsPage />);
    await waitFor(() => expect(rowFor('Maria Garcia')).toBeInTheDocument());

    await user.click(rowFor('Maria Garcia'));

    // The row stops looking unread in the same frame the thread opens; the
    // inbox is NOT re-read to find that out.
    await waitFor(() =>
      expect(within(rowFor('Maria Garcia')).queryByText(UNREAD())).not.toBeInTheDocument(),
    );
    expect(getInbox).toHaveBeenCalledTimes(1);
    // The server-side receipt is the shared hook's job, and it still fires.
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('conv-1'));
  });

  it('does not clear any other row', async () => {
    const user = userEvent.setup();
    getInbox.mockResolvedValue({
      ...inbox,
      items: [unreadItem, { ...readItem, unread: true }],
      unread_count: 2,
    });
    renderIntl(<EmployerConversationsPage />);
    await waitFor(() => expect(rowFor('Maria Garcia')).toBeInTheDocument());

    await user.click(rowFor('Maria Garcia'));

    await waitFor(() =>
      expect(within(rowFor('Maria Garcia')).queryByText(UNREAD())).not.toBeInTheDocument(),
    );
    expect(within(rowFor('Jose Ruiz')).getByText(UNREAD())).toBeInTheDocument();
  });
});
