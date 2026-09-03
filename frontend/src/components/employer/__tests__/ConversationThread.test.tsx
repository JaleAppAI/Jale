// @vitest-environment jsdom
import * as React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { message, renderIntl } from './render-intl';

// The real `Link` (pulled in transitively through `EmptyState`) reaches
// `next/navigation`, which has no resolvable entry under vitest -- the same
// mock the auth-form suites and `DetailsRequestedBanner.test.tsx` already use.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { ConversationThread } from '../ConversationThread';
import type { EmployerConversationDetail } from '@/lib/api/employer';

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

const composer = () =>
  screen.getByPlaceholderText(message('employer_messages.composer_placeholder')) as HTMLTextAreaElement;

describe('ConversationThread header', () => {
  it('shows the job title and its location in the header', () => {
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={vi.fn()} />);
    expect(screen.getByText('Line Cook')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX')).toBeInTheDocument();
  });
});

describe('ConversationThread composer', () => {
  it('sends on Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'Hello' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hello'));
  });

  it('does not send on Shift+Enter (newline instead)', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'Hello' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send mid-IME-composition', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'Hola' } });
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send on Enter when the box is empty', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={onSend} />);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the send button active when the box is empty, and clicking it focuses the box', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<ConversationThread conversation={conversation} messages={[]} onSend={onSend} />);
    const send = screen.getByRole('button', { name: message('employer_messages.send') });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
    expect(composer()).toHaveFocus();
  });
});
