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

import { EmptyThreadComposer } from '../EmptyThreadComposer';
import type { InboxItem } from '@/lib/api/employer';

const item: InboxItem = {
  application_id: 'app-1',
  worker_id: 'w-1',
  worker_name: 'Maria Garcia',
  job_id: 'j-1',
  job_title: 'Line Cook',
  job_city: 'Austin',
  job_state_region: 'TX',
  job_status: 'active',
  application_status: 'pending',
  applied_at: '2026-08-30T00:00:00Z',
  conversation_id: null,
  conversation_status: null,
  last_message_at: null,
  last_worker_message_at: null,
  last_message_preview: null,
  tab: 'active',
};

const composer = () =>
  screen.getByPlaceholderText(message('employer_messages.composer_placeholder')) as HTMLTextAreaElement;

describe('EmptyThreadComposer', () => {
  it('sends the first message on Enter', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<EmptyThreadComposer item={item} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'Hi Maria' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Hi Maria'));
  });

  it('does not send on Shift+Enter', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<EmptyThreadComposer item={item} onSend={onSend} />);
    fireEvent.change(composer(), { target: { value: 'Hi Maria' } });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the send button active when the box is empty, and clicking it focuses the box', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderIntl(<EmptyThreadComposer item={item} onSend={onSend} />);
    const send = screen.getByRole('button', { name: message('employer_messages.send') });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
    expect(composer()).toHaveFocus();
  });

  // Same prominence change as ConversationThread's composer -- the two send
  // controls must not read differently for the same action.
  it('renders send as the primary CTA at the large size', () => {
    renderIntl(<EmptyThreadComposer item={item} onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: message('employer_messages.send') });
    expect(send.className).toContain('h-12');
    expect(send.className).toContain('--jale-blue-500');
  });
});
